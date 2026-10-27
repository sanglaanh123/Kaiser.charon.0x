import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'charon-phase3-')), 'db.sqlite');
process.env.GMGN_ENABLED = 'false';

const { initDb } = await import('../src/db/connection.js');
initDb();
const { activeStrategy } = await import('../src/db/settings.js');
const { filterCandidate, buildCandidate, cheapPrefilter } = await import('../src/pipeline/candidateBuilder.js');
const { storeDecision, checkDecisionCache } = await import('../src/db/decisions.js');

function freshGradCandidate(jupiterAsset) {
  return {
    token: { mint: 'FreshGrad1111111111111111111111111111111111' },
    metrics: { marketCapUsd: 60000, liquidityUsd: 20000, holderCount: 100 },
    signals: { route: 'pumpportal_graduated' },
    holders: { maxHolderPercent: 5 },
    savedWalletExposure: { holderCount: 0 },
    jupiterAsset,
  };
}

test('fresh-grad gate accepts a GMGN-sourced asset with liquidity and holders', () => {
  const asset = { source: 'gmgn', liquidity: 20000, holderCount: 100, mcap: 60000 };
  const { failures } = filterCandidate(freshGradCandidate(asset));
  assert.ok(!failures.some(f => f.startsWith('fresh grad insufficient data')), failures.join('; '));
});

test('fresh-grad gate rejects when no asset data from either source', () => {
  const { failures } = filterCandidate(freshGradCandidate(null));
  assert.ok(failures.some(f => f.includes('fresh grad insufficient data') && f.includes('no jupiterAsset')));
});

test('cheap prefilter short-circuits enrichment for out-of-bounds mcap', async () => {
  const min = activeStrategy().min_mcap_usd;
  assert.ok(min > 0);
  const trendingToken = { market_cap: min / 10, holder_count: 50 };
  assert.ok(cheapPrefilter({ route: 'fee_trending', trendingToken }).length > 0);

  const origGet = axios.get, origPost = axios.post, origFetch = global.fetch;
  let calls = 0;
  axios.get = async () => { calls++; throw new Error('unexpected axios.get'); };
  axios.post = async () => { calls++; throw new Error('unexpected axios.post'); };
  global.fetch = async () => { calls++; throw new Error('unexpected fetch'); };
  try {
    const candidate = await buildCandidate({ mint: 'Cheap1111111111111111111111111111111111111', trendingToken, route: 'fee_trending' });
    assert.equal(calls, 0);
    assert.equal(candidate.filters.passed, false);
    assert.equal(candidate.filters.prefiltered, true);
    assert.ok(candidate.filters.failures[0].startsWith('market cap min'));
    assert.equal(candidate.jupiterAsset, null);
    assert.equal(candidate.marketSource, null);
    assert.equal('twitterNarrative' in candidate, false);
  } finally {
    axios.get = origGet; axios.post = origPost; global.fetch = origFetch;
  }
});

test('decision cache invalidates when mcap moved more than 20%', () => {
  const mint = 'Cached111111111111111111111111111111111111';
  storeDecision(1, {
    token: { mint },
    signals: { route: 'fee_trending' },
    metrics: { marketCapUsd: 100000, holderCount: 200, liquidityUsd: 10000 },
  }, { verdict: 'PASS', confidence: 0.5, reason: 'test' });
  assert.ok(checkDecisionCache(mint));
  assert.ok(checkDecisionCache(mint, 110000, 210));
  assert.equal(checkDecisionCache(mint, 130000, 200), null);
  assert.equal(checkDecisionCache(mint, 100000, 300), null);
});
