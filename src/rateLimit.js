/**
 * Sliding-window rate limiter (single-instance, in-memory).
 *
 * Per user we keep a sorted list of request timestamps within the last 60 s.
 * Node.js is single-threaded, so Map access is safe without locks on a single
 * instance.  For multi-instance deployments, swap this for a Redis-backed Lua
 * script — see SCALE.md.
 */

const RATE = Number(process.env.RATE_LIMIT_PER_MIN || 5);
const WINDOW_MS = 60_000;

/** @type {Map<string, number[]>} */
const buckets = new Map();

/**
 * Check whether `userId` is within their per-minute quota and, if so, record
 * the request.
 *
 * @param {string} userId
 * @param {number} [nowMs]  — injectable for testing
 * @returns {{ ok: boolean, remaining: number, resetMs: number }}
 */
export function checkAndConsume(userId, nowMs = Date.now()) {
  const windowStart = nowMs - WINDOW_MS;

  // Slide the window: discard timestamps that have fallen outside the rolling 60 s.
  const timestamps = (buckets.get(userId) ?? []).filter((ts) => ts > windowStart);

  const ok = timestamps.length < RATE;

  if (ok) {
    timestamps.push(nowMs);
  }

  buckets.set(userId, timestamps);

  const remaining = Math.max(RATE - timestamps.length, 0);
  // resetMs = when the oldest in-window request drops out, freeing a slot.
  const resetMs =
    timestamps.length > 0 ? timestamps[0] + WINDOW_MS : nowMs + WINDOW_MS;

  return { ok, remaining, resetMs };
}

/**
 * Remove user entries whose entire window has expired.
 * Prevents unbounded Map growth under long-lived processes.
 * Exported for testing; called automatically every 5 min.
 */
export function evictStale(nowMs = Date.now()) {
  const windowStart = nowMs - WINDOW_MS;
  for (const [userId, timestamps] of buckets) {
    const fresh = timestamps.filter((ts) => ts > windowStart);
    if (fresh.length === 0) buckets.delete(userId);
    else buckets.set(userId, fresh);
  }
}

// Periodic cleanup — .unref() so this interval doesn't block process exit.
setInterval(() => evictStale(), 5 * 60_000).unref();
