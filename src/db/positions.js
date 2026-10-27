import { delayedQuote, PAPER_VERSION, PAPER_FEE_LAMPORTS } from '../execution/paperSafety.js';
import { paperEntryCheck } from './paperWallet.js';
import { paperAudit } from './paperAudit.js';
import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy, slippageAdjustedMcap } from './settings.js';
import { fetchJupiterExecutionQuote, fetchSolUsdPriceCached } from '../enrichment/jupiter.js';
import { WSOL_MINT } from '../config.js';
import { getCachedDecimals } from '../enrichment/market.js';

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export function openPositionCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
}

export function hasClosedPosition(mint) {
  const row = db.prepare(`
    SELECT 1 FROM dry_run_positions WHERE mint = ? AND status = 'closed' LIMIT 1
  `).get(mint);
  return !!row;
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

export const WIN_BLOCK_DAYS = 7;

// Shared entry gate (paper + live): null, or { reason, id, ... } when a new entry on this mint must be blocked.
export function entryBlockReason(mint) {
  const open = db.prepare(`SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1`).get(mint);
  if (open) return { reason: 'open_position', id: open.id };
  const recent = db.prepare(`
    SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND closed_at_ms > ? LIMIT 1
  `).get(mint, now() - 86400000);
  if (recent) return { reason: 'recently_closed', id: recent.id };
  const win = db.prepare(`
    SELECT id, pnl_sol, closed_at_ms FROM dry_run_positions
    WHERE mint = ? AND status = 'closed' AND pnl_percent > 0 AND closed_at_ms > ?
    ORDER BY closed_at_ms DESC LIMIT 1
  `).get(mint, now() - WIN_BLOCK_DAYS * 86400000);
  if (win) return { reason: 'past_win', id: win.id, pnlSol: win.pnl_sol, closedAtMs: win.closed_at_ms };
  return null;
}

// Entry size after risk-severity halving; shared by paper, live buy, live record and failed-entry rows.
export function positionSizeSol(candidate, strat = activeStrategy()) {
  let sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const riskFlags = candidate?.riskFlags || [];
  const totalRiskSeverity = riskFlags.reduce((sum, flag) => sum + (flag.severity || 0), 0);
  if (totalRiskSeverity >= 2) {
    // High risk (severity >=2) -> cut size to 50%
    const originalSize = sizeSol;
    sizeSol *= 0.5;
    console.log(`[position] risk-adjusted size: ${originalSize} -> ${sizeSol} SOL (total risk severity: ${totalRiskSeverity}, flags: ${riskFlags.map(f => f.type).join(', ')})`);
  }
  return sizeSol;
}

// Pure valuation: remaining-position proceeds plus banked partial proceeds vs cost.
export function positionValue({ remainingProceedsSol, realizedPartialSol = 0, sizeSol, feesSol = 0 }) {
  const size = Number(sizeSol);
  const pnlSol = Number(remainingProceedsSol || 0) + Number(realizedPartialSol || 0) - size - Number(feesSol || 0);
  return { pnlSol, pnlPercent: size > 0 ? pnlSol / size * 100 : 0 };
}

export async function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const strat = activeStrategy();
  const sizeSol = positionSizeSol(candidate, strat);
  const amountLamports = Math.floor(sizeSol * 1_000_000_000);
  let entryQuote, referenceQuote;
  const entryQuoteRequest = { inputMint: WSOL_MINT, outputMint: candidate.token.mint, amount: amountLamports };
  const entryFetcher = (request) => fetchJupiterExecutionQuote(request, { waitOutBackoff: true });
  try {
    const result = await delayedQuote(entryQuoteRequest, entryFetcher, { attempts: 3 });
    entryQuote = result.fill; referenceQuote = result.reference;
  } catch (error) {
    paperAudit(candidate.token.mint, 'entry_rejected', { reason: error.message, candidateId, ...(error.detail || {}) });
    throw error;
  }
  const tokenAmountRaw = String(entryQuote.outAmount);
  const solUsd = await fetchSolUsdPriceCached();
  const tokenDecimals = Number(candidate.jupiterAsset?.decimals ?? candidate.metrics.decimals);
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) {
    paperAudit(candidate.token.mint, 'entry_rejected', { reason: 'missing_token_decimals', candidateId });
    throw new Error('missing_token_decimals');
  }
  if (!Number.isFinite(Number(solUsd)) || Number(solUsd) <= 0) {
    paperAudit(candidate.token.mint, 'entry_rejected', { reason: 'missing_sol_usd_price', candidateId });
    throw new Error('missing_sol_usd_price');
  }
  const tokenAmount = tokenAmountRaw ? Number(tokenAmountRaw) / (10 ** Math.max(0, Math.min(18, tokenDecimals))) : 0;
  const entryPrice = tokenAmount > 0 && Number(solUsd) > 0
    ? (sizeSol * Number(solUsd)) / tokenAmount
    : Number(candidate.metrics.priceUsd || 0) || null;
  let entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  entryMcap = slippageAdjustedMcap(entryMcap, 'entry');
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  const placed = db.transaction(() => {
    if (tradingMode() !== 'dry_run' || !canOpenMorePositions()) throw new Error('paper_mode_or_position_limit_changed');
    const wallet = paperEntryCheck(sizeSol);
    if (!wallet.ok) return { rejected: wallet }; // audit outside the txn so it survives
    const blocked = entryBlockReason(candidate.token.mint);
    if (blocked) {
      if (blocked.reason === 'open_position') return { id: blocked.id, isNew: false };
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — ${blocked.reason}`);
      if (blocked.reason === 'past_win') return { id: blocked.id, isNew: false, blockedBy: 'past_win', pastWinPnlSol: blocked.pnlSol, pastWinClosedAtMs: blocked.closedAtMs };
      return { id: blocked.id, isNew: false };
    }

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      tokenAmountRaw,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      strat.id,
      json({ candidate, decision, reason, strategy: strat.id, strategyConfig: strat, paperVersion: PAPER_VERSION, entryLamports: String(amountLamports), tokenAmountRaw, paperFeeLamportsPerLeg: String(PAPER_FEE_LAMPORTS), rentAccounting: 'ata_rent_locked_until_close', entryQuote, referenceQuote }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, tokenAmountRaw, reason, json({ candidateId, decision, entryQuote }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    paperAudit(candidate.token.mint, 'entry_filled', { positionId, candidateId, entryLamports: String(amountLamports), tokenAmountRaw, entryQuote, referenceQuote });
    return { id: positionId, isNew: true };
  })();
  if (placed.rejected) {
    paperAudit(candidate.token.mint, 'entry_rejected', { reason: 'paper_insufficient_balance', availableSol: placed.rejected.availableSol, needSol: placed.rejected.needSol, candidateId });
    throw new Error('paper_insufficient_balance');
  }
  return placed;
}

// Fill-based entry price (USD per token) from the executed swap; null if any input is missing.
async function liveFillPrice(candidate, swap) {
  try {
    const lamports = Number(swap?.inputAmount);
    const raw = Number(swap?.outputAmount);
    if (!(lamports > 0) || !(raw > 0)) return null;
    const decimals = Number(candidate.jupiterAsset?.decimals ?? candidate.metrics?.decimals ?? getCachedDecimals(candidate.token.mint));
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
    const solUsd = Number(await fetchSolUsdPriceCached());
    if (!(solUsd > 0)) return null;
    const price = (lamports / 1e9 * solUsd) / (raw / (10 ** decimals));
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch { return null; }
}

// Called only after a FILLED swap: always inserts an open row (tokens are already in the wallet).
export async function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  const strat = activeStrategy();
  const sizeSol = positionSizeSol(candidate, strat);
  const signalPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const signalMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const fillPrice = await liveFillPrice(candidate, swap);
  const entryPrice = fillPrice ?? signalPrice;
  const entryMcap = fillPrice && signalPrice && signalMcap ? signalMcap * (fillPrice / signalPrice) : signalMcap;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const conflict = entryBlockReason(candidate.token.mint);
    if (conflict) console.log(`[positions] post_swap_gate_conflict ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — ${conflict.reason} #${conflict.id}; inserting anyway (swap filled)`);

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
        execution_mode, entry_signature, token_amount_raw, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'live', ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      swap.signature,
      swap.outputAmount || null,
      strat.id,
      json({ candidate, decision, reason, swap, strategy: strat.id, signalPrice, signalMcap, fillPrice, postSwapGateConflict: conflict || null }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision, swap }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return { id: positionId, isNew: true };
  })();
}

// Audit row for a live entry whose swap never filled. Always a fresh closed row; never touches existing rows.
export function recordFailedEntry(candidateId, candidate, decision, { error, sizeSol, attempts } = {}) {
  const strat = activeStrategy();
  const size = sizeSol ?? positionSizeSol(candidate, strat);
  const t = now();
  return db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, closed_at_ms, size_sol, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, exit_reason, pnl_percent, pnl_sol,
        llm_decision_id, execution_mode, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'closed', ?, ?, ?, 0, 0, 0, 0, 0, 'FAILED_ENTRY', 0, 0, ?, 'live', ?, ?)
    `).run(candidateId, candidate.token.mint, candidate.token.symbol, t, t, size, decision?.id || null, strat.id,
      json({ candidate, decision, reason: 'FAILED_ENTRY', error: error || 'unknown', attempts: attempts ?? null }));
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, 'FAILED_ENTRY', ?)
    `).run(positionId, candidate.token.mint, t, null, null, size, null, json({ attempts: attempts ?? null, error: error || 'unknown' }));
    return { id: positionId };
  })();
}
