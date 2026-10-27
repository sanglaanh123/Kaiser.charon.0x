import axios from 'axios';
import { ENABLE_JEV, TYPESAFE_API_KEY, JEV_MODEL, JEV_TIMEOUT_MS } from '../config.js';
import { numSetting, boolSetting, activeStrategy } from '../db/settings.js';
import { storeSignalEvent } from '../signals/trending.js';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_CONCURRENCY = 3;
const JEV_RETRY_DELAY_MS = 250;
// Every batch re-screens the recent rows; an unchanged bucketed state gets the same
// answer, so reuse it (and share in-flight calls) instead of spending another request.
const JEV_ANSWER_TTL_MS = 10 * 60_000;
const jevAnswers = new Map(); // state -> { at, promise }

// Bucket thresholds (Jev is weak at raw numbers, so state carries words)
const MCAP_BUCKETS = [[10_000, 'micro'], [50_000, 'small'], [150_000, 'mid'], [Infinity, 'large']];
const LIQ_MCAP_HEALTHY = 0.15; // liquidity / mcap
const LIQ_MCAP_THIN = 0.06;
const PCT_BUCKETS = { top10: [20, 35], bot: [20, 40], dev: [3, 10] }; // [moderate-from, high-from]
const ORGANIC_BUCKETS = [[30, 'low'], [60, 'medium'], [Infinity, 'high']];
const FLOW_BUCKETS = [[0.35, 'selling'], [0.55, 'balanced'], [Infinity, 'buying']]; // net buyers / traders, mapped to 0..1
const PRICE_CHANGE_FLAT = 2; // abs % under which 1h move is "flat"
const AGE_BUCKETS = [[10 * 60_000, 'under 10m'], [60 * 60_000, 'under 1h'], [6 * 3_600_000, 'under 6h'], [Infinity, 'older']];

// Order matters: Jev has first-option bias, so the conservative option goes first.
const VERDICT_CRITERIA = {
  PASS: 'Clear red flags: heavy bots or bundling, thin liquidity, dumping price, concentrated holders, or too small to trade. Skip.',
  WATCH: 'Interesting but missing confirmation. Mixed signals, or data too thin to commit.',
  BUY: 'Best asymmetric setup: clean holders, healthy liquidity, buyers in control, no obvious rug signs.',
};
const RUG_INSTRUCTIONS = 'Does this look like a rug pull or coordinated dump setup?';
const MOMENTUM_LEVELS = [
  'fading: price and buying flow are weakening',
  'flat: no clear direction',
  'building: buyers gaining, price rising steadily',
  'strong: sustained heavy buying with rising price',
];
const MOMENTUM_NAMES = ['fading', 'flat', 'building', 'strong'];

function bucket(value, table) {
  for (const [limit, label] of table) if (value < limit) return label;
  return table[table.length - 1][1];
}

function pctWord(value, [moderate, high]) {
  return value >= high ? 'high' : value >= moderate ? 'moderate' : 'low';
}

