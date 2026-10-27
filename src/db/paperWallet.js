import { db } from './connection.js';
import { numSetting, setSetting } from './settings.js';
import { now } from '../utils.js';
import { LIVE_MIN_SOL_RESERVE_LAMPORTS, paperStartingBalanceEnv } from '../config.js';
import { PAPER_FEE_LAMPORTS, PAPER_ATA_RENT_LAMPORTS } from '../execution/paperSafety.js';

export { PAPER_FEE_LAMPORTS, PAPER_ATA_RENT_LAMPORTS };

// Balance is derived, never stored. Closed paper pnl_sol is already net of entry+exit fees and includes
// banked partial proceeds (paperPnl / positionValue), and the ATA rent is refunded at close, so:
//   balance = start + sum(closed.pnl_sol) - sum(open: size + entry fee + ATA rent) + sum(open.realized_partial_sol)
const PAPER_ROWS = `(execution_mode IS NULL OR execution_mode != 'live') AND opened_at_ms >= ? AND COALESCE(exit_reason, '') != 'FAILED_ENTRY'`;

export function paperWalletState() {
  const startSol = paperStartingBalanceEnv() ?? numSetting('paper_starting_balance_sol', 1);
  const epochMs = numSetting('paper_epoch_ms', 0);
  const closed = db.prepare(`SELECT COALESCE(SUM(pnl_sol), 0) AS pnl FROM dry_run_positions WHERE status = 'closed' AND ${PAPER_ROWS}`).get(epochMs);
  const open = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size_sol), 0) AS size, COALESCE(SUM(realized_partial_sol), 0) AS partial FROM dry_run_positions WHERE status = 'open' AND ${PAPER_ROWS}`).get(epochMs);
  const lockedSol = open.size + open.n * (PAPER_FEE_LAMPORTS + PAPER_ATA_RENT_LAMPORTS) / 1e9;
  const balanceSol = startSol + closed.pnl - lockedSol + open.partial;
  return {
    startSol, balanceSol, availableSol: balanceSol - LIVE_MIN_SOL_RESERVE_LAMPORTS / 1e9,
    lockedSol, openCount: open.n, realizedSol: closed.pnl + open.partial, epochMs,
  };
}

// Same rule as live: balance must cover size + fee + rent on top of the reserve.
export function paperEntryCheck(sizeSol) {
  const { availableSol } = paperWalletState();
  const needSol = Number(sizeSol) + (PAPER_FEE_LAMPORTS + PAPER_ATA_RENT_LAMPORTS) / 1e9;
  return { ok: availableSol >= needSol, availableSol, needSol };
}

export function resetPaperWallet({ startSol } = {}) {
  if (db.prepare(`SELECT 1 FROM dry_run_positions WHERE status = 'open' AND (execution_mode IS NULL OR execution_mode != 'live') LIMIT 1`).get()) {
    throw new Error('paper_reset_open_positions');
  }
  if (startSol != null) {
    if (paperStartingBalanceEnv() != null) throw new Error('paper_start_pinned_by_env');
    if (!Number.isFinite(Number(startSol)) || Number(startSol) <= 0) throw new Error('paper_reset_invalid_start');
    setSetting('paper_starting_balance_sol', Number(startSol));
  }
  setSetting('paper_epoch_ms', now());
  return paperWalletState();
}
