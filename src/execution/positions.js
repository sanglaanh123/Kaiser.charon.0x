import { delayedQuote, validQuote, paperPnl, PAPER_VERSION, PAPER_FEE_LAMPORTS } from './paperSafety.js';
import { paperAudit } from '../db/paperAudit.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, strategyById, slippageAdjustedMcap } from '../db/settings.js';
import { db } from '../db/connection.js';
import { firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, computeAtrPercent, dynamicStopLossPercent } from '../utils.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterChartContext, fetchJupiterExecutionQuote, fetchSolUsdPriceCached } from '../enrichment/jupiter.js';
import { fetchChartContextCached, fetchTokenMarket, fetchHolders } from '../enrichment/market.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { openPositions, positionValue } from '../db/positions.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { trending } from '../signals/trending.js';
import { executeLiveSell } from './router.js';
import { sendPositionExit } from '../telegram/send.js';

export async function freshEntryMarket(mint, candidate) {
  const asset = await fetchTokenMarket(mint, { useCache: false, priority: 'entry' });
  // Reuse the GMGN payload fetchTokenMarket just fetched when it fell back to GMGN.
  const gmgn = await fetchGmgnTokenInfo(mint, asset?.source === 'gmgn');
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  return { gmgn, asset, priceUsd, marketCapUsd, refreshedAtMs: now() };
}

export async function refreshCandidateForExecution(row) {
  const candidate = row.candidate;
  const mint = candidate.token.mint;
  const route = candidate.signals?.route || '';
  const isFresh = route.includes('pumpportal_graduated');

  let gmgn, asset, holders, chart;

  if (isFresh) {
    // Fast path: skip GMGN (Cloudflare blocked) and chart (no data for freshly graduated)
    [asset, holders] = await Promise.all([
      fetchTokenMarket(mint, { useCache: false, priority: 'entry' }),
      fetchHolders(mint),
    ]);
    gmgn = null;
    chart = null;
  } else {
    [asset, holders] = await Promise.all([
      fetchTokenMarket(mint, { useCache: false, priority: 'entry' }),
      fetchHolders(mint),
    ]);
    // Cached when fetchTokenMarket already fell back to GMGN; fresh fetch otherwise.
    gmgn = await fetchGmgnTokenInfo(mint, asset?.source === 'gmgn');
    chart = null;  // chart not used in buy path — saves 10s timeout
  }
  const selectedTrending = trending.get(mint) || candidate.trending || null;
  const selectedHolders = holders?.holders?.length ? holders : candidate.holders;
  const selectedSavedWalletExposure = selectedHolders
    ? await fetchSavedWalletExposure(mint, selectedHolders)
    : candidate.savedWalletExposure;
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, selectedTrending?.price, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    selectedTrending?.market_cap,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  const refreshed = {
    ...candidate,
    token: {
      ...candidate.token,
      name: gmgn?.name || asset?.name || selectedTrending?.name || candidate.token.name,
      symbol: gmgn?.symbol || asset?.symbol || selectedTrending?.symbol || candidate.token.symbol,
      twitter: candidate.token.twitter || asset?.twitter || gmgn?.link?.twitter_username || selectedTrending?.twitter || '',
      website: candidate.token.website || asset?.website || gmgn?.link?.website || '',
      telegram: candidate.token.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      ...candidate.metrics,
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? candidate.metrics?.liquidityUsd ?? 0),
      holderCount: Number(gmgn?.holder_count ?? asset?.holderCount ?? selectedTrending?.holder_count ?? candidate.metrics?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? asset?.fees ?? candidate.metrics?.gmgnTotalFeesSol ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? candidate.metrics?.gmgnTradeFeesSol ?? 0),
      trendingVolumeUsd: Number(selectedTrending?.volume ?? candidate.metrics?.trendingVolumeUsd ?? 0),
      trendingSwaps: Number(selectedTrending?.swaps ?? candidate.metrics?.trendingSwaps ?? 0),
      trendingHotLevel: Number(selectedTrending?.hot_level ?? candidate.metrics?.trendingHotLevel ?? 0),
      trendingSmartDegenCount: Number(selectedTrending?.smart_degen_count ?? candidate.metrics?.trendingSmartDegenCount ?? 0),
    },
    gmgn,
    jupiterAsset: asset,
    marketSource: asset?.source || null,
    trending: selectedTrending,
    holders: selectedHolders,
    chart,
    savedWalletExposure: selectedSavedWalletExposure,
    executionRefresh: {
      refreshedAtMs: now(),
      source: 'pre_execution',
      marketCapUsd,
      priceUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? 0),
      holdersRefreshed: Boolean(holders?.holders?.length),
    },
  };
  refreshed.filters = filterCandidate(refreshed);
  const executionFailures = [];
  const freshPrice = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice);
  const freshMcap = firstPositiveNumber(marketCapFromGmgn(gmgn), asset?.mcap, asset?.fdv);
  if (!freshPrice || !freshMcap) executionFailures.push('execution fresh market data: missing');
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    executionFailures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    executionFailures.push('execution price: missing');
  }
  if (executionFailures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...executionFailures],
    };
  }
  updateCandidateSnapshot(row.id, refreshed, refreshed.filters.passed ? 'candidate' : 'filtered');
  return { ...row, candidate: refreshed };
}