function fmtUsd(n) {
  return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`;
}

function finite(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function riskFlagList(candidate) {
  const flags = [];
  for (const f of candidate?.riskFlags || []) flags.push(String(f?.type || f?.code || f));
  for (const f of candidate?.filters?.failures || []) flags.push(String(f).split(':')[0].slice(0, 60));
  return [...new Set(flags)].slice(0, 8);
}

// Plain-text, decision-relevant facts only. No JSON.
export function buildJevState(candidate, preScore = null) {
  const c = candidate || {};
  const m = c.metrics || {};
  const jup = c.jupiterAsset || {};
  const audit = jup.audit || {};
  const lines = [];

  lines.push(`Route: ${c.signals?.route || 'unknown'}`);
  const mcap = finite(m.marketCapUsd ?? jup.mcap);
  if (mcap !== null) lines.push(`Market cap: ${fmtUsd(mcap)} (${bucket(mcap, MCAP_BUCKETS)})`);
  const liq = finite(m.liquidityUsd ?? jup.liquidity);
  if (liq !== null && liq > 0) {
    const ratio = mcap ? liq / mcap : null;
    const word = ratio === null ? '' : ratio >= LIQ_MCAP_HEALTHY ? ' (healthy vs mcap)' : ratio >= LIQ_MCAP_THIN ? ' (okay vs mcap)' : ' (thin vs mcap)';
    lines.push(`Liquidity: ${fmtUsd(liq)}${word}`);
  }
  const holders = finite(m.holderCount ?? jup.holderCount);
  if (holders !== null && holders > 0) {
    const growth = finite(jup.stats1h?.holderChange);
    const gw = growth === null ? '' : growth > 0 ? ', growing' : growth < 0 ? ', shrinking' : ', stable';
    lines.push(`Holders: ${holders}${gw}`);
  }
  const top10 = finite(audit.topHoldersPercentage);
  if (top10 !== null) lines.push(`Top 10 holders: ${Math.round(top10)}% (${pctWord(top10, PCT_BUCKETS.top10)})`);
  const bot = finite(audit.botHoldersPercentage);
  if (bot !== null) lines.push(`Bot holders: ${Math.round(bot)}% (${pctWord(bot, PCT_BUCKETS.bot)})`);
  const dev = finite(audit.devBalancePercentage);
  if (dev !== null) lines.push(`Dev balance: ${Math.round(dev)}% (${pctWord(dev, PCT_BUCKETS.dev)})`);
  const organic = finite(jup.organicScore ?? c.trending?.organic_score);
  if (organic !== null) lines.push(`Organic activity: ${bucket(organic, ORGANIC_BUCKETS)}`);
  if (audit.mintAuthorityDisabled !== undefined) lines.push(`Mint authority: ${audit.mintAuthorityDisabled ? 'disabled' : 'ACTIVE'}`);
  if (audit.freezeAuthorityDisabled !== undefined) lines.push(`Freeze authority: ${audit.freezeAuthorityDisabled ? 'disabled' : 'ACTIVE'}`);

  const buyers = finite(jup.stats5m?.numNetBuyers);
  const traders = finite(jup.stats5m?.numTraders);
  if (buyers !== null && traders !== null && traders > 0) {
    lines.push(`5m trade flow: ${bucket((buyers / traders + 1) / 2, FLOW_BUCKETS)}`);
  }
  const pc1h = finite(jup.stats1h?.priceChange);
  if (pc1h !== null) {
    const w = Math.abs(pc1h) < PRICE_CHANGE_FLAT ? 'flat' : pc1h > 0 ? 'up' : 'down';
    lines.push(`1h price change: ${pc1h >= 0 ? '+' : ''}${pc1h.toFixed(0)}% (${w})`);
  }
  const bornMs = Date.parse(jup.firstPool?.createdAt || jup.graduatedAt || '');
  if (Number.isFinite(bornMs) && bornMs > 0) lines.push(`Age: ${bucket(Date.now() - bornMs, AGE_BUCKETS)}`);
  if (preScore && Number.isFinite(Number(preScore.score))) lines.push(`Pre-score: ${preScore.score}/100`);
  const flags = riskFlagList(c);
  lines.push(`Rule risk flags: ${flags.length ? flags.join(', ') : 'none'}`);
  lines.push(`Data source: ${c.marketSource || 'unknown'}`);
  return lines.join('\n');
}

export function jevQuestions() {
  return {
    verdict: {
      type: 'choice',
      instructions: 'Should a short-term meme coin trade be opened on this token? Be conservative.',
      criteria: { ...VERDICT_CRITERIA },
    },
    rug: { type: 'noul', instructions: RUG_INSTRUCTIONS },
    momentum: {
      type: 'score',
      instructions: 'How strong is current buying momentum?',
      criteria: MOMENTUM_LEVELS,
    },
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function retryable(err) {
  const s = err?.response?.status;
  return !s || s === 429 || s >= 500;
}

export async function jevAsk({ state, questions, timeoutMs = JEV_TIMEOUT_MS }) {
  const body = { model: JEV_MODEL, state, questions };
  const cfg = {
    timeout: timeoutMs,
    headers: { authorization: `Bearer ${TYPESAFE_API_KEY}`, 'content-type': 'application/json' },
  };
  try {
    return (await axios.post(JEV_URL, body, cfg)).data;
  } catch (err) {
    if (!retryable(err)) throw err;
    await sleep(JEV_RETRY_DELAY_MS);
    return (await axios.post(JEV_URL, body, cfg)).data;
  }
}

function cachedJevAsk(state, questions) {
  const at = Date.now();
  const hit = jevAnswers.get(state);
  if (hit && at - hit.at < JEV_ANSWER_TTL_MS) return hit.promise;
  if (jevAnswers.size > 500) {
    for (const [key, v] of jevAnswers) if (at - v.at >= JEV_ANSWER_TTL_MS) jevAnswers.delete(key);
  }
  const promise = jevAsk({ state, questions });
  jevAnswers.set(state, { at, promise });
  promise.catch(() => jevAnswers.delete(state));
  return promise;
}

export function _resetJevCache() { jevAnswers.clear(); }

// Active strategy's threshold wins (it is what /stratset and the strategy menu edit); global setting is the fallback.
function llmBuyMinConfidence() {
  const fromStrategy = finite(activeStrategy()?.llm_min_confidence);
  return fromStrategy ?? numSetting('llm_min_confidence', 40);
}

export { llmBuyMinConfidence };

function defaultTp() {
  return Number(activeStrategy()?.tp_percent) || numSetting('default_tp_percent', 50);
}
function defaultSl() {
  return Number(activeStrategy()?.sl_percent) || numSetting('default_sl_percent', -25);
}

export function normalizeDecision(parsed, fallbackReason = '') {
  let verdict = ['BUY', 'WATCH', 'PASS'].includes(String(parsed?.verdict).toUpperCase())
    ? String(parsed.verdict).toUpperCase()
    : 'WATCH';
  const confidence = Math.max(0, Math.min(100, Number(parsed?.confidence) || 0));
  if (verdict === 'BUY' && confidence < llmBuyMinConfidence()) {
    console.log(`[jev] BUY downgraded to WATCH - confidence ${confidence} < threshold ${llmBuyMinConfidence()}`);
    verdict = 'WATCH';
  }
  return {
    verdict,
    confidence,
    reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    suggested_tp_percent: Number(parsed?.suggested_tp_percent) || defaultTp(),
    suggested_sl_percent: Number(parsed?.suggested_sl_percent) || defaultSl(),
    raw: parsed,
  };
}

function emptyDecision(reason, risks, raw = null) {
  return {
    verdict: 'WATCH',
    confidence: 0,
    selected_candidate_id: null,
    selected_mint: null,
    selected_row: null,
    reason,
    risks,
    suggested_tp_percent: defaultTp(),
    suggested_sl_percent: defaultSl(),
    raw,
    row_verdicts: {},
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const f2 = n => (Number.isFinite(n) ? n.toFixed(2).replace(/^0/, '') : '?');
const jevReason = r => `Jev P(BUY)=${f2(r.pBuy)} WATCH=${f2(r.pWatch)} PASS=${f2(r.pPass)} · rug=${f2(r.rug)} · momentum=${r.momentum} · conf=${f2(r.vconf)}`;

export async function decideCandidateBatch(rows, triggerCandidateId) {
  if (!ENABLE_JEV || !TYPESAFE_API_KEY) return emptyDecision('jev disabled', ['no_llm_decision']);
  if (!rows?.length) {
    console.log('[jev] no candidates');
    return emptyDecision('No eligible candidates.', ['no_candidates']);
  }

  const maxRug = numSetting('jev_max_rug', 0.35);
  const questions = jevQuestions();
  const results = await mapLimit(rows, JEV_CONCURRENCY, async row => {
    try {
      const state = buildJevState(row.candidate, row.candidate?.preScore);
      const res = await cachedJevAsk(state, questions);
      const a = res?.answers || {};
      const probs = a.verdict?.probabilities || {};
      const mIdx = Math.max(0, Math.min(3, Math.round(Number(a.momentum?.score) || 0)));
      return {
        row,
        choice: String(a.verdict?.choice || '').toUpperCase(),
        pBuy: Number(probs.BUY) || 0,
        pWatch: Number(probs.WATCH) || 0,
        pPass: Number(probs.PASS) || 0,
        vconf: Number(a.verdict?.confidence),
        rug: finite(a.rug?.noul) ?? 1, // missing rug answer must not pass the rug veto
        momentum: a.momentum ? MOMENTUM_NAMES[mIdx] : '?',
        answers: a,
        usage: res?.usage,
        model: res?.model,
      };
    } catch (err) {
      console.log(`[jev] row ${row.id} failed: ${err.message}`);
      return { error: err.message, row };
    }
  });

  const ok = results.filter(r => !r.error);
  if (!ok.length) {
    const msg = results[0]?.error || 'unknown';
    console.log(`[jev] batch failed: ${msg}`);
    return emptyDecision(`Jev failed: ${msg}`, ['jev_error'], { error: msg });
  }

  const raw = {
    model: ok.find(r => r.model)?.model || JEV_MODEL,
    perRow: ok.map(r => ({ candidateId: r.row.id, answers: r.answers, usage: r.usage })),
  };

  // Default: Jev must pick BUY outright. jev_require_buy_choice=false (testing) accepts any row whose
  // P(BUY) clears the confidence threshold, even when WATCH is Jev's top choice.
  const requireChoice = boolSetting('jev_require_buy_choice', true);
  const minPct = llmBuyMinConfidence();
  const eligible = ok.filter(r => r.rug < maxRug && (requireChoice ? r.choice === 'BUY' : r.pBuy * 100 >= minPct));
  const best = eligible.sort((a, b) => b.pBuy * (1 - b.rug) - a.pBuy * (1 - a.rug))[0] || null;

  // Each screened row keeps its own verdict: a PASS stays PASS (60m cache) instead of becoming WATCH.
  // A BUY choice that was not selected (rug veto or another row won) is WATCH.
  const rowVerdicts = {};
  for (const r of results) {
    rowVerdicts[r.row.id] = r.error
      ? { verdict: 'WATCH', confidence: 0, reason: `Jev failed: ${r.error}` }
      : { verdict: r === best ? 'BUY' : (r.choice === 'PASS' ? 'PASS' : 'WATCH'), confidence: Math.round(r.pBuy * 100), reason: jevReason(r) };
  }

  // No buy: the batch verdict is the trigger's own, so the card's verdict and reason describe the same token.
  const trigger = ok.find(r => r.row.id === triggerCandidateId) || null;
  const basis = best || trigger;
  const triggerVerdict = rowVerdicts[triggerCandidateId] || { verdict: 'WATCH', confidence: 0, reason: 'Trigger not in batch.' };
  const verdict = best ? 'BUY' : triggerVerdict.verdict;
  const reason = basis ? jevReason(basis) : triggerVerdict.reason;
  const risks = basis ? riskFlagList(basis.row.candidate) : ['jev_error'];
  if (basis && basis.rug >= maxRug) risks.push('jev_rug_high');
  const decision = normalizeDecision({
    verdict,
    confidence: basis ? Math.round(basis.pBuy * 100) : 0,
    reason,
    risks,
  });
  decision.raw = raw;
  // normalizeDecision may downgrade a BUY under the confidence threshold; keep the row verdict in step.
  if (best && decision.verdict !== 'BUY') rowVerdicts[best.row.id].verdict = 'WATCH';
  decision.row_verdicts = rowVerdicts;

  const sel = decision.verdict === 'BUY' ? best.row : null;
  if (decision.verdict === 'PASS' || decision.verdict === 'BUY') {
    console.log(`[jev-metric] verdict=${decision.verdict} confidence=${decision.confidence} route=${basis?.row.candidate?.signals?.route || ''}`);
  }
  if (decision.verdict === 'WATCH') {
    const watchMint = trigger?.row.candidate?.token?.mint;
    if (watchMint) {
      try {
        storeSignalEvent(watchMint, 'watch', 'jev', { verdict: 'WATCH', confidence: decision.confidence, reason: decision.reason });
      } catch (err) {
        console.log(`[jev] storeSignalEvent(watch) failed: ${err.message}`);
      }
    }
  }
  return {
    ...decision,
    selected_candidate_id: sel ? sel.id : null,
    selected_mint: sel ? sel.candidate.token.mint : null,
    selected_row: sel || null,
  };
}
