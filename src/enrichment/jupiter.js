import axios from 'axios';
import { WSOL_MINT, JSON_HEADERS, JUPITER_API_KEY, JUPITER_SWAP_BASE_URL } from '../config.js';
import { now, sleep } from '../utils.js';

const jupiterAssetCache = new Map();

// ---- Jupiter HTTP client -------------------------------------------------------
// Free plan: ONE shared bucket (1 RPS / 60 RPM sliding 60s) covers /order, /quote,
// /price/v3 and /tokens/v2; /execute has its own 50 RPS bucket; datapi.jup.ag is
// undocumented so it gets its own best-effort bucket that backs off on 429/403 and
// lets callers fall back to GMGN. A 429 has no lockout: wait for x-ratelimit-reset.
// One queue per bucket, always dispatching the highest-priority waiter first.
const PRIORITY = { exit_live: 0, exit_paper: 1, entry: 2, enrich: 3 };
const ENRICH_DEADLINE_MS = 20_000;
const WINDOW_MS = 60_000;
const DATAPI_BACKOFF_MS = 30_000;
const envNum = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const realClock = { now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
let clock = realClock;
let buckets = newBuckets();

function newBucket(gapMs, perWindow) {
  return { gapMs, perWindow, queue: [], pumping: false, nextAt: 0, blockedUntil: 0, stamps: [], count429: 0, seq: 0 };
}

function newBuckets() {
  return {
    main: newBucket(1000 / envNum('JUP_MAIN_RPS', 1), envNum('JUP_MAIN_RPM', 60)),
    execute: newBucket(0, Infinity),
    datapi: newBucket(1000 / envNum('JUP_DATAPI_RPS', 2), Infinity),
  };
}

// Test hooks: inject a fake clock ({ now, sleep }) and/or reset all limiter state.
export function _setClock(next) { clock = next || realClock; }
export function _resetJupiterClient() { clock = realClock; buckets = newBuckets(); }

function resetHeaderMs(headers) {
  const reset = Number(headers?.['x-ratelimit-reset']);
  if (!Number.isFinite(reset) || reset <= 0) return 0;
  return reset > 1_000_000_000_000 ? reset : reset * 1000;
}

function noteResponse(name, bucket, headers, status) {
  const resetMs = resetHeaderMs(headers);
  const remaining = Number(headers?.['x-ratelimit-remaining']);
  if (status === 429) {
    bucket.count429 += 1;
    if (name !== 'datapi') bucket.blockedUntil = Math.max(bucket.blockedUntil, resetMs > clock.now() ? resetMs : clock.now() + 1000);
  } else if (name === 'main' && Number.isFinite(remaining) && remaining <= 0 && resetMs > clock.now()) {
    bucket.blockedUntil = Math.max(bucket.blockedUntil, resetMs);
  }
  if (name === 'datapi' && (status === 429 || status === 403)) {
    const until = resetMs > clock.now() ? resetMs : clock.now() + DATAPI_BACKOFF_MS;
    bucket.blockedUntil = Math.max(bucket.blockedUntil, until);
    console.log(`[datapi] backing off until ${new Date(bucket.blockedUntil).toISOString()} (${status})`);
  }
}

function dispatch(name, bucket, item) {
  const at = clock.now();
  bucket.stamps.push(at);
  if (bucket.stamps.length > 500) bucket.stamps = bucket.stamps.filter(s => at - s < WINDOW_MS);
  const promise = item.run();
  promise.then(
    res => { noteResponse(name, bucket, res?.headers, res?.status || 200); item.resolve(res); },
    err => { noteResponse(name, bucket, err?.response?.headers, err?.response?.status); item.reject(err); },
  );
}

function rejectWith(item, code, message) {
  const err = new Error(message);
  err.code = code;
  item.reject(err);
}

async function pump(name, bucket) {
  if (bucket.pumping) return;
  bucket.pumping = true;
  try {
    while (bucket.queue.length) {
      const t = clock.now();
      bucket.stamps = bucket.stamps.filter(s => t - s < WINDOW_MS);
      for (const item of bucket.queue.filter(q => q.deadlineAt && q.deadlineAt <= t)) {
        bucket.queue.splice(bucket.queue.indexOf(item), 1);
        rejectWith(item, 'JUP_DEADLINE', `jupiter ${name} queue deadline exceeded (${item.priority})`);
      }
      if (!bucket.queue.length) break;
      if (name === 'datapi' && t < bucket.blockedUntil) {
        for (const item of bucket.queue.splice(0)) rejectWith(item, 'JUP_BACKOFF', 'jupiter datapi backoff active');
        break;
      }
      let readyAt = Math.max(bucket.nextAt, bucket.blockedUntil);
      if (bucket.stamps.length >= bucket.perWindow) readyAt = Math.max(readyAt, bucket.stamps[0] + WINDOW_MS);
      if (readyAt > t) {
        // Sleep no longer than the nearest enrich deadline so it can reject on time.
        const deadlines = bucket.queue.map(q => q.deadlineAt).filter(Boolean);
        const wakeAt = Math.min(readyAt, ...deadlines);
        await clock.sleep(Math.max(1, wakeAt - t));
        continue;
      }
      let best = 0;
      for (let i = 1; i < bucket.queue.length; i++) {
        const a = bucket.queue[i];
        const b = bucket.queue[best];
        if (a.rank < b.rank || (a.rank === b.rank && a.seq < b.seq)) best = i;
      }
      const [item] = bucket.queue.splice(best, 1);
      bucket.nextAt = clock.now() + bucket.gapMs;
      dispatch(name, bucket, item);
    }
  } finally {
    bucket.pumping = false;
  }
}

export function jupiterFetch(url, { method = 'GET', body, priority = 'enrich', bucket: bucketName = 'main', timeoutMs = 10_000, deadlineMs } = {}) {
  const bucket = buckets[bucketName];
  if (!bucket) return Promise.reject(new Error(`unknown jupiter bucket ${bucketName}`));
  const headers = { ...JSON_HEADERS };
  if (bucketName !== 'datapi' && JUPITER_API_KEY) headers['x-api-key'] = JUPITER_API_KEY;
  const run = () => (String(method).toUpperCase() === 'POST'
    ? axios.post(url, body, { timeout: timeoutMs, headers: { ...headers, 'content-type': 'application/json' } })
    : axios.get(url, { timeout: timeoutMs, headers }));
  const rank = PRIORITY[priority] ?? PRIORITY.enrich;
  const effectiveDeadline = deadlineMs ?? (priority === 'enrich' && bucketName !== 'execute' ? ENRICH_DEADLINE_MS : null);
  return new Promise((resolve, reject) => {
    const item = { run, resolve, reject, priority, rank, seq: bucket.seq++, deadlineAt: effectiveDeadline ? clock.now() + effectiveDeadline : 0 };
    if (bucketName === 'execute') { dispatch(bucketName, bucket, item); return; }
    bucket.queue.push(item);
    pump(bucketName, bucket);
  });
}

export function jupiterUsageStats() {
  const t = clock.now();
  const out = {};
  for (const [name, bucket] of Object.entries(buckets)) {
    out[name] = {
      requestsLast60s: bucket.stamps.filter(s => t - s < WINDOW_MS).length,
      count429: bucket.count429,
      queued: bucket.queue.length,
    };
  }
  out.datapi.backoffActive = t < buckets.datapi.blockedUntil;
  out.datapi.backoffUntil = buckets.datapi.blockedUntil || null;
  return out;
}

function jupiterAssetBackoffActive() {
  return clock.now() < buckets.datapi.blockedUntil;
}

// Kept for compatibility: manually trip the datapi backoff from a caught error.
function setJupiterAssetBackoff(err) {
  const status = err?.response?.status;
  if (status === 429 || status === 403) noteResponse('datapi', buckets.datapi, err.response.headers, status);
}

const quoteSnapshotCache = new Map();
const QUOTE_SNAPSHOT_MS = 10_000;

let solUsdCache = { price: null, at: 0 };

function jupiterStatsForInterval(row, interval) {
  const key = `stats${interval}`;
  return row?.[key] || row?.stats5m || row?.stats1h || row?.stats24h || {};
}

function normalizeJupiterTrendingRow(row, interval, rank) {
  const stats = jupiterStatsForInterval(row, interval);
  const buyVolume = Number(stats.buyVolume ?? 0);
  const sellVolume = Number(stats.sellVolume ?? 0);
  const numBuys = Number(stats.numBuys ?? 0);
  const numSells = Number(stats.numSells ?? 0);
  const topHolders = Number(row?.audit?.topHoldersPercentage);
  const botHolders = Number(row?.audit?.botHoldersPercentage);
  return {
    ...row,
    address: row?.id,
    price: Number(row?.usdPrice ?? 0),
    volume: buyVolume + sellVolume,
    liquidity: Number(row?.liquidity ?? 0),
    market_cap: Number(row?.mcap ?? row?.fdv ?? 0),
    swaps: numBuys + numSells,
    buys: numBuys,
    sells: numSells,
    holder_count: Number(row?.holderCount ?? 0),
    top_10_holder_rate: Number.isFinite(topHolders) ? topHolders / 100 : null,
    launchpad_platform: row?.launchpad || null,
    launchpad_status: row?.graduatedAt ? '2' : null,
    smart_degen_count: Number(stats.numOrganicBuyers ?? 0),
    hot_level: Number(row?.organicScore ?? 0),
    rug_ratio: null,
    bundler_rate: Number.isFinite(botHolders) ? botHolders / 100 : null,
    source: 'jupiter_toptrending',
    interval,
    rank,
    stats,
  };
}

async function fetchJupiterAsset(mint, { useCache = true, ttlMs = 20_000, priority = 'enrich' } = {}) {
  const cached = jupiterAssetCache.get(mint);
  if (useCache && cached && now() - cached.at < ttlMs) return cached.data;
  if (jupiterAssetBackoffActive()) return useCache ? cached?.data || null : null;
  try {
    const url = new URL('https://datapi.jup.ag/v1/assets/search');
    url.searchParams.set('query', mint);
    const res = await jupiterFetch(url.toString(), { bucket: 'datapi', priority });
    const rows = Array.isArray(res.data) ? res.data : [];
    const data = rows.find(row => row?.id === mint) || null;
    jupiterAssetCache.set(mint, { at: now(), data });
    return data;
  } catch (err) {
    if (err.response?.status !== 429 && err.code !== 'JUP_BACKOFF') console.log(`[asset] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return useCache ? cached?.data || null : null;
  }
}

async function fetchSolUsdPrice() {
  const hosts = JUPITER_API_KEY
    ? ['https://api.jup.ag', 'https://lite-api.jup.ag']
    : ['https://lite-api.jup.ag'];
  for (const host of hosts) {
    try {
      const res = await jupiterFetch(`${host}/price/v3?ids=${WSOL_MINT}`, { priority: 'entry', timeoutMs: 5000 });
      const price = Number(res.data?.[WSOL_MINT]?.usdPrice);
      if (Number.isFinite(price) && price > 0) return price;
    } catch (err) {
      console.log(`[sol-price] ${host} ${err.response?.status || ''} ${err.message}`);
    }
  }
  return null;
}

async function estimateTokenAmountFromSol(sizeSol, entryPrice) {
  if (!Number.isFinite(Number(entryPrice)) || Number(entryPrice) <= 0) return null;
  const solUsd = await fetchSolUsdPrice();
  if (!Number.isFinite(Number(solUsd)) || Number(solUsd) <= 0) return null;
  return Number(sizeSol) * solUsd / Number(entryPrice);
}

async function fetchJupiterHolders(mint) {
  try {
    const res = await jupiterFetch(`https://datapi.jup.ag/v1/holders/${mint}`, { bucket: 'datapi' });
    const holders = Array.isArray(res.data?.holders) ? res.data.holders : [];
    const total = holders.reduce((sum, holder) => sum + Number(holder.amount || 0), 0);
    const mapped = holders.map((holder, index) => {
      const pct = total > 0 ? Number(holder.amount || 0) / total * 100 : null;
      return {
        address: holder.address,
        rank: index + 1,
        amount: Number(holder.amount || 0),
        percent: pct,
        tags: (holder.tags || []).map(tag => tag.name || tag.id).filter(Boolean),
      };
    });
    const top20 = mapped.slice(0, 20);
    return {
      count: holders.length,
      holders: mapped,
      top20,
      top20Percent: top20.reduce((sum, holder) => sum + Number(holder.percent || 0), 0),
      maxHolderPercent: Math.max(0, ...top20.map(holder => Number(holder.percent || 0))),
    };
  } catch (err) {
    console.log(`[holders] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return { count: 0, holders: [], top20: [], top20Percent: null, maxHolderPercent: null };
  }
}

function summarizeCandles(label, candles) {
  if (!candles.length) return { label, available: false };
  const first = candles[0];
  const last = candles[candles.length - 1];
  const high = Math.max(...candles.map(candle => Number(candle.high || 0)));
  const low = Math.min(...candles.map(candle => Number(candle.low || Infinity)));
  const volumeNative = candles.reduce((sum, candle) => sum + Number(candle.volume || 0), 0);
  const current = Number(last.close);
  const start = Number(first.open);
  return {
    label,
    available: true,
    purpose: label === 'ath_context_24h_5m' ? 'ath_context' : 'range_context',
    candles: candles.length,
    fromTime: first.time,
    toTime: last.time,
    current,
    high,
    low,
    volumeNative,
    changePercent: start > 0 ? (current / start - 1) * 100 : null,
    belowHighPercent: high > 0 ? (current / high - 1) * 100 : null,
    aboveLowPercent: low > 0 && Number.isFinite(low) ? (current / low - 1) * 100 : null,
  };
}

async function fetchJupiterChartWindow(mint, interval, candles, label) {
  const url = new URL(`https://datapi.jup.ag/v2/charts/${mint}`);
  url.searchParams.set('interval', interval);
  url.searchParams.set('to', String(now()));
  url.searchParams.set('candles', String(candles));
  url.searchParams.set('type', 'price');
  url.searchParams.set('quote', 'native');
  const res = await jupiterFetch(url.toString(), { bucket: 'datapi' });
  return summarizeCandles(label, Array.isArray(res.data?.candles) ? res.data.candles : []);
}

async function fetchJupiterChartContext(mint) {
  const windows = [
    ['5_MINUTE', 288, 'ath_context_24h_5m'],
    ['1_HOUR', 168, 'swing_7d_1h'],
    ['4_HOUR', 180, 'long_30d_4h'],
  ];
  const results = await Promise.all(windows.map(([interval, candles, label]) => (
    fetchJupiterChartWindow(mint, interval, candles, label).catch((err) => {
      console.log(`[chart] ${mint.slice(0, 8)}... ${interval} ${err.message}`);
      return { label, available: false, error: err.message };
    })
  )));
  const available = results.filter(row => row.available);
  const currentNative = available[0]?.current ?? null;
  const rangeHigh = available.length ? Math.max(...available.map(row => Number(row.high || 0))) : null;
  const topBlastRisk = Number.isFinite(Number(currentNative)) && Number.isFinite(Number(rangeHigh)) && rangeHigh > 0
    ? currentNative / rangeHigh >= 0.85
    : null;
  return {
    quote: 'native',
    purpose: 'ATH/range context, not momentum scoring',
    currentNative,
    rangeHighNative: rangeHigh,
    belowRangeHighPercent: currentNative && rangeHigh ? (currentNative / rangeHigh - 1) * 100 : null,
    distanceFromAthPercent: currentNative && rangeHigh ? (currentNative / rangeHigh - 1) * 100 : null,
    topBlastRisk,
    windows: results,
  };
}

const IGNORED_PNL_MINTS = new Set([
  'So11111111111111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
]);

// SOL/USD moves a few tenths of a percent per minute, so re-fetching it for every
// entry and every monitored position only burned rate-limit budget — and when the
// fetch failed the entry died as `missing_decimals_or_sol_price` even though the
// quote was already paid for. Cache for 60s and serve the last good price for up
// to 10 minutes if the upstream is unavailable.
const SOL_USD_STALE_MS = 10 * 60_000;

async function fetchSolUsdPriceCached() {
  if (solUsdCache.price != null && now() - solUsdCache.at < 60_000) return solUsdCache.price;
  const price = await fetchSolUsdPrice();
  if (Number.isFinite(Number(price)) && Number(price) > 0) {
    solUsdCache = { price, at: now() };
    return price;
  }
  if (solUsdCache.price != null && now() - solUsdCache.at < SOL_USD_STALE_MS) return solUsdCache.price;
  solUsdCache = { price: null, at: now() };
  return null;
}

async function jupiterQuoteOnce(params, label, priority) {
  try {
    const url = new URL(`${JUPITER_SWAP_BASE_URL}/quote`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const res = await jupiterFetch(url.toString(), { priority });
    return res.data?.outAmount ? { ...res.data, observedAtMs: now() } : null;
  } catch (err) {
    if (err.response?.status !== 429) console.log(`[quote] ${label} ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}

// A freshly migrated mint often has no route for a few hundred ms — retry instead of
// dropping the entry. Rate limiting (429 -> wait for x-ratelimit-reset) is handled by
// the shared queue in jupiterFetch, so a retry simply queues behind the reset.
// `waitOutBackoff` is accepted for compatibility; the queue always waits.
async function jupiterQuote(params, label, attempts = 3, { priority = 'entry' } = {}) {
  for (let i = 0; i < attempts; i++) {
    const quote = await jupiterQuoteOnce(params, label, priority);
    if (quote) return quote;
    await sleep(350);
  }
  return null;
}

// Fixed 1000-token reference amount ignores price impact for large sizes —
// upgrade to position-sized quotes when size_sol > 1.
export async function fetchJupiterExecutionQuote({ inputMint, outputMint, amount }, opts = undefined) {
  return jupiterQuote({ inputMint, outputMint, amount, slippageBps: 100 }, 'execution', 3, { priority: opts?.priority || 'entry' });
}

async function fetchTokenSpotViaQuote(mint, decimals = 9, { priority = 'entry' } = {}) {
  const normalizedDecimals = Number.isFinite(Number(decimals)) ? Math.max(0, Math.min(18, Number(decimals))) : 9;
  const cacheKey = `${mint}:${normalizedDecimals}`;
  const cached = quoteSnapshotCache.get(cacheKey);
  if (cached && now() - cached.at < QUOTE_SNAPSHOT_MS) return cached.priceUsd;
  try {
    const tokenUnits = 1000 * (10 ** normalizedDecimals);
    const [solUsd, quoteRes] = await Promise.all([
      fetchSolUsdPriceCached(),
      jupiterQuote({ inputMint: mint, outputMint: WSOL_MINT, amount: Math.round(tokenUnits), slippageBps: 100 }, mint.slice(0, 8), 2, { priority }),
    ]);
    const outAmount = quoteRes?.outAmount;
    if (!outAmount) return null;
    const outSol = Number(outAmount) / 1e9;
    if (!Number.isFinite(solUsd) || solUsd <= 0) return null;
    const priceUsd = (outSol / 1000) * solUsd;
    quoteSnapshotCache.set(cacheKey, { at: now(), priceUsd });
    return priceUsd;
  } catch (err) {
    if (err.response?.status !== 429) console.log(`[quote] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}

async function fetchJupiterWalletPnl(walletAddress) {
  try {
    const url = new URL('https://datapi.jup.ag/v1/pnl');
    url.searchParams.set('addresses', walletAddress);
    url.searchParams.set('includeClosed', 'false');
    const res = await jupiterFetch(url.toString(), { bucket: 'datapi' });
    const data = res.data?.[walletAddress] || {};
    for (const mint of IGNORED_PNL_MINTS) delete data[mint];
    return data;
  } catch (err) {
    console.log(`[pnl] ${err.response?.status || ''} ${err.message}`);
    return {};
  }
}

export {
  jupiterStatsForInterval,
  normalizeJupiterTrendingRow,
  fetchJupiterAsset,
  fetchSolUsdPrice,
  fetchSolUsdPriceCached,
  estimateTokenAmountFromSol,
  fetchJupiterHolders,
  summarizeCandles,
  fetchJupiterChartWindow,
  fetchJupiterChartContext,
  fetchJupiterWalletPnl,
  fetchTokenSpotViaQuote,
  jupiterAssetBackoffActive,
  setJupiterAssetBackoff,
};
