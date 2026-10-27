import { now } from '../utils.js';
import { firstPositiveNumber } from '../utils.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, jupiterAssetBackoffActive } from './jupiter.js';
import { fetchGmgnTokenInfo, marketCapFromGmgn, tokenPriceFromGmgn } from './gmgn.js';

// Single entry point for token market data: Jupiter datapi first, GMGN as fallback,
// returned in the Jupiter asset shape (plus `source`) so consumers don't care which.
const decimalsCache = new Map();
const chartCache = new Map();
const CHART_TTL_MS = 60_000;
const CHART_FAIL_TTL_MS = 15_000;

const forceFallback = () => process.env.JUP_FORCE_FALLBACK === '1';

function positiveOrUndefined(...values) {
  return firstPositiveNumber(...values) ?? undefined;
}

function rememberDecimals(mint, decimals) {
  const n = Number(decimals);
  if (Number.isInteger(n) && n >= 0 && n <= 18 && decimals !== null && decimals !== '') decimalsCache.set(mint, n);
}

export function getCachedDecimals(mint) {
  return decimalsCache.get(mint);
}

function normalizeGmgnAsset(mint, info) {
  const mcap = marketCapFromGmgn(info) ?? undefined;
  const top10Rate = Number(info?.stat?.top_10_holder_rate ?? info?.top_10_holder_rate);
  const decimals = Number(info?.decimals);
  return {
    id: mint,
    name: info?.name,
    symbol: info?.symbol,
    decimals: Number.isFinite(decimals) ? decimals : undefined,
    usdPrice: tokenPriceFromGmgn(info) ?? undefined,
    mcap,
    fdv: mcap,
    liquidity: positiveOrUndefined(info?.liquidity, info?.pool?.liquidity),
    holderCount: positiveOrUndefined(info?.holder_count),
    fees: positiveOrUndefined(info?.total_fee),
    organicScore: undefined,
    twitter: info?.link?.twitter_username || undefined,
    website: info?.link?.website || undefined,
    audit: {
      topHoldersPercentage: Number.isFinite(top10Rate) ? top10Rate * 100 : undefined,
    },
    source: 'gmgn',
  };
}

export async function fetchTokenMarket(mint, { useCache = true, ttlMs = 20_000, priority = 'enrich' } = {}) {
  let asset = null;
  if (!forceFallback() && !jupiterAssetBackoffActive()) {
    try {
      asset = await fetchJupiterAsset(mint, { useCache, ttlMs, priority });
    } catch {
      asset = null;
    }
  }
  if (asset) {
    if (asset.decimals != null) rememberDecimals(mint, asset.decimals);
    else if (decimalsCache.has(mint)) asset = { ...asset, decimals: decimalsCache.get(mint) };
    return { ...asset, source: 'jupiter' };
  }
  let info = null;
  try {
    info = await fetchGmgnTokenInfo(mint, useCache);
  } catch {
    info = null;
  }
  if (!info) return null;
  const normalized = normalizeGmgnAsset(mint, info);
  if (normalized.decimals != null) rememberDecimals(mint, normalized.decimals);
  else if (decimalsCache.has(mint)) normalized.decimals = decimalsCache.get(mint);
  return normalized;
}

export async function fetchHolders(mint) {
  if (!forceFallback() && !jupiterAssetBackoffActive()) {
    const jup = await fetchJupiterHolders(mint);
    if (jup?.holders?.length) return { ...jup, source: 'jupiter' };
  }
  let info = null;
  try {
    info = await fetchGmgnTokenInfo(mint, true);
  } catch {
    info = null;
  }
  if (!info) return { count: 0, holders: [], top20: [], top20Percent: null, maxHolderPercent: null, source: 'jupiter' };
  const top10Rate = Number(info?.stat?.top_10_holder_rate ?? info?.top_10_holder_rate);
  return {
    count: Number(info.holder_count || 0),
    holders: [],
    top20: [],
    top20Percent: null,
    top10Percent: Number.isFinite(top10Rate) ? top10Rate * 100 : null,
    maxHolderPercent: null,
    source: 'gmgn',
  };
}

// Per-tick ATR chart for open positions: 60s cache; null on failure (caller keeps static SL).
export async function fetchChartContextCached(mint) {
  const cached = chartCache.get(mint);
  if (cached && now() < cached.until) return cached.data;
  let data = null;
  try {
    const chart = await fetchJupiterChartContext(mint);
    data = chart?.windows?.some(w => w.available) ? chart : null;
  } catch {
    data = null;
  }
  chartCache.set(mint, { data, until: now() + (data ? CHART_TTL_MS : CHART_FAIL_TTL_MS) });
  return data;
}
