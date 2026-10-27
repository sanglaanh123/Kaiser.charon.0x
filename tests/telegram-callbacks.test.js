import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'charon-callbacks-test-')), 'db.sqlite');
process.env.GMGN_ENABLED = 'false';

const { db, initDb } = await import('../src/db/connection.js');
initDb();
const { setSetting } = await import('../src/db/settings.js');
setSetting('trading_mode', 'dry_run');
const { handleCallback, editMenuMessage } = await import('../src/telegram/callbacks.js');
const { PAPER_VERSION } = await import('../src/execution/paperSafety.js');

const WSOL = 'So11111111111111111111111111111111111111112';
const calls = globalThis.__telegramCalls;
const originalGet = axios.get;
test.after(() => { axios.get = originalGet; });
test.beforeEach(() => { calls.length = 0; });
const press = (data, message = { chat: { id: 1 }, message_id: 50, text: 'card' }) => handleCallback({ id: 'q', data, message });
const methods = () => calls.map(c => c.method).filter(m => m !== 'answerCallbackQuery');

test('bot polling subscribes to callback_query', () => {
  const src = readFileSync(new URL('../src/telegram/bot.js', import.meta.url), 'utf8');
  assert.match(src, /ALLOWED_UPDATES = \[[^\]]*'callback_query'/);
  assert.match(src, /allowed_updates: JSON\.stringify\(ALLOWED_UPDATES\)/);
});

test('menu:pnl answers instead of throwing', async () => {
  await press('menu:pnl');
  assert.deepEqual(methods(), ['editMessageText']);
  assert.match(calls.at(-1).args[0], /PnL/);
});

test('pos:list sends a new message and leaves the alert card alone', async () => {
  await press('pos:list');
  assert.deepEqual(methods(), ['sendMessage']);
  assert.match(calls.at(-1).args[1], /Positions/);
});

test('editMenuMessage edits the caption of photo cards', async () => {
  await editMenuMessage({ message: { chat: { id: 1 }, message_id: 7, photo: [{}] } }, 'updated', {});
  assert.deepEqual(methods(), ['editMessageCaption']);
  assert.equal(calls.at(-1).args[1].message_id, 7);
});

test('Dry Sell closes through the monitor path with paper fees and sends the exit card', async () => {
  const mint = 'mint-manual-sell';
  axios.get = async (url) => {
    const u = String(url);
    if (u.includes('/quote')) {
      const amount = new URL(u).searchParams.get('amount');
      return { data: { inputMint: mint, outputMint: WSOL, inAmount: amount, outAmount: '1100000000', swapMode: 'ExactIn', routePlan: [{}], contextSlot: 1 } };
    }
    if (u.includes('/price/v3')) return { data: { [WSOL]: { usdPrice: 100 } } };
    if (u.includes('/assets/search')) return { data: [{ id: mint, usdPrice: 0.0011, mcap: 11000, decimals: 6 }] };
    return { data: {} };
  };
  const t = Date.now();
  const cols = {
    mint, symbol: 'TST', status: 'open', opened_at_ms: t - 1000, size_sol: 1,
    entry_price: 0.001, entry_mcap: 10000, high_water_price: 0.001, high_water_mcap: 10000,
    tp_percent: 100, sl_percent: -25, trailing_enabled: 0, trailing_percent: 0, strategy_id: 'sniper',
    snapshot_json: JSON.stringify({ paperVersion: PAPER_VERSION, tokenAmountRaw: '1000000', entryLamports: '1000000000' }),
  };
  const keys = Object.keys(cols);
  const id = Number(db.prepare(`INSERT INTO dry_run_positions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(cols)).lastInsertRowid);

  await press(`sell:${id}`);
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  assert.equal(row.status, 'closed');
  assert.equal(row.exit_reason, 'MANUAL');
  // 1.1 SOL proceeds - 1 SOL cost - two 15000-lamport legs
  assert.ok(Math.abs(row.pnl_sol - (0.1 - 0.00003)) < 1e-6, `pnl_sol ${row.pnl_sol}`);
  assert.ok(methods().includes('sendPhoto'), 'exit card sent');

  calls.length = 0;
  await press(`sell:${id}`);
  assert.match(calls.at(-1).args[1], /Open position not found/);
});
