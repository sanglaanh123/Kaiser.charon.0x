import { now, json } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { WSOL_MINT, LIVE_MIN_SOL_RESERVE_LAMPORTS, ENTRY_FRESHNESS_GATE_PCT, ENTRY_FRESHNESS_GATE_SHADOW } from '../config.js';
import { escapeHtml, fmtSol } from '../format.js';
import { executeJupiterSwap, liveWalletBalanceLamports, fetchLiveTokenBalance, closeEmptyTokenAccounts } from '../liveExecutor.js';
import { activeStrategy } from '../db/settings.js';
import { createLivePosition, recordFailedEntry, entryBlockReason, positionSizeSol, canOpenMorePositions, openPositionCount } from '../db/positions.js';
import { intentById } from '../db/intents.js';
import { logDecisionEvent } from '../db/decisions.js';
import { refreshCandidateForExecution } from './positions.js';
import { bot } from '../telegram/bot.js';
import { candidateSummary } from '../telegram/format.js';
import { sendPositionOpen, sendTelegram } from '../telegram/send.js';
import { updateCandidateStatus } from '../db/candidates.js';
import { createTradeIntent } from '../db/intents.js';

const ENTRY_MAX_ATTEMPTS = 3;

// Test seam for the chain-facing calls.
const deps = { executeJupiterSwap, fetchLiveTokenBalance };
export function _setLiveDeps(next = {}) { Object.assign(deps, { executeJupiterSwap, fetchLiveTokenBalance }, next); }

// Serialises gate -> swap -> insert so two buys on one mint can't both pass the gate.
let entryChain = Promise.resolve();
function withEntryLock(fn) {
  const run = entryChain.then(fn, fn);
  entryChain = run.catch(() => {});
  return run;
}

// Freshness gate: bandingkan harga sinyal (candidate.metrics.priceUsd) dengan harga fill dari
// quote Jupiter (order.inUsdValue / (order.outAmount / 10^decimals)). Kalau drift > ENTRY_FRESHNESS_GATE_PCT%
// BUY dibatalkan SEBELUM sign/broadcast (return early, alasan 'stale_signal'), route TIDAK di-disable.
// Return null kalau gate nonaktif atau data tidak cukup (fail-open: jangan blokir trade tanpa data).
function entryFreshnessGuard(candidate) {
  const threshold = Number(ENTRY_FRESHNESS_GATE_PCT);
  if (!Number.isFinite(threshold) || threshold <= 0) return null; // gate nonaktif
  const signalPrice = Number(candidate?.metrics?.priceUsd);
  if (!Number.isFinite(signalPrice) || signalPrice <= 0) return null; // tak ada harga sinyal
  const decimals = Number(candidate?.jupiterAsset?.decimals ?? 9);
  return (order) => {
    const inUsd = Number(order?.inUsdValue);
    const outRaw = Number(order?.outAmount);
    if (!Number.isFinite(inUsd) || inUsd <= 0 || !Number.isFinite(outRaw) || outRaw <= 0) return null;
    const tokensOut = outRaw / (10 ** decimals);
    if (!(tokensOut > 0)) return null;
    const fillPrice = inUsd / tokensOut;
    const driftPct = (fillPrice / signalPrice - 1) * 100;
    if (driftPct > threshold) {
      const reason = `stale_signal: drift ${driftPct.toFixed(2)}% > gate ${threshold}% (signal $${signalPrice} -> fill $${fillPrice})`;
      if (ENTRY_FRESHNESS_GATE_SHADOW) {
        console.log(`[freshness-gate][shadow] ${candidate?.token?.mint?.slice(0, 8)}... ${reason}`);
        return null; // shadow: catat saja, jangan blokir
      }
      return reason;
    }
    return null;
  };
}

export function executeLiveBuy(...args) {
  return withEntryLock(() => executeLiveBuyLocked(...args));
}

