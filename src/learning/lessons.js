import { now, json } from '../utils.js';
import { fmtPct } from '../format.js';
import { db } from '../db/connection.js';

export function fallbackLessons(summary) {
  const lessons = [];
  const bestRoute = summary.positions.byRoute?.[0];
  const worstRoute = [...(summary.positions.byRoute || [])].sort((a, b) => a.pnlPercent - b.pnlPercent)[0];
  if (bestRoute && bestRoute.count >= 2 && bestRoute.pnlPercent > 0) {
    lessons.push({
      lesson: `Prefer ${bestRoute.route} when other filters are clean; it led the window with ${fmtPct(bestRoute.avgPnlPercent)} avg PnL across ${bestRoute.count} closed dry-runs.`,
      evidence: bestRoute,
    });
  }
  if (worstRoute && worstRoute.count >= 2 && worstRoute.pnlPercent < 0) {
    lessons.push({
      lesson: `Be stricter on ${worstRoute.route}; it underperformed with ${fmtPct(worstRoute.avgPnlPercent)} avg PnL across ${worstRoute.count} closed dry-runs.`,
      evidence: worstRoute,
    });
  }
  const slCount = summary.positions.worst?.filter(row => row.exitReason === 'SL').length || 0;
  if (slCount >= 2) {
    lessons.push({
      lesson: `Recent worst exits clustered around SL; require stronger fresh pre-entry mcap/liquidity confirmation before accepting late entries.`,
      evidence: { slWorstCount: slCount, worst: summary.positions.worst },
    });
  }
  if (!lessons.length) {
    lessons.push({
      lesson: 'Not enough closed dry-run evidence yet; keep collecting decisions before changing filters aggressively.',
      evidence: { closed: summary.positions.closed },
    });
  }
  return lessons.slice(0, 6);
}

// Rule-based only: Jev does not generate text
export async function generateLessons(summary) {
  return { lessons: fallbackLessons(summary), raw: { fallback: true } };
}

export function storeLearningRun(windowMs, summary, lessons, raw) {
  const result = db.prepare(`
    INSERT INTO learning_runs (created_at_ms, window_ms, summary_json, lessons_json, raw_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(now(), windowMs, json(summary), json(lessons), json(raw));
  const runId = Number(result.lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO learning_lessons (run_id, created_at_ms, status, lesson, evidence_json)
    VALUES (?, ?, 'active', ?, ?)
  `);
  for (const item of lessons) insert.run(runId, now(), item.lesson, json(item.evidence || {}));
  return runId;
}
