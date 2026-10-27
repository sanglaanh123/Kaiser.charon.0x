import { DatabaseSync } from 'node:sqlite';

// Built-in node:sqlite (no native build, works on any Node >= 22.13) with the two
// better-sqlite3 helpers the codebase relies on: db.transaction(fn) and db.pragma(str).
export function openDatabase(path, { readonly = false } = {}) {
  const db = new DatabaseSync(path, {
    readOnly: readonly,
    timeout: 5000, // better-sqlite3's default busy timeout
    allowUnknownNamedParameters: true, // better-sqlite3 ignores extra keys in bound objects
  });
  let depth = 0;

  // Same contract as better-sqlite3: returns a wrapped function; nested calls use savepoints.
  db.transaction = fn => (...args) => {
    const savepoint = `tx_${depth}`;
    db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN');
    depth++;
    try {
      const result = fn(...args);
      depth--;
      db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (err) {
      depth--;
      db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      throw err;
    }
  };

  db.pragma = statement => db.prepare(`PRAGMA ${statement}`).all();

  // better-sqlite3 binds undefined as NULL; node:sqlite throws. Normalise at bind time.
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    const stmt = prepare(sql);
    for (const method of ['run', 'get', 'all', 'iterate']) {
      const original = stmt[method].bind(stmt);
      stmt[method] = (...args) => original(...args.map(bindable));
    }
    return stmt;
  };

  return db;
}

function bindable(value) {
  if (value === undefined) return null;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = v === undefined ? null : v;
    return out;
  }
  return value;
}
