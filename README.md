# Signals Challenge (Node.js + Fastify)

Build a minimal production-leaning service that can **handle load**, **rate limit**, and **avoid duplicates** via idempotency.

## Endpoints

- `POST /v1/signals`
  - body: `{ "userId": "string", "type": "string", "payload": "string" }`
  - headers: `X-API-Key`, `Idempotency-Key` (optional)
  - behaviors:
    - **Rate limit** per `userId`: `RATE_LIMIT_PER_MIN` per minute (default 5).
    - **Idempotency**: same `Idempotency-Key` returns the same resource — safe under concurrency.
- `GET /v1/signals?userId=...&limit=...`
- `GET /healthz`

## Implementation highlights

### Rate limiter (`src/rateLimit.js`)

Sliding-window log per user — timestamps within the last 60 s are kept in a `Map<userId, number[]>`.  
On each request: evict stale timestamps, check count < RATE, push if allowed.  
Stale entries are evicted every 5 min to prevent unbounded memory growth.  
**Multi-instance path:** replace the Map with a Redis sorted-set Lua script (see SCALE.md).

### Idempotency (`src/signals.js` + `src/db.js`)

`upsertSignal` uses `INSERT OR IGNORE` on the `idempotency_key UNIQUE` column, then `SELECT`.  
This is **atomic at the DB level** — concurrent requests for the same key never create duplicates, even without application-level locks.  
The caller always receives the canonical row.

### Retry / back-off (`src/signals.js`)

All DB calls are wrapped in `withRetry(fn, maxRetries=3)`:
- Catches `SQLITE_BUSY` / `SQLITE_LOCKED` / simulated failures.
- Exponential back-off with full jitter: `delay = random() * BASE * 2^attempt`.
- Non-transient errors are re-thrown immediately.
- No duplicate risk on retry because idempotency is enforced at the DB level.

## Setup

```bash
# We recommend using Node v20/v22 LTS (specified in .nvmrc) to avoid native build issues with better-sqlite3.
nvm use
cp .env.example .env        # set API_KEY, DATABASE_URL, RATE_LIMIT_PER_MIN
npm install
npm run dev                 # starts on PORT (default 8080)
```

## Tests

```bash
npm test                    # runs tests/idempotency.test.js & tests/rate-limit.test.js
```

## Benchmark

```bash
npm run dev &
npm run bench
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `API_KEY` | `change-me` | Required header value for `X-API-Key` |
| `PORT` | `8080` | Listening port |
| `DATABASE_URL` | `./data/signals.db` | SQLite DB path |
| `RATE_LIMIT_PER_MIN` | `5` | Max requests per user per 60 s |
| `DB_FAIL_RATE` | `0` | Fraction of DB calls to simulate failure (0–1) |

See [SCALE.md](./SCALE.md) for the 10 k RPS architecture and cost breakdown.