async function executeLiveBuyLocked(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const sizeSol = positionSizeSol(selectedRow.candidate);
  const amountLamports = Math.floor(sizeSol * 1_000_000_000);
  const balance = await liveWalletBalanceLamports();
  if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
    throw new Error(`Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL including reserve.`);
  }
  const candidate = selectedRow.candidate;

  // Shared gate BEFORE any swap: open position, closed <24h, or recent win.
  const gate = entryBlockReason(candidate.token.mint);
  if (gate) {
    const err = new Error(`Entry blocked (${gate.reason}): ${candidate.token.symbol || candidate.token.mint.slice(0, 8)} position #${gate.id}`);
    console.log(`[executeLiveBuy] ${err.message}`);
    logDecisionEvent({
      batchId, triggerCandidateId, selectedRow, rows, decision,
      mode: 'live', action: 'live_entry_blocked_gate',
      guardrails: { gate },
      execution: { error: err.message },
    });
    throw err;
  }

  let swap = null;
  let lastError = null;
  let staleSignal = null;
  for (let attempt = 1; attempt <= ENTRY_MAX_ATTEMPTS; attempt++) {
    try {
      swap = await deps.executeJupiterSwap({
        inputMint: WSOL_MINT,
        outputMint: candidate.token.mint,
        amount: amountLamports,
        guard: entryFreshnessGuard(candidate),
      });
      if (!swap.outputAmount) {
        swap.outputAmount = await deps.fetchLiveTokenBalance(candidate.token.mint) || swap.outputAmount;
      }
      lastError = null;
      break;
    } catch (err) {
      if (err.code === 'STALE_SIGNAL_GUARD') {
        staleSignal = err; // harga sinyal basi — jangan retry, harga akan makin jauh
        break;
      }
      lastError = err;
      console.log(`[executeLiveBuy] attempt ${attempt}/${ENTRY_MAX_ATTEMPTS} failed for ${candidate.token.mint.slice(0, 8)}... ${err.message}`);
      if (attempt < ENTRY_MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
  }
  if (!swap && staleSignal) {
    // Freshness gate: skip trade. Tidak ada posisi dibuat, tidak ada dana terpakai,
    // route tetap aktif untuk token berikutnya.
    const msg = staleSignal.message;
    console.log(`[executeLiveBuy] SKIP ${candidate.token.mint.slice(0, 8)}... ${msg}`);
    updateCandidateStatus(selectedRow.id, 'stale_signal');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow,
      rows,
      decision,
      mode: 'live',
      action: 'live_entry_skipped_stale_signal',
      guardrails: { freshnessGatePct: ENTRY_FRESHNESS_GATE_PCT, signalPriceUsd: Number(candidate?.metrics?.priceUsd) },
      execution: { reason: 'stale_signal', detail: msg },
    });
    await sendTelegram([
      '⏭️ <b>Live entry skipped (stale signal)</b>',
      '',
      candidateSummary(candidate, decision),
      '',
      escapeHtml(msg),
    ].join('\n'));
    return;
  }
  if (!swap) {
    // Record the failed attempt as a closed position so the failure is auditable.
    const { id: positionId } = recordFailedEntry(selectedRow.id, candidate, decision, { error: lastError?.message || 'unknown', sizeSol, attempts: ENTRY_MAX_ATTEMPTS });
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow,
      rows,
      decision,
      mode: 'live',
      action: 'live_entry_failed',
      guardrails: { balanceLamports: balance, amountLamports, minReserveLamports: LIVE_MIN_SOL_RESERVE_LAMPORTS, attempts: ENTRY_MAX_ATTEMPTS },
      execution: { positionId, error: lastError?.message || 'unknown' },
    });
    await sendTelegram([
      '🛑 <b>Live entry failed after retries</b>',
      '',
      candidateSummary(candidate, decision),
      '',
      `Attempts: ${ENTRY_MAX_ATTEMPTS}`,
      `Error: ${escapeHtml(lastError?.message || 'unknown')}`,
      `Position #${positionId} recorded as FAILED_ENTRY.`,
    ].join('\n'));
    throw lastError || new Error('Live buy failed without exception');
  }
  const { id: positionId, isNew } = await createLivePosition(selectedRow.id, candidate, decision, swap, `live_batch_${batchId}`);
  logDecisionEvent({
    batchId,
    triggerCandidateId,
    selectedRow,
    rows,
    decision,
    mode: 'live',
    action: 'live_entry_executed',
    guardrails: { balanceLamports: balance, amountLamports, minReserveLamports: LIVE_MIN_SOL_RESERVE_LAMPORTS },
    execution: { positionId, isNew, swap },
  });
  if (isNew) await sendPositionOpen(positionId);
}

const toBig = (v) => /^\d+$/.test(String(v)) ? BigInt(String(v)) : BigInt(Math.floor(Number(v) || 0));

