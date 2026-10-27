import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'charon-gate-test-')), 'db.sqlite');
process.env.GMGN_ENABLED = 'false';

const { db, initDb } = await import('../src/db/connection.js');
initDb();
const { setSetting } = await import('../src/db/settings.js');
setSetting('use_dynamic_sl', '0');
const { entryBlockReason, createLivePosition, recordFailedEntry, positionValue } = await import('../src/db/positions.js');
const { executeLiveSell, _setLiveDeps } = await import('../src/execution/router.js');
const { refreshPosition } = await import('../src/execution/positions.js');
const { PAPER_VERSION } = await import('../src/execution/paperSafety.js');

const DAY = 86400000;
const WSOL = 'So11111111111111111111111111111111111111112';
const originalGet = axios.get;
test.after(() => { axios.get = originalGet; _setLiveDeps(); });

function insertPosition({ mint, status = 'closed', closedAgoMs = 0, pnlPercent = null, snapshot = {}, extra = {} }) {
  const t = Date.now();
  const cols = {
    mint, symbol: 'TST', status, opened_at_ms: t - closedAgoMs - 1000,
    closed_at_ms: status === 'closed' ? t - closedAgoMs : null,
    size_sol: 1, entry_price: 0.001, entry_mcap: 10000, high_water_price: 0.001, high_water_mcap: 10000,
    tp_percent: 100, sl_percent: -25, trailing_enabled: 0, trailing_percent: 0,
    exit_reason: status === 'closed' ? 'TP' : null, pnl_percent: pnlPercent, pnl_sol: pnlPercent == null ? null : pnlPercent / 100,
    snapshot_json: JSON.stringify(snapshot), ...extra,
  };
  const keys = Object.keys(cols);
  const res = db.prepare(`INSERT INTO dry_run_positions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(cols));
  return Number(res.lastInsertRowid);
}
const candidateFor = (mint) => ({
  token: { mint, symbol: 'TST' },
  metrics: { priceUsd: 0.001, marketCapUsd: 10000 },
  jupiterAsset: { decimals: 6 },
});

test('entryBlockReason covers open, recent close, recent win and expired windows', () => {
  assert.equal(entryBlockReason('mint-none'), null);

  const open = insertPosition({ mint: 'mint-open', status: 'open' });
  assert.deepEqual(entryBlockReason('mint-open'), { reason: 'open_position', id: open });

  const recent = insertPosition({ mint: 'mint-recent', closedAgoMs: 3600_000, pnlPercent: -10 });
  assert.deepEqual(entryBlockReason('mint-recent'), { reason: 'recently_closed', id: recent });

  const win = insertPosition({ mint: 'mint-win', closedAgoMs: 3 * DAY, pnlPercent: 40 });
  const blocked = entryBlockReason('mint-win');
  assert.equal(blocked.reason, 'past_win');
  assert.equal(blocked.id, win);

  insertPosition({ mint: 'mint-oldwin', closedAgoMs: 8 * DAY, pnlPercent: 40 });
  assert.equal(entryBlockReason('mint-oldwin'), null);

  insertPosition({ mint: 'mint-oldloss', closedAgoMs: 2 * DAY, pnlPercent: -30 });
  assert.equal(entryBlockReason('mint-oldloss'), null);
});

test('createLivePosition always inserts after a filled swap, even when the gate now blocks', async () => {
  axios.get = async (url) => (String(url).includes('/price/v3') ? { data: { [WSOL]: { usdPrice: 100 } } } : { data: {} });
  const mint = 'mint-race';
  const prior = insertPosition({ mint, closedAgoMs: 1000, pnlPercent: 25 });
  assert.ok(entryBlockReason(mint));
  const swap = { signature: 'sig-race', inputAmount: '100000000', outputAmount: '1000000' };
  const res = await createLivePosition(1, candidateFor(mint), {}, swap, 'live_buy');
  assert.equal(res.isNew, true);
  assert.notEqual(res.id, prior);
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(res.id);
  assert.equal(row.status, 'open');
  assert.equal(row.execution_mode, 'live');
  assert.equal(row.token_amount_raw, '1000000');
  // 0.1 SOL * $100 over 1 token (6 decimals) = $10/token
  assert.ok(Math.abs(row.entry_price - 10) < 1e-9);
  assert.ok(Math.abs(row.entry_mcap - 10000 * (10 / 0.001)) < 1e-3);
  assert.equal(JSON.parse(row.snapshot_json).postSwapGateConflict.reason, 'recently_closed');
  const untouched = db.prepare('SELECT status, pnl_percent FROM dry_run_positions WHERE id = ?').get(prior);
  assert.equal(untouched.status, 'closed');
  assert.equal(untouched.pnl_percent, 25);
});

test('recordFailedEntry inserts its own closed row and leaves past-win rows untouched', () => {
  const mint = 'mint-failed';
  const win = insertPosition({ mint, closedAgoMs: 2 * DAY, pnlPercent: 60 });
  const { id } = recordFailedEntry(1, candidateFor(mint), {}, { error: 'boom', sizeSol: 0.05, attempts: 3 });
  assert.notEqual(id, win);
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  assert.equal(row.status, 'closed');
  assert.equal(row.exit_reason, 'FAILED_ENTRY');
  assert.equal(row.pnl_sol, 0);
  assert.equal(row.pnl_percent, 0);
  assert.equal(row.execution_mode, 'live');
  assert.equal(row.size_sol, 0.05);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM dry_run_trades WHERE position_id = ?').get(id).n, 1);
  const old = db.prepare('SELECT exit_reason, pnl_percent, pnl_sol FROM dry_run_positions WHERE id = ?').get(win);
  assert.deepEqual({ ...old }, { exit_reason: 'TP', pnl_percent: 60, pnl_sol: 0.6 });
});

test('positionValue counts banked partial proceeds', () => {
  const plain = positionValue({ remainingProceedsSol: 1.5, sizeSol: 1 });
  assert.ok(Math.abs(plain.pnlSol - 0.5) < 1e-12);
  assert.ok(Math.abs(plain.pnlPercent - 50) < 1e-9);
  const partial = positionValue({ remainingProceedsSol: 0.75, realizedPartialSol: 0.75, sizeSol: 1 });
  assert.ok(Math.abs(partial.pnlSol - 0.5) < 1e-12);
  assert.ok(Math.abs(partial.pnlPercent - 50) < 1e-9);
  const fees = positionValue({ remainingProceedsSol: 1.1, sizeSol: 1, feesSol: 0.01 });
  assert.ok(Math.abs(fees.pnlSol - 0.09) < 1e-12);
});

test('executeLiveSell clamps to the live wallet balance', async () => {
  const calls = [];
  const swapStub = async (args) => { calls.push(args); return { signature: 's', inputAmount: String(args.amount), outputAmount: '1000' }; };
  _setLiveDeps({ executeJupiterSwap: swapStub, fetchLiveTokenBalance: async () => '500' });
  await executeLiveSell({ mint: 'mint-sell-clamp', token_amount_raw: '1000' }, 'SL');
  assert.equal(calls[0].amount, '500');
  assert.equal(calls[0].priority, 'exit_live');

  _setLiveDeps({ executeJupiterSwap: swapStub, fetchLiveTokenBalance: async () => '5000' });
  await executeLiveSell({ mint: 'mint-sell-clamp', token_amount_raw: '1000' }, 'SL');
  assert.equal(calls[1].amount, '1000');

  _setLiveDeps({ executeJupiterSwap: swapStub, fetchLiveTokenBalance: async () => null });
  await executeLiveSell({ mint: 'mint-sell-clamp', token_amount_raw: '1000' }, 'SL');
  assert.equal(calls[2].amount, '1000');

  _setLiveDeps({ executeJupiterSwap: swapStub, fetchLiveTokenBalance: async () => '0' });
  await assert.rejects(() => executeLiveSell({ mint: 'mint-sell-clamp', token_amount_raw: '1000' }, 'SL'), /holds 0/);
  assert.equal(calls.length, 3);
  _setLiveDeps();
});

test('partial TP tick sells a slice and returns without exiting; the final close includes banked proceeds', async () => {
  const mint = 'mint-partial-tp';
  let quoteOut = '2100000000';
  axios.get = async (url) => {
    const u = String(url);
    if (u.includes('/quote')) {
      const amount = new URL(u).searchParams.get('amount');
      return { data: { inputMint: mint, outputMint: WSOL, inAmount: amount, outAmount: quoteOut, swapMode: 'ExactIn', routePlan: [{}], contextSlot: 1 } };
    }
    if (u.includes('/price/v3')) return { data: { [WSOL]: { usdPrice: 100 } } };
    if (u.includes('/assets/search')) return { data: [{ id: mint, usdPrice: 0.002, mcap: 20000, decimals: 6 }] };
    return { data: {} };
  };
  const id = insertPosition({
    mint, status: 'open',
    snapshot: { paperVersion: PAPER_VERSION, tokenAmountRaw: '1000000', entryLamports: '1000000000' },
    extra: { strategy_id: 'smart_money', token_amount_est: 1000000 },
  });
  const load = () => db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);

  const first = await refreshPosition(load(), { autoExit: true });
  assert.equal(first.exitReason, null);
  const afterPartial = load();
  assert.equal(afterPartial.status, 'open');
  assert.equal(afterPartial.partial_tp_done, 1);
  assert.ok(Math.abs(afterPartial.realized_partial_sol - 1.05) < 1e-9);
  assert.equal(JSON.parse(afterPartial.snapshot_json).tokenAmountRaw, '500000');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM dry_run_trades WHERE position_id = ? AND reason = 'PARTIAL_TP'").get(id).n, 1);

  // Remaining half now quotes 1.05 SOL; total = 1.05 + 1.05 - 1 - fees.
  quoteOut = '1050000000';
  const second = await refreshPosition(afterPartial, { autoExit: true });
  assert.equal(second.exitReason, 'TP');
  const closed = load();
  assert.equal(closed.status, 'closed');
  assert.ok(Math.abs(closed.pnl_sol - (1.1 - 0.00003)) < 1e-6, `pnl_sol ${closed.pnl_sol}`);
});
