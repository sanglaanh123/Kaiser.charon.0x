import { db } from './connection.js';
import { now, safeJson, json } from '../utils.js';
import { numSetting, allowedRoutes } from './settings.js';

export function candidateSignalKey(candidate, signature = null) {
  const route = candidate.signals?.route || 'signal';
  const bucket = Math.floor(Number(candidate.createdAtMs || now()) / (5 * 60 * 1000));
  const sigFragment = signature ? `:${signature.slice(0, 16)}` : '';
  return `${route}:${candidate.token.mint}:${bucket}${sigFragment}`;
}

export function upsertCandidate(candidate, signature) {
  const signalKey = candidateSignalKey(candidate, signature);
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM candidates WHERE signal_key = ?').get(signalKey);
    if (existing) {
      db.prepare(`
        UPDATE candidates
        SET status = ?, updated_at_ms = ?, candidate_json = ?, filter_result_json = ?
        WHERE id = ?
      `).run(
        candidate.filters.passed ? 'candidate' : 'filtered',
        now(),
        json(candidate),
        json(candidate.filters),
        existing.id,
      );
      return existing.id;
    }

    const result = db.prepare(`
      INSERT INTO candidates (mint, status, created_at_ms, updated_at_ms, signature, signal_key, candidate_json, filter_result_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.token.mint,
      candidate.filters.passed ? 'candidate' : 'filtered',
      now(),
      now(),
      signature,
      signalKey,
      json(candidate),
      json(candidate.filters),
    );
    return Number(result.lastInsertRowid);
  })();
}

export function updateCandidateStatus(candidateId, status) {
  db.prepare('UPDATE candidates SET status = ?, updated_at_ms = ? WHERE id = ?').run(status, now(), candidateId);
}

export function updateCandidateSnapshot(candidateId, candidate, status = null) {
  db.prepare(`
    UPDATE candidates
    SET status = COALESCE(?, status), updated_at_ms = ?, candidate_json = ?, filter_result_json = ?
    WHERE id = ?
  `).run(status, now(), json(candidate), json(candidate.filters || {}), candidateId);
}

export function candidateById(id) {
  const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  return row ? { ...row, candidate: safeJson(row.candidate_json, {}) } : null;
}

export function candidatesByIds(ids) {
  return ids.map(id => candidateById(Number(id))).filter(Boolean);
}

export function latestCandidateByMint(mint) {
  const row = db.prepare('SELECT * FROM candidates WHERE mint = ? ORDER BY id DESC LIMIT 1').get(mint);
  return row ? { ...row, candidate: safeJson(row.candidate_json, {}) } : null;
}

export function recentEligibleCandidates(limit = 10) {
  const maxAgeMs = numSetting('llm_candidate_max_age_ms', 10 * 60 * 1000);
  const cutoff = now() - Math.max(30_000, maxAgeMs);
  // allowed_routes is the single route gate; filtered in SQL so disallowed routes can't crowd out allowed ones.
  // Disallowed candidates (e.g. pumpfun_pregrad) stay stored for data. Empty allowlist = all routes.
  const allowed = allowedRoutes();
  const routeClause = allowed.length
    ? `substr(signal_key, 1, instr(signal_key || ':', ':') - 1) IN (${allowed.map(() => '?').join(',')})`
    : '1=1';
  const rows = db.prepare(`
    SELECT c.*
    FROM candidates c
    INNER JOIN (
      SELECT mint, MAX(id) as max_id
      FROM candidates
      WHERE status IN ('candidate', 'watch', 'buy', 'pass')
        AND created_at_ms >= ?
        AND id NOT IN (SELECT COALESCE(candidate_id, -1) FROM dry_run_positions WHERE status = 'open')
        AND ${routeClause}
        AND (
          json_extract(candidate_json, '$.filters.passed') IS NULL
          OR json_extract(candidate_json, '$.filters.passed') = 1
        )
      GROUP BY mint
    ) latest ON c.id = latest.max_id
    ORDER BY c.id DESC
    LIMIT ?
  `).all(cutoff, ...allowed, limit);
  return rows.map(row => ({ ...row, candidate: safeJson(row.candidate_json, {}) })).reverse();
}
