import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'charon-route-test-')), 'db.sqlite');
process.env.GMGN_ENABLED = 'false';

const { initDb } = await import('../src/db/connection.js');
initDb();
const { setSetting } = await import('../src/db/settings.js');
const { routeAllowed } = await import('../src/pipeline/orchestrator.js');

test('default allowlist admits profitable routes and blocks losing ones', () => {
  assert.equal(routeAllowed('single_source'), true);
  assert.equal(routeAllowed('fee_trending'), true);
  assert.equal(routeAllowed('dual_source'), false);
  assert.equal(routeAllowed('fee_graduated_trending'), false);
  assert.equal(routeAllowed('pumpfun_pregrad'), false);
  assert.equal(routeAllowed('graduated_trending'), false);
});

test('route allowlist admits only listed routes', () => {
  setSetting('allowed_routes', 'pumpfun_pregrad');
  assert.equal(routeAllowed('pumpfun_pregrad'), true);
  assert.equal(routeAllowed('single_source'), false);
  assert.equal(routeAllowed('graduated_trending'), false);
  assert.equal(routeAllowed('pumpportal_graduated'), false); // also gates the pumpportal feed + its alert
  assert.equal(routeAllowed(''), false);
});

test('route allowlist tolerates spacing and multiple routes', () => {
  setSetting('allowed_routes', ' pumpfun_pregrad , pumpportal_graduated ');
  assert.equal(routeAllowed('pumpportal_graduated'), true);
  assert.equal(routeAllowed('trenches_completed'), false);
});

test('clearing the allowlist reopens every route', () => {
  setSetting('allowed_routes', '');
  assert.equal(routeAllowed('single_source'), true);
});

test('recentEligibleCandidates honours allowed_routes (default excludes dual_source; empty = all)', async () => {
  const { upsertCandidate, recentEligibleCandidates } = await import('../src/db/candidates.js');
  const { db } = await import('../src/db/connection.js');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('allowed_routes', ?)").run(
    'single_source,multi_source,fee_graduated,fee_trending,trending,trenches_completed,pumpportal_graduated');
  const mk = (mint, route) => upsertCandidate({ token: { mint }, signals: { route }, filters: { passed: true, failures: [] } });
  mk('DualMint111111111111111111111111111111111111', 'dual_source');
  mk('SingleMint1111111111111111111111111111111111', 'single_source');
  const routes = () => recentEligibleCandidates(10).map(r => r.candidate.signals.route).sort();
  assert.deepEqual(routes(), ['single_source']);
  setSetting('allowed_routes', '');
  assert.deepEqual(routes(), ['dual_source', 'single_source']);
});
