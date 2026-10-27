import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'charon-jev-test-'));
process.env.DB_PATH = join(dir, 'db.sqlite');
process.env.GMGN_ENABLED = 'false';
process.env.TYPESAFE_API_KEY = 'test-key';
process.env.ENABLE_JEV = 'true';

const { default: axios } = await import('axios');
const { initDb } = await import('../src/db/connection.js');
initDb();
const { setSetting, activeStrategy, updateStrategyConfig } = await import('../src/db/settings.js');
const { decideCandidateBatch, buildJevState, jevQuestions, _resetJevCache } = await import('../src/pipeline/jev.js');

setSetting('llm_min_confidence', '40');
test.beforeEach(() => _resetJevCache());

function row(id, extra = {}) {
  return {
    id,
    candidate: {
      token: { mint: `Mint${id}`.padEnd(32, 'x'), symbol: `T${id}`, name: 'Secret Name' },
      signals: { route: 'pumpportal_graduated' },
      metrics: { marketCapUsd: 38_000, liquidityUsd: 9_000, holderCount: 120 },
      jupiterAsset: {
        organicScore: 55,
        audit: { topHoldersPercentage: 22, botHoldersPercentage: 12, devBalancePercentage: 1, mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
        stats5m: { numNetBuyers: 30, numTraders: 50 },
        stats1h: { priceChange: 14 },
      },
      twitterNarrative: { text: 'irrelevant narrative text' },
      filters: { passed: true, failures: [] },
      marketSource: 'jupiter',
      ...extra,
    },
  };
}

function answer({ choice, pBuy, pWatch, pPass, rug }) {
  return {
    data: {
      model: 'jev-latest',
      answers: {
        verdict: { type: 'choice', choice, confidence: 0.8, probabilities: { PASS: pPass, WATCH: pWatch, BUY: pBuy } },
        rug: { type: 'noul', noul: rug },
        momentum: { type: 'score', score: 2.1, confidence: 0.7, probabilities: {} },
      },
      usage: { input_tokens: 100, output_tokens: 5 },
    },
  };
}

const SHAPE = ['verdict', 'confidence', 'reason', 'risks', 'suggested_tp_percent', 'suggested_sl_percent', 'raw', 'selected_candidate_id', 'selected_mint', 'selected_row'];

test('BUY with low rug is selected with full return shape', async () => {
  // Distinct states: identical states share one cached Jev answer.
  const rows = [row(1), row(2, { metrics: { marketCapUsd: 120_000, liquidityUsd: 30_000, holderCount: 900 } })];
  axios.post = async (_url, body) => {
    // identify row by order of calls via state text is unnecessary; alternate by mcap marker
    return body.state.includes('Route') && calls++ === 0
      ? answer({ choice: 'WATCH', pBuy: 0.2, pWatch: 0.6, pPass: 0.2, rug: 0.1 })
      : answer({ choice: 'BUY', pBuy: 0.72, pWatch: 0.2, pPass: 0.08, rug: 0.1 });
  };
  let calls = 0;
  const d = await decideCandidateBatch(rows, 1);
  for (const k of SHAPE) assert.ok(k in d, `missing ${k}`);
  assert.equal(d.verdict, 'BUY');
  assert.equal(d.confidence, 72);
  assert.equal(d.selected_candidate_id, 2);
  assert.equal(d.selected_row, rows[1]);
  assert.match(d.reason, /P\(BUY\)=\.72/);
  assert.equal(d.raw.perRow.length, 2);
});

test('unchanged state is asked once across batches and concurrent calls', async () => {
  let calls = 0;
  axios.post = async () => { calls++; return answer({ choice: 'WATCH', pBuy: 0.3, pWatch: 0.6, pPass: 0.1, rug: 0.1 }); };
  const rows = [row(1), row(2, { metrics: { marketCapUsd: 120_000, liquidityUsd: 30_000, holderCount: 900 } })];
  await Promise.all([decideCandidateBatch(rows, 1), decideCandidateBatch(rows, 2)]);
  await decideCandidateBatch(rows, 1);
  assert.equal(calls, 2);
});

test('failed Jev call is not cached', async () => {
  let calls = 0;
  axios.post = async () => { calls++; throw Object.assign(new Error('boom'), { response: { status: 400 } }); };
  await decideCandidateBatch([row(1)], 1);
  await decideCandidateBatch([row(1)], 1);
  assert.equal(calls, 2);
});

const row2 = () => row(2, { metrics: { marketCapUsd: 120_000, liquidityUsd: 30_000, holderCount: 900 } });

test('missing rug answer fails closed', async () => {
  axios.post = async () => {
    const res = answer({ choice: 'BUY', pBuy: 0.9, pWatch: 0.05, pPass: 0.05, rug: 0 });
    delete res.data.answers.rug;
    return res;
  };
  const d = await decideCandidateBatch([row(1)], 1);
  assert.notEqual(d.verdict, 'BUY');
  assert.ok(d.risks.includes('jev_rug_high'));
});

test('each row keeps its own verdict; batch verdict follows the trigger', async () => {
  axios.post = async (_url, body) => body.state.includes('$120k')
    ? answer({ choice: 'WATCH', pBuy: 0.3, pWatch: 0.6, pPass: 0.1, rug: 0.1 })
    : answer({ choice: 'PASS', pBuy: 0.01, pWatch: 0.3, pPass: 0.69, rug: 0.4 });
  const d = await decideCandidateBatch([row(1), row2()], 1);
  assert.equal(d.verdict, 'PASS');
  assert.match(d.reason, /PASS=\.69/);
  assert.deepEqual([d.row_verdicts[1].verdict, d.row_verdicts[2].verdict], ['PASS', 'WATCH']);
  assert.equal(d.row_verdicts[2].confidence, 30);
});

test("failed trigger never borrows another row's reason", async () => {
  axios.post = async (_url, body) => {
    if (body.state.includes('$120k')) return answer({ choice: 'WATCH', pBuy: 0.3, pWatch: 0.6, pPass: 0.1, rug: 0.1 });
    throw Object.assign(new Error('boom'), { response: { status: 400 } });
  };
  const d = await decideCandidateBatch([row(1), row2()], 1);
  assert.equal(d.verdict, 'WATCH');
  assert.equal(d.confidence, 0);
  assert.match(d.reason, /Jev failed: boom/);
  assert.doesNotMatch(d.reason, /P\(BUY\)=\.30/);
});

test('active strategy llm_min_confidence overrides the global setting', async () => {
  const strat = activeStrategy();
  const original = strat.llm_min_confidence;
  axios.post = async () => answer({ choice: 'BUY', pBuy: 0.72, pWatch: 0.2, pPass: 0.08, rug: 0.1 });
  try {
    updateStrategyConfig(strat.id, { ...strat, llm_min_confidence: 80 });
    const d = await decideCandidateBatch([row(1)], 1);
    assert.equal(d.verdict, 'WATCH');
    assert.equal(d.row_verdicts[1].verdict, 'WATCH');
    updateStrategyConfig(strat.id, { ...strat, llm_min_confidence: 60 });
    _resetJevCache();
    assert.equal((await decideCandidateBatch([row(1)], 1)).verdict, 'BUY');
  } finally {
    updateStrategyConfig(strat.id, { ...strat, llm_min_confidence: original });
  }
});

test('BUY with high rug is vetoed', async () => {
  axios.post = async () => answer({ choice: 'BUY', pBuy: 0.9, pWatch: 0.05, pPass: 0.05, rug: 0.6 });
  const d = await decideCandidateBatch([row(1)], 1);
  assert.notEqual(d.verdict, 'BUY');
  assert.equal(d.selected_row, null);
  assert.ok(d.risks.includes('jev_rug_high'));
});

test('all calls failing yields WATCH conf 0 with jev_error', async () => {
  axios.post = async () => { throw Object.assign(new Error('boom'), { response: { status: 400 } }); };
  const d = await decideCandidateBatch([row(1), row(2)], 1);
  assert.equal(d.verdict, 'WATCH');
  assert.equal(d.confidence, 0);
  assert.ok(d.risks.includes('jev_error'));
  for (const k of SHAPE) assert.ok(k in d, `missing ${k}`);
});

test('disabled without API key returns WATCH', () => {
  const code = "const db = await import('./src/db/connection.js'); db.initDb(); const m = await import('./src/pipeline/jev.js'); const d = await m.decideCandidateBatch([{id:1,candidate:{token:{mint:'x'}}}],1); console.log(JSON.stringify(d));";
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, TYPESAFE_API_KEY: '', DB_PATH: join(dir, 'db2.sqlite') },
    encoding: 'utf8',
  });
  const d = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(d.verdict, 'WATCH');
  assert.equal(d.confidence, 0);
  assert.equal(d.reason, 'jev disabled');
});

test('buildJevState uses bucket words and omits irrelevant fields', () => {
  const s = buildJevState(row(1).candidate, { score: 62 });
  assert.ok(!s.includes('{'));
  assert.match(s, /\(small\)/);
  assert.match(s, /healthy/);
  assert.match(s, /Top 10 holders: 22% \(moderate\)/);
  assert.match(s, /Pre-score: 62/);
  assert.match(s, /1h price change: \+14%/);
  assert.match(s, /Data source: jupiter/);
  assert.ok(!s.includes('irrelevant narrative'));
  assert.ok(!s.includes('Secret Name'));
});

test('verdict criteria order is PASS, WATCH, BUY', () => {
  assert.deepEqual(Object.keys(jevQuestions().verdict.criteria), ['PASS', 'WATCH', 'BUY']);
});
