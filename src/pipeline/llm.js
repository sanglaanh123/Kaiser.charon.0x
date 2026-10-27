import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS, LLM_MODEL_CHEAP, LLM_BASE_URL_CHEAP, LLM_API_KEY_CHEAP, LLM_OPENROUTER_MODEL, LLM_OPENROUTER_API_KEY, LLM_FALLBACK_BASE_URL, LLM_FALLBACK_API_KEY, LLM_FALLBACK_MODEL } from '../config.js';
import { now, stripThinking, strictJsonFromText } from '../utils.js';
import { numSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { storeSignalEvent } from '../signals/trending.js';

// Read from DB setting (configurable per-strategy), fallback to 70 for backward compat
import { activeStrategy } from '../db/settings.js';

function llmBuyMinConfidence() { 
  // Always read fresh from settings table (source of truth)
  const fromSettings = numSetting('llm_min_confidence', 40);
  return fromSettings;
}
function llmLowConfidenceCap() { return numSetting('llm_low_confidence_cap', 70); }

export function normalizeDecision(parsed, fallbackReason = '', route = '') {
  let verdict = ['BUY', 'WATCH', 'PASS'].includes(String(parsed?.verdict).toUpperCase())
    ? String(parsed.verdict).toUpperCase()
    : 'WATCH';
  let confidence = Math.max(0, Math.min(100, Number(parsed?.confidence) || 0));

  if (verdict === 'BUY' && confidence < llmBuyMinConfidence()) {
    console.log(`[llm] BUY downgraded to WATCH — confidence ${confidence} < threshold ${llmBuyMinConfidence()}`);
    verdict = 'WATCH';
  }
  // trenches_completed penalty removed — historically profitable route (Lesson #1)
  return {
    verdict,
    confidence,
    reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    suggested_tp_percent: Number(parsed?.suggested_tp_percent) || numSetting('default_tp_percent', 50),
    suggested_sl_percent: Number(parsed?.suggested_sl_percent) || numSetting('default_sl_percent', -25),
    raw: parsed,
  };
}

export function effectivePositionSizeSol(strat, decision) {
  const base = Number(strat?.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1));
  if (decision?.verdict === 'BUY' && Number(decision?.confidence) < llmLowConfidenceCap()) {
    console.log('[llm] low confidence BUY — position size halved');
    return base * 0.5;
  }
  return base;
}

export { llmBuyMinConfidence, llmLowConfidenceCap };

export function activeLessonsForPrompt(limit = 6) {
  return db.prepare(`
    SELECT lesson
    FROM learning_lessons
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT ?
  `).all(limit).map(row => row.lesson);
}

/**
 * Select model based on signal route.
 * Signal Server routes (high volume) → cheap model
 * PumpPortal route (real-time, low volume) → fast model
 */
export function selectModelForRoute(route = '') {
  // PumpPortal = real-time, use fast model
  if (route.includes('pumpportal')) {
    return {
      baseUrl: LLM_BASE_URL,
      apiKey: LLM_API_KEY,
      model: LLM_MODEL,
    };
  }
  // Signal Server / local routes = batch, use cheap model
  if (LLM_MODEL_CHEAP) {
    return {
      baseUrl: LLM_BASE_URL_CHEAP || LLM_BASE_URL,
      apiKey: LLM_API_KEY_CHEAP || LLM_API_KEY, // Same provider = same key
      model: LLM_MODEL_CHEAP,
    };
  }
  // Fallback to primary
  return {
    baseUrl: LLM_BASE_URL,
    apiKey: LLM_API_KEY,
    model: LLM_MODEL,
  };
}

