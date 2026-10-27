import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'charon-fee-test-')), 'db.sqlite');
process.env.GMGN_ENABLED = 'false';

const { initDb } = await import('../src/db/connection.js');
initDb();
const { setSetting } = await import('../src/db/settings.js');
const { DISC_DIST_FEES } = await import('../src/config.js');
const { readPubkey } = await import('../src/utils.js');
const { graduated } = await import('../src/signals/graduated.js');
const { trending } = await import('../src/signals/trending.js');
const fee = await import('../src/signals/feeClaim.js');

const calls = [];
fee.setCandidateHandler(async s => { calls.push(s); });
setSetting('min_fee_claim_sol', '2');
setSetting('trending_enabled', 'true');
const SOL = 1_000_000_000n;
const claim = (mint, sol) => ({ mint, distributed: BigInt(sol) * SOL, shareholders: [] });

test('fee claim below min_fee_claim_sol never reaches the handler', async () => {
  calls.length = 0;
  graduated.set('MintLow', { coinMint: 'MintLow' });
  await fee.handleFeeClaim(claim('MintLow', 1), 'sigLow');
  assert.equal(calls.length, 0);
});

test('route mapping: graduated / trending / both; neither is dropped', async () => {
  calls.length = 0;
  graduated.set('MintG', { coinMint: 'MintG' });
  trending.set('MintT', { address: 'MintT' });
  graduated.set('MintGT', { coinMint: 'MintGT' });
  trending.set('MintGT', { address: 'MintGT' });
  await fee.handleFeeClaim(claim('MintG', 3), 'sigG');
  await fee.handleFeeClaim(claim('MintT', 3), 'sigT');
  await fee.handleFeeClaim(claim('MintGT', 3), 'sigGT');
  await fee.handleFeeClaim(claim('MintNone', 3), 'sigN');
  assert.deepEqual(calls.map(c => c.route), ['fee_graduated', 'fee_trending', 'fee_graduated_trending']);
});

test('same signature seen on server path then WS path runs the pipeline once', async () => {
  calls.length = 0;
  graduated.set('MintD', { coinMint: 'MintD' });
  assert.equal(fee.markFeeClaimSeen('sigD', 'MintD'), true); // server path
  assert.equal(fee.markFeeClaimSeen('sigD', 'MintD'), false);
  await fee.handleFeeClaim(claim('MintD', 5), 'sigD'); // WS path
  assert.equal(calls.length, 0);
  // reverse order: WS first, server mark afterwards is rejected
  await fee.handleFeeClaim(claim('MintD', 5), 'sigD2');
  assert.equal(calls.length, 1);
  assert.equal(fee.markFeeClaimSeen('sigD2', 'MintD'), false);
});

test('processLog decodes a Program data line into a fee claim', async () => {
  calls.length = 0;
  const mintBytes = Buffer.alloc(32, 7);
  const mint = readPubkey(mintBytes, 0);
  graduated.set(mint, { coinMint: mint });
  const holder = Buffer.alloc(32, 9);
  const buf = Buffer.alloc(8 + 8 + 32 * 4 + 4 + 34 + 8);
  let o = 0;
  DISC_DIST_FEES.copy(buf, o); o += 8;
  buf.writeBigInt64LE(1700000000n, o); o += 8;
  mintBytes.copy(buf, o); o += 32;
  o += 32 * 3; // bonding curve, sharing config, admin
  buf.writeUInt32LE(1, o); o += 4;
  holder.copy(buf, o); o += 32;
  buf.writeUInt16LE(10000, o); o += 2;
  buf.writeBigUInt64LE(4n * SOL, o);
  await fee.processLog({ signature: 'sigLog', logs: ['noise', `Program data: ${buf.toString('base64')}`] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mint, mint);
  assert.equal(calls[0].route, 'fee_graduated');
  assert.equal(calls[0].fee.distributed, 4n * SOL);
  assert.equal(calls[0].fee.shareholders[0].bps, 10000);
});