export async function executeLiveSell(position, reason) {
  let amount = position.token_amount_raw || position.token_amount_est;
  if (!amount || Number(amount) <= 0) throw new Error('Live position has no token amount to sell.');
  // Never sell more than the wallet holds (partial sells / external transfers leave the DB amount stale).
  const balance = await deps.fetchLiveTokenBalance(position.mint);
  if (balance != null) {
    const held = toBig(balance);
    if (held <= 0n) throw new Error(`Live wallet holds 0 of ${position.mint.slice(0, 8)}...; nothing to sell.`);
    const want = toBig(amount);
    if (held < want) console.log(`[live] sell clamp ${position.mint.slice(0, 8)}... ${want} -> ${held} (wallet balance)`);
    amount = String(held < want ? held : want);
  }
  const sell = await deps.executeJupiterSwap({
    inputMint: position.mint,
    outputMint: WSOL_MINT,
    amount,
    priority: 'exit_live',
  });
  try {
    sell.closeAccountSignature = await closeEmptyTokenAccounts(position.mint);
  } catch (err) {
    // Rent cleanup must never turn a successful sell into a failed position close.
    console.log(`[live] close empty token account ${position.mint.slice(0, 8)}... ${err.message}`);
  }
  return sell;
}

export function executeConfirmedIntent(chatId, intentId) {
  return withEntryLock(() => executeConfirmedIntentLocked(chatId, intentId));
}

async function executeConfirmedIntentLocked(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent || intent.status !== 'pending_confirmation') return bot.sendMessage(chatId, 'Pending intent not found.');
  if (!canOpenMorePositions()) {
    return bot.sendMessage(chatId, `Max open positions reached (${openPositionCount()}/${numSetting('max_open_positions', 3)}).`);
  }
  const { decision } = intent.payload;
  try {
    const freshRow = await refreshCandidateForExecution({
      id: intent.candidate_id,
      candidate: intent.payload.candidate,
    });
    if (!freshRow.candidate.filters?.passed) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_stale', now(), intentId);
      return bot.sendMessage(chatId, [
        '🛑 <b>Trade intent rejected on fresh check</b>',
        '',
        candidateSummary(freshRow.candidate, decision),
        '',
        `Failures: ${escapeHtml((freshRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
      ].join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
    }
    const gate = entryBlockReason(freshRow.candidate.token.mint);
    if (gate) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_entry_gate', now(), intentId);
      logDecisionEvent({
        batchId: null, triggerCandidateId: intent.candidate_id, selectedRow: freshRow, rows: [], decision,
        mode: 'live', action: 'live_entry_blocked_gate', guardrails: { gate, intentId },
        execution: { error: `entry blocked (${gate.reason})` },
      });
      return bot.sendMessage(chatId, `Entry blocked (${gate.reason}) by position #${gate.id}.`);
    }
    const amountLamports = Math.floor(positionSizeSol(freshRow.candidate) * 1_000_000_000);
    const balance = await liveWalletBalanceLamports();
    if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_insufficient_balance', now(), intentId);
      return bot.sendMessage(chatId, `Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL.`, { parse_mode: 'HTML' });
    }
    const swap = await deps.executeJupiterSwap({
      inputMint: WSOL_MINT,
      outputMint: freshRow.candidate.token.mint,
      amount: amountLamports,
    });
    if (!swap.outputAmount) {
      swap.outputAmount = await deps.fetchLiveTokenBalance(freshRow.candidate.token.mint) || swap.outputAmount;
    }
    const { id: positionId, isNew } = await createLivePosition(intent.candidate_id, freshRow.candidate, decision, swap, `confirmed_intent_${intentId}`);
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('executed_live', now(), intentId);
    logDecisionEvent({
      batchId: null,
      triggerCandidateId: intent.candidate_id,
      selectedRow: freshRow,
      rows: [],
      decision,
      mode: 'live',
      action: 'confirmed_intent_executed',
      guardrails: { balanceLamports: balance, amountLamports, intentId },
      execution: { positionId, isNew, swap },
    });
    if (isNew) return sendPositionOpen(positionId);
  } catch (err) {
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('execution_failed', now(), intentId);
    return bot.sendMessage(chatId, `Live execution failed: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
}

export async function rejectIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent) return bot.sendMessage(chatId, 'Intent not found.');
  db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected', now(), intentId);
  return bot.sendMessage(chatId, `Rejected trade intent #${intentId}.`);
}