export function compactCandidateForLlm(row) {
  const c = row.candidate;
  const athWindow = c.chart?.windows?.find(window => window.label === 'ath_context_24h_5m' && window.available)
    || c.chart?.windows?.find(window => window.label === 'recent_24h_5m' && window.available);

  // Strip raw holder arrays (addresses/amounts) — LLM only needs summary stats
  const h = c.holders || {};
  const compactHolders = {
    count: h.count,
    top20Percent: h.top20Percent,
    maxHolderPercent: h.maxHolderPercent,
  };

  // Strip raw windows array — athContext24h already captures high/low/current
  // Compact jupiterAsset for LLM (rich data source for fresh grads since gmgn is skipped in fast-path)
  const jup = c.jupiterAsset || {};
  const jupAudit = jup.audit || {};
  const compactJupiter = {
    holderCount: jup.holderCount,
    liquidityUsd: jup.liquidity,
    fdv: jup.fdv,
    mcap: c.metrics?.marketCapUsd ?? jup.mcap,
    organicScore: jup.organicScore,
    organicScoreLabel: jup.organicScoreLabel,
    audit: {
      mintAuthorityDisabled: jupAudit.mintAuthorityDisabled,
      freezeAuthorityDisabled: jupAudit.freezeAuthorityDisabled,
      topHoldersPercentage: jupAudit.topHoldersPercentage,
      devBalancePercentage: jupAudit.devBalancePercentage,
      devMigrations: jupAudit.devMigrations,
      sniperPct: jupAudit.sniperPct,
      insiderPct: jupAudit.insiderPct,
      botHoldersCount: jupAudit.botHoldersCount,
      botHoldersPercentage: jupAudit.botHoldersPercentage,
    },
    stats1h: jup.stats1h,
    stats6h: jup.stats6h,
    stats24h: jup.stats24h,
    tags: jup.tags,
    graduatedAt: jup.graduatedAt,
    firstPoolAt: jup.firstPool?.createdAt,
  };

  return {
    candidate_id: row.id,
    mint: c.token?.mint,
    route: c.signals?.route,
    signals: c.signals,
    token: c.token,
    metrics: c.metrics,
    feeClaim: c.feeClaim,
    trending: c.trending,
    graduation: c.graduation,
    jupiterAsset: compactJupiter,
    holders: compactHolders,
    chart: {
      purpose: 'ATH/range context only. Do not treat large 24h change as bullish/bearish momentum by itself.',
      currentNative: c.chart?.currentNative,
      rangeHighNative: c.chart?.rangeHighNative,
      distanceFromAthPercent: c.chart?.distanceFromAthPercent ?? c.chart?.belowRangeHighPercent,
      topBlastRisk: c.chart?.topBlastRisk,
      athContext24h: athWindow ? {
        current: athWindow.current,
        high: athWindow.high,
        low: athWindow.low,
        distanceFromHighPercent: athWindow.belowHighPercent,
        aboveLowPercent: athWindow.aboveLowPercent,
      } : null,
    },
    savedWalletExposure: c.savedWalletExposure,
    twitterNarrative: c.twitterNarrative,
    filters: c.filters,
  };
}

