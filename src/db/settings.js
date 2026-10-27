import { db } from './connection.js';

export function setting(key, fallback = '') {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

// Route allowlist (setting allowed_routes, comma-separated). Empty = every route allowed.
export function allowedRoutes() {
  return String(setting('allowed_routes', '')).split(',').map(s => s.trim()).filter(Boolean);
}

export function boolSetting(key, fallback = false) {
  const value = setting(key, fallback ? 'true' : 'false');
  return value === 'true' || value === '1' || value === 'yes';
}

export function numSetting(key, fallback = 0) {
  const value = Number(setting(key, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

const strategyCache = { id: null, config: null, at: 0 };

export function activeStrategy() {
  if (strategyCache.config && Date.now() - strategyCache.at < 5000) return strategyCache.config;
  const row = db.prepare('SELECT * FROM strategies WHERE enabled = 1 LIMIT 1').get();
  if (!row) {
    const fallback = strategyById('sniper');
    if (fallback) return fallback;
    return defaultStrategy();
  }
  const config = { id: row.id, name: row.name, ...JSON.parse(row.config_json) };
  strategyCache.id = row.id;
  strategyCache.config = config;
  strategyCache.at = Date.now();
  return config;
}

export function strategyById(id) {
  const row = db.prepare('SELECT * FROM strategies WHERE id = ?').get(id);
  if (!row) return null;
  return { id: row.id, name: row.name, ...JSON.parse(row.config_json) };
}

export function allStrategies() {
  return db.prepare('SELECT * FROM strategies ORDER BY id').all().map(row => ({
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    ...JSON.parse(row.config_json),
  }));
}

export function setActiveStrategy(id) {
  db.prepare('UPDATE strategies SET enabled = 0').run();
  db.prepare('UPDATE strategies SET enabled = 1 WHERE id = ?').run(id);
  strategyCache.config = null;
  strategyCache.at = 0;
}

export function updateStrategyConfig(id, config) {
  db.prepare('UPDATE strategies SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
  if (strategyCache.id === id) {
    strategyCache.config = null;
    strategyCache.at = 0;
  }
}

export function slippageAdjustedMcap(mcap, side = 'entry') {
  const pct = numSetting('dry_run_slippage_percent', 0);
  if (pct <= 0 || !mcap) return mcap;
  return side === 'entry' ? mcap * (1 + pct / 100) : mcap * (1 - pct / 100);
}

export function strategySetting(key, fallback) {
  const strat = activeStrategy();
  if (strat[key] !== undefined && strat[key] !== null) return strat[key];
  return numSetting(key, fallback);
}

function defaultStrategy() {
  return {
    id: 'sniper', name: 'Sniper',
    entry_mode: 'immediate', min_source_count: 2, require_fee_claim: true,
    token_age_max_ms: 3600000, min_mcap_usd: 7000, max_mcap_usd: 200000,
    min_fee_claim_sol: 0.5, min_gmgn_total_fee_sol: 10, min_holders: 0,
    max_top20_holder_percent: 100, min_saved_wallet_holders: 0, max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0, trending_min_volume_usd: 0, trending_min_swaps: 0,
    trending_max_rug_ratio: 0.3, trending_max_bundler_rate: 0.5,
    position_size_sol: 0.1, max_open_positions: 3,
    tp_percent: 50, sl_percent: -25, trailing_enabled: true, trailing_percent: 20,
    partial_tp: false, partial_tp_at_percent: 0, partial_tp_sell_percent: 0,
    max_hold_ms: 0, use_llm: true, llm_min_confidence: 50,
  };
}
