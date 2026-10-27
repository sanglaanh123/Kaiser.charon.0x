import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'charon-paperwallet-test-')), 'db.sqlite');
process.env.GMGN_ENABLED = 'false';

const { db, initDb } = await import('../src/db/connection.js');
initDb();
const { setSetting } = await import('../src/db/settings.js');
const { paperWalletState, paperEntryCheck, resetPaperWallet, PAPER_FEE_LAMPORTS, PAPER_ATA_RENT_LAMPORTS } = await import('../src/db/paperWallet.js');
const { createDryRunPosition } = await import('../src/db/positions.js');
const { LIVE_MIN_SOL_RESERVE_LAMPORTS } = await import('../src/config.js');

const WSOL = 'So11111111111111111111111111111111111111112';
const RESERVE = LIVE_MIN_SOL_RESERVE_LAMPORTS / 1e9;
const LOCK_EXTRA = (PAPER_FEE_LAMPORTS + PAPER_ATA_RENT_LAMPORTS) / 1e9;
const originalGet = axios.get;
test.after(() => { axios.get = originalGet; });

let n = 0;
function insert(extra = {}) {
  const cols = {
    mint: `m${++n}`, symbol: 'T', status: 'open', opened_at_ms: Date.now(), size_sol: 0.1,
    entry_price: 1, entry_mcap: 10000, high_water_price: 1, high_water_mcap: 10000,
    tp_percent: 50, sl_percent: -25, trailing_enabled: 0, trailing_percent: 0, snapshot_json: '{}', ...extra,
  };
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO dry_run_positions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(cols));
}
const clear = () => { db.prepare('DELETE FROM dry_run_positions').run(); setSetting('paper_epoch_ms', '0'); setSetting('paper_starting_balance_sol', '1'); };
const close = (pnl) => ({ status: 'closed', closed_at_ms: Date.now(), exit_reason: 'TP', pnl_sol: pnl });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('seeded defaults; start only', () => {
  clear();
  const s = paperWalletState();
  near(s.startSol, 1); near(s.balanceSol, 1); near(s.availableSol, 1 - RESERVE); near(s.lockedSol, 0);
  assert.equal(s.openCount, 0);
});

test('open position locks size + fee + rent', () => {
  clear(); insert();
  const s = paperWalletState();
  near(s.lockedSol, 0.1 + LOCK_EXTRA); near(s.balanceSol, 1 - 0.1 - LOCK_EXTRA); assert.equal(s.openCount, 1);
});

test('closed win/loss releases the lock: balance = start + pnl', () => {
  clear(); insert(close(0.05)); insert(close(-0.03));
  const s = paperWalletState();
  near(s.balanceSol, 1.02); near(s.lockedSol, 0); near(s.realizedSol, 0.02);
});

test('open position adds banked partial proceeds', () => {
  clear(); insert({ realized_partial_sol: 0.15 });
  near(paperWalletState().balanceSol, 1 - 0.1 - LOCK_EXTRA + 0.15);
});

test('epoch, live rows and FAILED_ENTRY rows are excluded', () => {
  clear();
  insert({ ...close(0.5), opened_at_ms: 1000 });
  setSetting('paper_epoch_ms', '5000');
  insert({ ...close(0.5), opened_at_ms: 1000 });
  insert({ ...close(0.5), execution_mode: 'live' });
  insert({ ...close(-0.5), exit_reason: 'FAILED_ENTRY' });
  near(paperWalletState().balanceSol, 1);
  insert(close(0.2));
  near(paperWalletState().balanceSol, 1.2);
});

test('paperEntryCheck compares available against size + fee + rent', () => {
  clear();
  assert.equal(paperEntryCheck(1 - RESERVE - LOCK_EXTRA - 0.001).ok, true);
  assert.equal(paperEntryCheck(1 - RESERVE - LOCK_EXTRA + 0.001).ok, false);
});

test('createDryRunPosition fills, locks, then rejects when balance is too low', async () => {
  clear();
  setSetting('trading_mode', 'dry_run'); setSetting('max_open_positions', '10'); setSetting('use_dynamic_sl', '0');
  axios.get = async (url) => {
    const u = String(url);
    if (u.includes('/quote')) {
      const p = new URL(u).searchParams;
      return { data: { inputMint: p.get('inputMint'), outputMint: p.get('outputMint'), inAmount: p.get('amount'), outAmount: '1000000', swapMode: 'ExactIn', routePlan: [{}], contextSlot: 1 } };
    }
    if (u.includes('/price/v3')) return { data: { [WSOL]: { usdPrice: 100 } } };
    return { data: {} };
  };
  const cand = (mint) => ({ token: { mint, symbol: 'T' }, metrics: { priceUsd: 0.001, marketCapUsd: 10000 }, jupiterAsset: { decimals: 6 } });
  const strat = JSON.parse(db.prepare("SELECT config_json FROM strategies WHERE id = ?").get('sniper').config_json);
  const size = Number(strat.position_size_sol ?? 0.1);
  setSetting('paper_starting_balance_sol', String(size + RESERVE + LOCK_EXTRA + 0.001));
  const ok = await createDryRunPosition(1, cand('mint-a'), {}, 'test');
  assert.equal(ok.isNew, true);
  near(paperWalletState().lockedSol, size + LOCK_EXTRA);
  await assert.rejects(createDryRunPosition(2, cand('mint-b'), {}, 'test'), /paper_insufficient_balance/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM dry_run_positions WHERE mint = 'mint-b'").get().n, 0);
  const ev = db.prepare("SELECT evidence_json FROM paper_execution_events WHERE mint = 'mint-b' AND kind = 'entry_rejected'").get();
  assert.equal(JSON.parse(ev.evidence_json).reason, 'paper_insufficient_balance');
});

test('PAPER_STARTING_BALANCE_SOL in env pins the starting balance', () => {
  clear();
  process.env.PAPER_STARTING_BALANCE_SOL = '3';
  try {
    near(paperWalletState().startSol, 3);
    near(paperWalletState().balanceSol, 3);
    assert.throws(() => resetPaperWallet({ startSol: 2 }), /paper_start_pinned_by_env/);
    near(resetPaperWallet().startSol, 3);
    process.env.PAPER_STARTING_BALANCE_SOL = 'abc';
    assert.throws(() => paperWalletState(), /PAPER_STARTING_BALANCE_SOL/);
  } finally {
    process.env.PAPER_STARTING_BALANCE_SOL = '';
  }
});

test('resetPaperWallet refuses with open positions, otherwise moves epoch', () => {
  clear(); insert();
  assert.throws(() => resetPaperWallet(), /paper_reset_open_positions/);
  clear(); insert({ ...close(0.3), opened_at_ms: Date.now() - 10 });
  const before = Date.now();
  const s = resetPaperWallet({ startSol: 2 });
  assert.ok(s.epochMs >= before);
  near(s.startSol, 2); near(s.balanceSol, 2);
  assert.throws(() => resetPaperWallet({ startSol: -1 }), /paper_reset_invalid_start/);
});