export async function decideCandidateBatch(rows, triggerCandidateId) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: 'LLM disabled or LLM_API_KEY missing.',
      risks: ['no_llm_decision'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: null,
    };
  }

  // Determine route from trigger candidate for model selection
  const triggerRow = rows.find(item => item.id === triggerCandidateId);
  const route = triggerRow?.candidate?.signals?.route || '';
  const llmConfig = selectModelForRoute(route);
  console.log(`[llm] model=${llmConfig.model} route=${route || 'none'}`);

  const system = [
    'You are Charon, a Solana meme coin trench analyst.',
    'Return strict JSON only — no markdown, no code fences, no explanation outside JSON.',
    'You will receive up to 10 candidates. Pick at most ONE to BUY, or PASS all.',
    '',
    '== SOFT SCORE CONTEXT ==',
    'Each candidate has a pre-computed soft score (0-150). Score >= 50 passed pre-filter.',
    'Use soft score as ONE input, not the primary filter. Score 70+ with weak narrative = WATCH.',
    '',
    '== FRESHLY GRADUATED (pumpportal_graduated) ==',
    'Brand new tokens. HIGH concentration, ZERO smart money, no narrative = NORMAL. Do NOT penalize.',
    'PRIMARY signal: botHoldersPercentage. Data-driven buckets:',
    '  bot% < 20% + liq > $3K = BUY 70-80. bot% 20-30% + liq > $5K = BUY 60-70.',
    '  bot% 30-50% = WATCH. bot% > 50% = PASS. organicScore is unreliable for fresh grads.',
    '',
    '== ESTABLISHED (trenches_completed, fee_trending) ==',
    'trenches: mcap $25K-$100K sweet spot. High dev_migrations = POSITIVE (experienced dev).',
    '  High bot% = smart money + bots coexisting (more tolerant). Top10 rug zone: 25-35%.',
    '  Smart money (smart_degen_count) is STRONG signal. Prefer >= 3.',
    'fee_trending: mcap $40K-$100K. High RR but be selective. Confidence 55+ for BUY.',
    '  MAX_HOLD common (80%+). Prefer organic_score >= 50 + bundler_rate < 0.3.',
    '',
    '== UNIVERSAL ==',
    'ENTRY FLOOR: mcap >= $5K. BUY: best asymmetric opportunity. WATCH: interesting but missing confirmation. PASS: heavy bundling, low liquidity, high rug risk.',
    'Exit: prefer TRAILING_TP. suggested_tp 50%+, suggested_sl -25%.',
  ].join(' ');
  const user = {
    task: 'Pick the best dry-run buy candidate from this recent batch, or choose none.',
    recent_lessons: activeLessonsForPrompt(),
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'short string',
      risks: ['short strings'],
      suggested_tp_percent: 'positive number',
      suggested_sl_percent: 'negative number',
    },
    trigger_candidate_id: triggerCandidateId,
    candidates: [],  // placeholder, filled below
  };

  user.candidates = rows.map(compactCandidateForLlm);

  // Skip LLM call entirely when there is nothing to judge — saves tokens
  if (user.candidates.length === 0) {
    console.log('[llm] no candidates — 0 tokens used');
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: 'No eligible candidates.',
      risks: ['no_candidates'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: null,
    };
  }

  try {
    const userPrompt = JSON.stringify(user);
    let res;
    
    // Try primary model first
    try {
      try {
        res = await axios.post(`${llmConfig.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          model: llmConfig.model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userPrompt },
          ],
        }, {
          timeout: LLM_TIMEOUT_MS,
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
          headers: { authorization: `Bearer ${llmConfig.apiKey}`, 'content-type': 'application/json' },
        });
      } catch (primaryCallErr) {
        if (primaryCallErr?.name === 'AbortError' || primaryCallErr?.name === 'CanceledError' || primaryCallErr?.code === 'ABORTED' || primaryCallErr?.code === 'ERR_CANCELED') {
          console.log(`[llm] call aborted after ${LLM_TIMEOUT_MS}ms`);
        }
        throw primaryCallErr;
      }
    } catch (primaryErr) {
      const status = primaryErr.response?.status;
      const errCode = primaryErr.code;
      // Retryable: credit/auth/rate-limit/server errors, network failures, timeouts
      const isRetryable = status === 402 || status === 401 || status === 412 || status === 429 ||
                          (typeof status === 'number' && status >= 500) ||
                          errCode === 'ECONNREFUSED' || errCode === 'ETIMEDOUT' ||
                          errCode === 'ENOTFOUND' || errCode === 'EAI_AGAIN' ||
                          primaryErr?.name === 'AbortError' || primaryErr?.name === 'CanceledError' ||
                          errCode === 'ABORTED' || errCode === 'ERR_CANCELED';

      // First fallback: Zyloo (catches any retryable error, not just 402/401)
      if (isRetryable && LLM_FALLBACK_MODEL && LLM_FALLBACK_API_KEY && LLM_FALLBACK_BASE_URL) {
        console.log(`[llm] primary failed (${status || errCode || primaryErr.message}), fallback → Zyloo ${LLM_FALLBACK_MODEL}`);
        try {
          res = await axios.post(`${LLM_FALLBACK_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
            model: LLM_FALLBACK_MODEL,
            temperature: 0.2,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: userPrompt },
            ],
          }, {
            timeout: LLM_TIMEOUT_MS,
            signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
            headers: { authorization: `Bearer ${LLM_FALLBACK_API_KEY}`, 'content-type': 'application/json' },
          });
          console.log('[llm] Zyloo fallback succeeded');
        } catch (fallbackCallErr) {
          const fbStatus = fallbackCallErr.response?.status;
          // If Zyloo fails on credit/auth, try OpenRouter as final fallback
          if ((fbStatus === 402 || fbStatus === 401 || fbStatus === 412) && LLM_OPENROUTER_MODEL && LLM_OPENROUTER_API_KEY) {
            console.log(`[llm] Zyloo fallback failed (${fbStatus}), final → OpenRouter ${LLM_OPENROUTER_MODEL}`);
            res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
              model: LLM_OPENROUTER_MODEL,
              temperature: 0.2,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: userPrompt },
              ],
            }, {
              timeout: LLM_TIMEOUT_MS,
              signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
              headers: {
                authorization: `Bearer ${LLM_OPENROUTER_API_KEY}`,
                'content-type': 'application/json',
                'HTTP-Referer': 'https://charon-bot.local',
                'X-Title': 'Charon Trading Bot',
              },
            });
            console.log('[llm] OpenRouter final fallback succeeded');
          } else {
            throw fallbackCallErr;
          }
        }
      } else if ((status === 402 || status === 401 || status === 412) && LLM_OPENROUTER_MODEL && LLM_OPENROUTER_API_KEY) {
        // Backward-compat: original OpenRouter fallback path (when Zyloo not configured)
        console.log(`[llm] primary failed (${status}), fallback → OpenRouter ${LLM_OPENROUTER_MODEL}`);
        try {
          res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: LLM_OPENROUTER_MODEL,
            temperature: 0.2,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: userPrompt },
            ],
          }, {
            timeout: LLM_TIMEOUT_MS,
            signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
            headers: {
              authorization: `Bearer ${LLM_OPENROUTER_API_KEY}`,
              'content-type': 'application/json',
              'HTTP-Referer': 'https://charon-bot.local',
              'X-Title': 'Charon Trading Bot',
            },
          });
        } catch (fallbackCallErr) {
          if (fallbackCallErr?.name === 'AbortError' || fallbackCallErr?.name === 'CanceledError' || fallbackCallErr?.code === 'ABORTED' || fallbackCallErr?.code === 'ERR_CANCELED') {
            console.log(`[llm] call aborted after ${LLM_TIMEOUT_MS}ms`);
          }
          throw fallbackCallErr;
        }
        console.log('[llm] OpenRouter fallback succeeded');
      } else {
        throw primaryErr; // Re-throw if not retryable or no fallback configured
      }
    }
    
    const content = res.data?.choices?.[0]?.message?.content || '';
    const parsed = strictJsonFromText(content);
    const selectedId = Number(parsed.selected_candidate_id);
    const selectedMint = String(parsed.selected_mint || '');
    // Try matching by candidate_id first, then by mint address
    let row = rows.find(item => item.id === selectedId);
    if (!row && selectedMint) {
      row = rows.find(item => item.candidate.token?.mint === selectedMint);
    }
    // Fallback: if LLM returned a symbol/name instead of mint, try partial match
    if (!row && selectedMint) {
      row = rows.find(item =>
        item.candidate.token?.symbol === selectedMint ||
        item.candidate.token?.name === selectedMint
      );
    }
    const selectedRoute = row?.candidate?.signals?.route || '';
    const decision = normalizeDecision(parsed, '', selectedRoute);
    if (decision.verdict === 'BUY' && !row) {
      console.log(`[llm] BUY verdict but no matching row: selectedId=${selectedId}, selectedMint=${selectedMint}, rows=${rows.map(r=>r.id).join(',')}`);
    }

    // Lesson 9: log verdict/confidence/route for PASS and BUY (post-hoc PASS vs BUY analysis)
    if (decision.verdict === 'PASS' || decision.verdict === 'BUY') {
      console.log(`[llm-metric] verdict=${decision.verdict} confidence=${decision.confidence} route=${selectedRoute}`);
    }

    // Lesson 8: act on WATCH verdicts — record them in signal_events for audit
    if (decision.verdict === 'WATCH') {
      const triggerRow = rows.find(item => item.id === triggerCandidateId) || row || rows[0];
      const watchMint = triggerRow?.candidate?.token?.mint || selectedMint;
      if (watchMint) {
        try {
          storeSignalEvent(watchMint, 'watch', 'llm', {
            verdict: 'WATCH',
            confidence: decision.confidence,
            reason: decision.reason,
          });
        } catch (err) {
          console.log(`[llm] storeSignalEvent(watch) failed: ${err.message}`);
        }
      }
    }
    return {
      ...decision,
      selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
      selected_mint: decision.verdict === 'BUY' && row ? row.candidate.token.mint : null,
      selected_row: decision.verdict === 'BUY' && row ? row : null,
    };
  } catch (err) {
    console.log(`[llm] batch failed: ${err.message}`);
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `LLM failed: ${err.message}`,
      risks: ['llm_error'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { error: err.message },
    };
  }
}

export async function decideCandidate(candidate) {
  const pseudoRow = { id: 0, candidate };
  const decision = await decideCandidateBatch([pseudoRow], 0);
  return normalizeDecision(decision.raw || decision, decision.reason, candidate?.signals?.route || '');
}
