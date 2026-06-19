import { insertSignal, upsertSignal, listSignals } from './db.js';
import { checkAndConsume } from './rateLimit.js';

// ─── Retry / back-off ─────────────────────────────────────────────────────────

const MAX_RETRIES   = 3;
const BASE_DELAY_MS = 50;   // ms; doubles each retry + random jitter

/** Transient errors worth retrying (DB busy / simulated failure). */
function isTransient(err) {
  return (
    err.code === 'SQLITE_BUSY' ||
    err.code === 'SQLITE_LOCKED' ||
    err.message === 'simulated_db_failure'
  );
}

/**
 * Execute `fn()` up to MAX_RETRIES times, waiting with exponential back-off
 * + full jitter between attempts.  Non-transient errors are re-thrown
 * immediately without retrying.
 */
async function withRetry(fn) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return fn(); // fn is synchronous (better-sqlite3)
    } catch (err) {
      const isLastAttempt = attempt === MAX_RETRIES - 1;
      if (isLastAttempt || !isTransient(err)) throw err;

      // Exponential back-off with full jitter: delay ∈ [0, BASE * 2^attempt]
      const cap   = BASE_DELAY_MS * 2 ** attempt;
      const delay = Math.random() * cap;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── Route handlers ───────────────────────────────────────────────────────────

export async function postSignal(req, reply) {
  const idem               = req.headers['idempotency-key'] ?? null;
  const { userId, type, payload } = req.body ?? {};

  // Validate body
  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  // Rate-limit (counted even for idempotent replays; client should handle 429)
  const { ok, remaining, resetMs } = checkAndConsume(userId);
  if (!ok) {
    return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });
  }

  const now = Date.now();

  try {
    if (idem) {
      /**
       * Atomic idempotency path.
       *
       * upsertSignal uses INSERT OR IGNORE + UNIQUE constraint so concurrent
       * requests with the same key never create duplicates — even under race
       * conditions or retries after transient failures.
       */
      const row = await withRetry(() => upsertSignal(userId, type, payload, idem, now));
      return row;
    }

    // Non-idempotent path: plain INSERT
    const info = await withRetry(() => insertSignal(userId, type, payload, null, now));
    return {
      id:             info.lastInsertRowid,
      userId,
      type,
      payload:        String(payload),
      idempotencyKey: null,
      createdAt:      now,
    };
  } catch (err) {
    req.log.error({ err, ctx: 'postSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query ?? {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });

  const lim = Math.min(Number(limit) || 20, 100);

  try {
    const rows = await withRetry(() => listSignals(userId, lim));
    return { items: rows };
  } catch (err) {
    req.log.error({ err, ctx: 'getSignals' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}
