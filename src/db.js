import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = process.env.DATABASE_URL || './data/signals.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Schema
db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          TEXT    NOT NULL,
  type             TEXT    NOT NULL,
  payload          TEXT    NOT NULL,
  idempotency_key  TEXT    UNIQUE,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_created ON signals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_idem ON signals(idempotency_key) WHERE idempotency_key IS NOT NULL;
`);

// ─── Failure simulation ────────────────────────────────────────────────────────

function maybeFail() {
  const rate = Number(process.env.DB_FAIL_RATE || 0);
  if (rate > 0 && Math.random() < rate) {
    const err = new Error('simulated_db_failure');
    err.code = 'SQLITE_BUSY';
    throw err;
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const SEL_COLS =
  'id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt';

export function insertSignal(userId, type, payload, idemKey, nowMs) {
  maybeFail();
  const stmt = db.prepare(
    'INSERT INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?,?,?,?,?)'
  );
  return stmt.run(userId, type, String(payload), idemKey ?? null, nowMs);
}

export function getByIdemKey(idemKey) {
  maybeFail();
  return db
    .prepare(`SELECT ${SEL_COLS} FROM signals WHERE idempotency_key = ?`)
    .get(idemKey);
}

/**
 * Atomic idempotent insert.
 *
 * Uses INSERT OR IGNORE so that a UNIQUE constraint violation on
 * idempotency_key is silently skipped rather than thrown.  The subsequent
 * SELECT always returns the canonical row — whether freshly inserted or
 * already existing — eliminating the check-then-insert race.
 */
export function upsertSignal(userId, type, payload, idemKey, nowMs) {
  maybeFail();
  db.prepare(
    'INSERT OR IGNORE INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?,?,?,?,?)'
  ).run(userId, type, String(payload), idemKey, nowMs);

  return db
    .prepare(`SELECT ${SEL_COLS} FROM signals WHERE idempotency_key = ?`)
    .get(idemKey);
}

export function listSignals(userId, limit) {
  maybeFail();
  return db
    .prepare(
      `SELECT ${SEL_COLS} FROM signals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(userId, limit);
}
