import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'charon-jup-client-')), 'db.sqlite');
process.env.GMGN_ENABLED = 'true';
process.env.GMGN_API_KEY = 'test-key';

const { initDb } = await import('../src/db/connection.js');
initDb();
const { jupiterFetch, jupiterUsageStats, _setClock, _resetJupiterClient } = await import('../src/enrichment/jupiter.js');
const { fetchTokenMarket } = await import('../src/enrichment/market.js');

const originalGet = axios.get;
const originalPost = axios.post;
const originalFetch = global.fetch;

// Fake clock: sleep advances virtual time instantly, so rate-limit waits cost no real time.
function fakeClock(start = 1_700_000_000_000) {
  const clock = { t: start, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } };
  return clock;
}
const ok = () => ({ status: 200, data: {}, headers: {} });
const rateLimited = (resetSec) => Object.assign(new Error('429'), { response: { status: 429, headers: { 'x-ratelimit-reset': String(resetSec) } } });

let clock;
test.beforeEach(() => {
  _resetJupiterClient();
  clock = fakeClock();
  _setClock(clock);
});
test.afterEach(() => {
  axios.get = originalGet;
  axios.post = originalPost;
  global.fetch = originalFetch;
  _resetJupiterClient();
});

test('queued exit_live is served before an earlier-queued enrich request', async () => {
  const order = [];
  axios.get = async (url) => { order.push(url); return ok(); };
  const first = jupiterFetch('http://x/first', { priority: 'enrich' });
  const enrich = jupiterFetch('http://x/enrich', { priority: 'enrich' });
  const exit = jupiterFetch('http://x/exit', { priority: 'exit_live' });
  await Promise.all([first, enrich, exit]);
  assert.deepEqual(order, ['http://x/first', 'http://x/exit', 'http://x/enrich']);
});

test('main bucket paces to 1 request per second', async () => {
  const stamps = [];
  axios.get = async () => { stamps.push(clock.now()); return ok(); };
  await Promise.all([1, 2, 3].map(i => jupiterFetch(`http://x/${i}`, { priority: 'entry' })));
  assert.ok(stamps[1] - stamps[0] >= 1000);
  assert.ok(stamps[2] - stamps[1] >= 1000);
});

test('429 makes the next request wait until x-ratelimit-reset', async () => {
  const resetSec = Math.floor(clock.now() / 1000) + 30;
  let calls = 0;
  let secondAt = 0;
  axios.get = async () => {
    calls += 1;
    if (calls === 1) throw rateLimited(resetSec);
    secondAt = clock.now();
    return ok();
  };
  await assert.rejects(jupiterFetch('http://x/a', { priority: 'entry' }), err => err.response?.status === 429);
  await jupiterFetch('http://x/b', { priority: 'entry' });
  assert.ok(secondAt >= resetSec * 1000, `dispatched at ${secondAt}, reset ${resetSec * 1000}`);
  assert.equal(jupiterUsageStats().main.count429, 1);
});

test('execute bucket is not throttled by a blocked main bucket', async () => {
  axios.get = async () => { throw rateLimited(Math.floor(clock.now() / 1000) + 60); };
  axios.post = async () => ({ status: 200, data: { status: 'Success' }, headers: {} });
  await assert.rejects(jupiterFetch('http://x/order', { priority: 'entry' }));
  const before = clock.now();
  const res = await jupiterFetch('http://x/execute', { method: 'POST', body: {}, bucket: 'execute', priority: 'exit_live' });
  assert.equal(res.data.status, 'Success');
  assert.equal(clock.now(), before, 'execute must not wait on the main bucket');
});

test('enrich request past its deadline rejects with JUP_DEADLINE', async () => {
  let calls = 0;
  axios.get = async () => { calls += 1; throw rateLimited(Math.floor(clock.now() / 1000) + 60); };
  await assert.rejects(jupiterFetch('http://x/a', { priority: 'entry' }));
  await assert.rejects(
    jupiterFetch('http://x/b', { priority: 'enrich', deadlineMs: 5000 }),
    err => err.code === 'JUP_DEADLINE',
  );
  assert.equal(calls, 1, 'expired enrich request must not run');
});

test('fetchTokenMarket falls back to GMGN in Jupiter-asset shape', async () => {
  const mint = 'FallbackMint1111111111111111111111111111111';
  axios.get = async () => ({ status: 200, data: [], headers: {} }); // datapi: no row for the mint
  global.fetch = async () => {
    const body = JSON.stringify({ data: {
      address: mint, name: 'Fall Back', symbol: 'FB', decimals: 6,
      price: { price: '0.002' }, market_cap: 123456, liquidity: 9000,
      holder_count: 321, total_fee: 12.5, link: { twitter_username: 'fb', website: 'https://fb.example' },
      stat: { top_10_holder_rate: 0.21 },
    } });
    return { ok: true, status: 200, text: async () => body, headers: new Headers() };
  };
  const market = await fetchTokenMarket(mint, { useCache: false });
  assert.equal(market.source, 'gmgn');
  assert.equal(market.id, mint);
  assert.equal(market.symbol, 'FB');
  assert.equal(market.decimals, 6);
  assert.equal(market.usdPrice, 0.002);
  assert.equal(market.mcap, 123456);
  assert.equal(market.fdv, 123456);
  assert.equal(market.liquidity, 9000);
  assert.equal(market.holderCount, 321);
  assert.equal(market.fees, 12.5);
  assert.equal(market.twitter, 'fb');
  assert.ok(Math.abs(market.audit.topHoldersPercentage - 21) < 1e-9);
  assert.equal(market.organicScore, undefined);
});

test('fetchTokenMarket uses Jupiter when the asset is available', async () => {
  const mint = 'JupiterMint11111111111111111111111111111111';
  axios.get = async () => ({ status: 200, headers: {}, data: [{ id: mint, usdPrice: 1, mcap: 5000, decimals: 9 }] });
  global.fetch = async () => { throw new Error('gmgn must not be called'); };
  const market = await fetchTokenMarket(mint, { useCache: false });
  assert.equal(market.source, 'jupiter');
  assert.equal(market.mcap, 5000);
});