const sellInProgress = new Set();

const PAPER_ROUNDTRIP_FEE_SOL = 2 * PAPER_FEE_LAMPORTS / 1e9; // matches paperPnl's entry + exit fee
const bigOf = (v) => /^\d+$/.test(String(v)) ? BigInt(String(v)) : BigInt(Math.floor(Number(v) || 0));
// Portion of an integer amount (percent may be fractional, 0.01% resolution).
const portion = (amount, percent) => bigOf(amount) * BigInt(Math.round(Number(percent) * 100)) / 10000n;

// Paper PnL for the remaining tokens plus banked partial proceeds. Plain paperPnl when nothing was banked.
function paperNet(entryLamports, outLamports, realizedPartialSol) {
  if (!(Number(realizedPartialSol) > 0)) return paperPnl(entryLamports, outLamports);
  return positionValue({
    remainingProceedsSol: Number(outLamports) / 1e9,
    realizedPartialSol,
    sizeSol: Number(entryLamports) / 1e9,
    feesSol: PAPER_ROUNDTRIP_FEE_SOL,
  });
}

// forceExitReason (e.g. 'MANUAL' from the Dry Sell button) closes through the same paper/live
// path as automatic exits, so fees, partial proceeds and the double-close guard all apply.
export async function refreshPosition(position, { autoExit = true, forceExitReason = null } = {}) {
  // Bug2 fix (2026-06-19): bypass 20s cache for live monitoring — flash crash detection requires fresh data
  // Quote-first: dry and live decisions share the same 10s per-mint executable quote snapshot.
  // Wallet-PnL remains telemetry only; it must not alter exit decisions.
  const useQuote = numSetting('exit_quote_enabled', 1);
  let paperSnapshot = {};
  try { paperSnapshot = JSON.parse(position.snapshot_json || '{}'); } catch {}
  const isPaper = position.execution_mode !== 'live';
  // Historical estimates cannot acquire execution evidence retroactively.
  if (isPaper && paperSnapshot.paperVersion !== PAPER_VERSION) {
    db.prepare('UPDATE dry_run_positions SET pnl_percent=NULL,pnl_sol=NULL WHERE id=? AND status=?').run(position.id, 'open');
    return { ...position, pnl_sol: null, pnl_percent: null, exitReason: null, valuationStatus: 'legacy_unverified' };
  }
  const exitPriority = isPaper ? 'exit_paper' : 'exit_live';
  // Jupiter datapi first, GMGN behind it, so a datapi outage doesn't blind the mark fallback.
  const asset = await fetchTokenMarket(position.mint, { useCache: false, ttlMs: 3000, priority: exitPriority });
  const tokenAmountRaw = isPaper ? paperSnapshot.tokenAmountRaw : position.token_amount_raw || position.token_amount_est;
  const realizedPartial = Number(position.realized_partial_sol || 0);
  const strat = strategyById(position.strategy_id);
  const sellQuote = useQuote && tokenAmountRaw
    ? await fetchJupiterExecutionQuote({ inputMint: position.mint, outputMint: 'So11111111111111111111111111111111111111112', amount: tokenAmountRaw }, { priority: exitPriority })
    : null;
  const sellRequest = { inputMint: position.mint, outputMint: 'So11111111111111111111111111111111111111112', amount: tokenAmountRaw };
  const quoteValid = Boolean(sellQuote) && validQuote(sellQuote, sellRequest);
  // Returning early here (pre-2026-10-23) froze the position for the whole quote
  // outage: no SL, no trailing, exit 9 points past the stop. Fall back to the asset
  // mark and flag the tick instead of skipping it.
  const valuationStatus = quoteValid ? 'quote' : 'mark_fallback';
  if (isPaper && !quoteValid && position.pnl_sol !== null) paperAudit(position.mint, 'valuation_mark_fallback', { positionId: position.id, reason: 'quote_missing_or_stale' });
  const solUsd = useQuote && sellQuote?.outAmount ? await fetchSolUsdPriceCached() : null;
  const quoteProceedsSol = sellQuote?.outAmount ? Number(sellQuote.outAmount) / 1e9 : null;
  const quotePrice = quoteProceedsSol && solUsd && Number(tokenAmountRaw) > 0
    ? (quoteProceedsSol * Number(solUsd)) / (Number(tokenAmountRaw) / (10 ** Number(asset?.decimals ?? 9)))
    : null;
  const quoteMcap = quotePrice && Number(position.entry_price) > 0
    ? Number(position.entry_mcap) * (quotePrice / Number(position.entry_price))
    : null;
  const jupiterPrice = Number(asset?.usdPrice);
  const jupiterMcap = firstPositiveNumber(asset?.mcap, asset?.fdv);
  // Guard 1 DISABLED (2026-07-17): can't distinguish crash vs stale data — single source (Jupiter) is unreliable
  const price = firstPositiveNumber(quotePrice, jupiterPrice || null, position.high_water_price, position.entry_price);
  let mcap = firstPositiveNumber(quoteMcap, jupiterMcap, position.high_water_mcap, position.entry_mcap);
  if (!Number.isFinite(Number(mcap)) || !Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) {
    return null;
  }
  // Guard 2 DISABLED (2026-07-17): drop >80% heuristic can't distinguish crash vs stale bonding curve data
  let highWaterMcap = Math.max(Number(position.high_water_mcap || 0), Number(mcap));
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  let pnlPercent = (Number(mcap) / Number(position.entry_mcap) - 1) * 100;
  const markPnlPercent = pnlPercent;
  let pnlSol = Number(position.size_sol) * pnlPercent / 100;
  if (quoteProceedsSol != null && Number(position.size_sol) > 0) {
    ({ pnlSol, pnlPercent } = positionValue({ remainingProceedsSol: quoteProceedsSol, realizedPartialSol: realizedPartial, sizeSol: position.size_sol }));
  } else if (position.partial_tp_done && Number(position.size_sol) > 0) {
    // Mark fallback after a partial: value the remaining fraction at the mark, add banked proceeds.
    const remainingFraction = 1 - Number(strat?.partial_tp_sell_percent || 0) / 100;
    ({ pnlSol, pnlPercent } = positionValue({ remainingProceedsSol: Number(position.size_sol) * remainingFraction * (1 + markPnlPercent / 100), realizedPartialSol: realizedPartial, sizeSol: position.size_sol }));
  }

  if (isPaper) {
    if (quoteValid) {
      const net = paperNet(paperSnapshot.entryLamports, sellQuote.outAmount, realizedPartial);
      pnlSol = net.pnlSol; pnlPercent = net.pnlPercent;
    }
    // Use SOL quote returns for triggers and trailing, never the inferred USD supply.
    mcap = Number(position.entry_mcap) * (1 + pnlPercent / 100);
    highWaterMcap = Math.max(Number(position.high_water_mcap || 0), mcap);
  }

  // Dynamic ATR-based stop loss: fetch chart context and compute ATR% to widen/narrow the static sl_percent.
  const stratForSl = strat;
  const useDynamicSl = (stratForSl?.use_dynamic_sl ?? numSetting('use_dynamic_sl', 1)) ? true : false;
  let effectiveSlPercent = Number(position.sl_percent);
  let atrPercent = null;
  if (useDynamicSl) {
    try {
      const chart = await fetchChartContextCached(position.mint);
      const windows = Array.isArray(chart?.windows) ? chart.windows : [];
      atrPercent = computeAtrPercent(windows, numSetting('atr_period', 14));
      effectiveSlPercent = dynamicStopLossPercent({
        baseSlPercent: Number(position.sl_percent),
        atrPercent,
        multiplier: Number(stratForSl?.atr_sl_multiplier ?? numSetting('atr_sl_multiplier', 1.5)),
        floorPercent: Number(stratForSl?.atr_sl_floor_percent ?? numSetting('atr_sl_floor_percent', -50)),
        ceilingPercent: Number(stratForSl?.atr_sl_ceiling_percent ?? numSetting('atr_sl_ceiling_percent', -8)),
        minAtrPercent: Number(stratForSl?.atr_sl_min_atr_percent ?? numSetting('atr_sl_min_atr_percent', 4)),
        maxAtrPercent: Number(stratForSl?.atr_sl_max_atr_percent ?? numSetting('atr_sl_max_atr_percent', 30)),
      });
    } catch (err) {
      console.log(`[atr] chart refresh failed for ${position.mint.slice(0, 8)}... ${err.message}`);
    }
  }
  const tpHit = pnlPercent >= Number(position.tp_percent);
  const slHit = pnlPercent <= effectiveSlPercent && pnlPercent < 0; // Lesson 3: don't SL if PnL positive
  const armThreshold = numSetting('trailing_arm_percent', Number(position.tp_percent));
  const armHit = pnlPercent >= armThreshold;
  const trailingArmed = position.trailing_armed || (position.trailing_enabled && armHit);
  const trailDrop = highWaterMcap > 0 ? (Number(mcap) / highWaterMcap - 1) * 100 : 0;
  // EXIT-FIX 2026-07-25 (backtest 933 trades 07-22..25: base +1,685% -> +8,766% ideal / +6,314% gap).
  // (1) TIGHT TRAIL: once peak pnl >= trailing_tight_from_percent (40), trail tightens from
  //     trailing_percent (10) to trailing_tight_percent (5). Rescues armed winners that round-trip
  //     to SL (97 armed+SL trades = -6,497% pnl in window).
  // (2) FLOOR: once armed, trailing may not exit below trailing_floor_percent (+8). Kills the
  //     +1.7% "gap-dump between 3s ticks" exits (dump lands below arm before next check).
  // Partial@arm REJECTED by backtest (-867%): caps the runners that carry total profit.
  const peakPnl = Number(position.entry_mcap) > 0
    ? (highWaterMcap / Number(position.entry_mcap) - 1) * 100
    : pnlPercent;
  const tightFrom = numSetting('trailing_tight_from_percent', 40);
  const effectiveTrailPct = peakPnl >= tightFrom
    ? numSetting('trailing_tight_percent', 5)
    : Math.abs(Number(position.trailing_percent));
  const trailingFloor = numSetting('trailing_floor_percent', 8);
  // Trailing stop triggers if price drops from high water mark by effectiveTrailPct,
  // OR if an armed position pulls back to/below the trailing floor (protecting armed profit).
  const trailingHit = trailingArmed && position.trailing_enabled && (trailDrop <= -effectiveTrailPct || pnlPercent <= trailingFloor);
  let exitReason = forceExitReason || null;
  let closed = false;

  // Max hold time check — tiered by entry mcap
  const entryMcap = Number(position.entry_mcap) || 0;
  const isMicrocap = entryMcap > 0 && entryMcap < 15000;
  const isHighcap = entryMcap >= 60000;
  let effectiveMaxHold = strat?.max_hold_ms ?? 0;
  // === AUDIT MODE: tiered max_hold disabled for 3-day data collection (2026-07-05) ===
  // if (isMicrocap) {
  //   effectiveMaxHold = 600000; // 10 min for microcap <15K
  //   console.log(`[position] microcap <15K — max_hold reduced to 10min`);
  // } else if (isHighcap) {
  //   effectiveMaxHold = 900000; // 15 min for highcap >60K
  //   console.log(`[position] highcap >60K — max_hold reduced to 15min`);
  // }
  if (!exitReason && effectiveMaxHold > 0 && (now() - position.opened_at_ms) >= effectiveMaxHold) {
    exitReason = 'MAX_HOLD';
  }

  // Sideways timeout: if open too long with negligible PnL, exit to free up capital.
  if (!exitReason) {
    const sidewaysMinutes = Number(strat?.sideways_timeout_minutes ?? numSetting('sideways_timeout_minutes', 0));
    if (sidewaysMinutes > 0) {
      const ageSeconds = (now() - position.opened_at_ms) / 1000;
      if (ageSeconds > sidewaysMinutes * 60 && Math.abs(pnlPercent) < 2) {
        exitReason = 'SIDEWAYS_TIMEOUT';
      }
    }
  }

  // Partial TP: sell a slice, bank the proceeds, and skip every other exit check this tick.
  let partialDone = false;
  if (!exitReason && autoExit && strat?.partial_tp && !position.partial_tp_done && pnlPercent >= strat.partial_tp_at_percent) {
    const sellPct = Number(strat.partial_tp_sell_percent);
    try {
      if (!(sellPct > 0 && sellPct < 100)) throw new Error(`invalid partial_tp_sell_percent ${strat.partial_tp_sell_percent}`);
      if (!isPaper) {
        if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
        const sellAmount = portion(tokenAmountRaw, sellPct);
        if (sellAmount > 0n) {
          sellInProgress.add(position.id);
          let sell;
          try { sell = await executeLiveSell({ ...position, token_amount_raw: String(sellAmount) }, 'PARTIAL_TP'); }
          finally { sellInProgress.delete(position.id); }
          const soldRaw = bigOf(sell.inputAmount ?? sellAmount);
          const remaining = bigOf(tokenAmountRaw) - soldRaw;
          const gotSol = Number(sell.outputAmount || 0) / 1e9;
          db.prepare('UPDATE dry_run_positions SET token_amount_raw = ?, partial_tp_done = 1, realized_partial_sol = COALESCE(realized_partial_sol, 0) + ? WHERE id = ?')
            .run(String(remaining), gotSol, position.id);
          db.prepare(`
            INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
            VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
          `).run(position.id, position.mint, now(), price, mcap, position.size_sol * sellPct / 100, Number(soldRaw),
            json({ pnlPercent, sell, partialSellPercent: sellPct, remaining: String(remaining), receivedSol: gotSol }));
          console.log(`[position] ${position.id} partial TP at ${pnlPercent.toFixed(1)}%: sold ${soldRaw} tokens for ${gotSol} SOL, ${remaining} remaining`);
          partialDone = true;
        }
      } else if (quoteValid) {
        const soldRaw = portion(tokenAmountRaw, sellPct);
        const gotLamports = portion(sellQuote.outAmount, sellPct);
        if (soldRaw > 0n && gotLamports > 0n) {
          const remaining = bigOf(tokenAmountRaw) - soldRaw;
          const gotSol = Number(gotLamports) / 1e9;
          const snap = { ...paperSnapshot, tokenAmountRaw: String(remaining) };
          db.transaction(() => {
            db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1, realized_partial_sol = COALESCE(realized_partial_sol, 0) + ?, snapshot_json = ? WHERE id = ? AND status = ?')
              .run(gotSol, json(snap), position.id, 'open');
            db.prepare(`
              INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
              VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
            `).run(position.id, position.mint, now(), price, mcap, position.size_sol * sellPct / 100, Number(soldRaw),
              json({ pnlPercent, partialSellPercent: sellPct, remaining: String(remaining), proceedsLamports: String(gotLamports), exitQuote: sellQuote }));
          })();
          paperAudit(position.mint, 'partial_tp_filled', { positionId: position.id, soldRaw: String(soldRaw), proceedsLamports: String(gotLamports), remaining: String(remaining) });
          console.log(`[position] ${position.id} paper partial TP at ${pnlPercent.toFixed(1)}%: ${gotSol} SOL banked, ${remaining} tokens remaining`);
          partialDone = true;
        }
      }
    } catch (err) {
      console.log(`[position] ${position.id} partial sell failed: ${err.message}`);
    }
  }

  // Standard exit checks: trailing/floor exits take priority for armed winners
  if (!exitReason && !partialDone) {
    if (trailingHit) exitReason = 'TRAILING_TP';
    else if (slHit) exitReason = 'SL';
    else if (tpHit && !position.trailing_enabled) exitReason = 'TP';
  }


  // Live exits will override these with realized SOL values
  let finalPnlPercent = pnlPercent;
  let finalPnlSol = pnlSol;

  db.prepare(`
    UPDATE dry_run_positions
    SET high_water_mcap = ?, high_water_price = ?, trailing_armed = ?,
        pnl_percent = ?, pnl_sol = ?
    WHERE id = ?
  `).run(highWaterMcap, highWaterPrice, trailingArmed ? 1 : 0, pnlPercent, pnlSol, position.id);

  if (exitReason && autoExit && position.execution_mode === 'live') {
    if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
    sellInProgress.add(position.id);
    let sell;
    try {
      sell = await executeLiveSell(position, exitReason);
    } finally {
      sellInProgress.delete(position.id);
    }
    const receivedLamports = Number(sell.outputAmount || 0);
    const receivedSol = receivedLamports > 0 ? receivedLamports / 1_000_000_000 : null;
    if (receivedSol != null) {
      let entrySwap = null;
      try { entrySwap = JSON.parse(position.snapshot_json || '{}').swap; } catch {}
      const executionFeesSol = (
        Number(entrySwap?.order?.signatureFeeLamports || 0) +
        Number(entrySwap?.order?.prioritizationFeeLamports || 0) +
        Number(sell.order?.signatureFeeLamports || 0) +
        Number(sell.order?.prioritizationFeeLamports || 0)
      ) / 1_000_000_000;
      ({ pnlSol: finalPnlSol, pnlPercent: finalPnlPercent } = positionValue({
        remainingProceedsSol: receivedSol, realizedPartialSol: realizedPartial, sizeSol: position.size_sol, feesSol: executionFeesSol,
      }));
    }
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, sell.signature, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, receivedSol: receivedSol ?? null, sell, effectiveSlPercent, atrPercent, baseSlPercent: Number(position.sl_percent) }));
    closed = true;
  } else if (exitReason && autoExit) {
    let execution = null;
    if (quoteValid) {
      try { execution = await delayedQuote(sellRequest, (r) => fetchJupiterExecutionQuote(r, { priority: exitPriority }), { reference: sellQuote }); }
      catch (error) { paperAudit(position.mint, 'exit_rejected', { positionId: position.id, reason: error.message, trigger: exitReason }); }
    }
    // A stop that cannot find a quote must still close: mark-fill it and keep the
    // evidence labelled, otherwise the loss runs unmonitored until quotes return.
    const net = execution ? paperNet(paperSnapshot.entryLamports, execution.fill.outAmount, realizedPartial) : null;
    // Mark-based PnL (no valid quote this tick) carries no fees; charge the paper roundtrip
    // so the paper wallet never ends up richer than a live wallet would.
    const markFeeSol = !net && !quoteValid ? PAPER_ROUNDTRIP_FEE_SOL : 0;
    const dryPnlSol = net ? net.pnlSol : pnlSol - markFeeSol;
    const dryPnlPercent = net ? net.pnlPercent : (Number(position.size_sol) > 0 ? dryPnlSol / Number(position.size_sol) * 100 : pnlPercent);
    const dryExitMcap = net ? Number(position.entry_mcap) * (1 + dryPnlPercent / 100) : mcap;
    const dryExitPrice = net && !position.partial_tp_done ? Number(position.entry_price) * Number(execution.fill.outAmount) / Number(paperSnapshot.entryLamports) : price;
    const evidence = net
      ? { paperVersion: PAPER_VERSION, pnlPercent: dryPnlPercent, pnlSol: dryPnlSol, ...net, entryLamports: paperSnapshot.entryLamports, proceedsLamports: execution.fill.outAmount, realizedPartialSol: realizedPartial, paperFeeLamportsPerLeg: String(PAPER_FEE_LAMPORTS), referenceQuote: execution.reference, exitQuote: execution.fill }
      : { paperVersion: `${PAPER_VERSION}+mark-fallback`, pnlPercent: dryPnlPercent, pnlSol: dryPnlSol, exitMarkPrice: price, exitMarkMcap: mcap, reason: 'quote_unavailable' };
    const closedNow = db.transaction(() => {
      const changed = db.prepare(`UPDATE dry_run_positions SET status='closed',closed_at_ms=?,exit_price=?,exit_mcap=?,exit_reason=?,pnl_percent=?,pnl_sol=? WHERE id=? AND status='open'`).run(now(), dryExitPrice, dryExitMcap, exitReason, dryPnlPercent, dryPnlSol, position.id).changes;
      if (!changed) return false;
      db.prepare(`INSERT INTO dry_run_trades(position_id,mint,side,at_ms,price,mcap,size_sol,token_amount_est,reason,payload_json) VALUES(?,?,'sell',?,?,?,?,?,?,?)`).run(position.id, position.mint, now(), dryExitPrice, dryExitMcap, position.size_sol, tokenAmountRaw, exitReason, json(evidence));
      paperAudit(position.mint, net ? 'exit_filled' : 'exit_filled_mark_fallback', { positionId: position.id, ...evidence });
      return true;
    })();
    if (!closedNow) return { ...position, exitReason: null };
    finalPnlPercent = dryPnlPercent;
    finalPnlSol = dryPnlSol;
    closed = true;
  }
  return {
    ...position,
    status: closed ? 'closed' : position.status,
    closed_at_ms: closed ? now() : position.closed_at_ms,
    asset,
    price,
    mcap,
    highWaterMcap,
    high_water_mcap: highWaterMcap,
    high_water_price: highWaterPrice,
    pnlPercent: finalPnlPercent,
    pnl_percent: finalPnlPercent,
    pnlSol: finalPnlSol,
    pnl_sol: finalPnlSol,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : position.exit_reason,
    exit_mcap: closed ? mcap : position.exit_mcap,
    exit_price: closed ? price : position.exit_price,
    valuationStatus,
  };
}

export async function monitorPositions() {
  const positions = openPositions();
  for (const position of positions) {
    const result = await refreshPosition(position, { autoExit: true }).catch((err) => {
      console.log(`[position] ${position.id} ${err.message}`);
      return null;
    });
    if (result?.exitReason) await sendPositionExit(result);
  }
}
