# Scale Plan — 10 k RPS

## Data model / indexes

- `signals(id)` — auto-increment primary key; keep writes append-only.
- `idx_user_created` on `(user_id, created_at DESC)` — covers the `GET /v1/signals?userId=` query with no table scan.
- `idx_idem` — partial index on `idempotency_key WHERE idempotency_key IS NOT NULL` — keeps the uniqueness check tight and avoids indexing NULLs.
- Enable **WAL mode** (`PRAGMA journal_mode=WAL`) for SQLite so readers don't block the writer.  For PostgreSQL, this is the default MVCC behaviour.
- Partition `signals` by month (`created_at`) in PostgreSQL; drop old partitions to keep hot data small.

---

## Idempotency across instances

**Current (single node):** `INSERT OR IGNORE` on the `idempotency_key UNIQUE` column, followed by `SELECT`.  Atomic at the DB level; no in-process race.

**Multi-node:** Two strategies:

| Strategy | Mechanism | Trade-offs |
|---|---|---|
| **DB-native** | PostgreSQL `INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING *` | Simple, no extra infra; DB is the single source of truth |
| **Redis pre-screen** | `SET idem:<key> <payload> NX EX 86400` before writing to DB | Reduces DB load; adds Redis dependency; must handle Redis outage (fail-open to DB path) |

Chosen approach for scale: **DB-native first** (simplest, correct by default), with Redis as a read-layer cache once DB write throughput becomes a bottleneck.

---

## Rate limiting across instances

**Current (single node):** In-memory sliding-window Map; correct for one process.

**Multi-node replacement — Redis sliding window (Lua script):**

```lua
-- KEYS[1] = "rl:<userId>",  ARGV[1] = nowMs, ARGV[2] = windowStartMs, ARGV[3] = limit
local key = KEYS[1]
redis.call('ZREMRANGEBYSCORE', key, '-inf', ARGV[2])   -- evict old entries
local count = redis.call('ZCARD', key)
if count < tonumber(ARGV[3]) then
  redis.call('ZADD', key, ARGV[1], ARGV[1])            -- add current ts
  redis.call('PEXPIRE', key, 60000)
  return {1, tonumber(ARGV[3]) - count - 1}            -- {allowed, remaining}
end
return {0, 0}                                          -- {denied, 0}
```

One atomic round-trip per request; no race between ZADD and ZCARD.

---

## Horizontal scale — 10 k RPS infra sketch

```
                        ┌───────────────────────────────────────┐
Clients ──► ALB ──────► │  N × Node.js (ECS Fargate / k8s)     │
                        │  • 2 vCPU / 2 GB each                 │
                        │  • Fastify + connection pooling        │
                        └──────────┬──────────────┬─────────────┘
                                   │              │
                           ┌───────▼──────┐  ┌───▼──────────────┐
                           │ Redis Cluster │  │ PostgreSQL RDS    │
                           │ (ElastiCache) │  │ (Multi-AZ, r6g.l)│
                           │ rate limit +  │  │ signals storage  │
                           │ idem cache    │  │ + idempotency    │
                           └──────────────┘  └──────────────────┘
```

**Capacity maths (back-of-envelope):**

- 10 k RPS × ~2 ms avg DB query = ~20 concurrent DB connections needed.  
  Pool size = 20 connections across 5 Fargate tasks (4 each) is sufficient.
- Redis: single `r6g.large` handles > 100 k ops/s — no bottleneck.
- Write amplification per request: 1 INSERT + 1 rate-limit Lua call + optional SELECT.

**Monthly cost estimate (AWS us-east-1):**

| Component | Size | ~$/mo |
|---|---|---|
| ECS Fargate (API) | 5 × 2 vCPU / 2 GB | $200 |
| ElastiCache Redis | r6g.large, 1 shard (HA) | $130 |
| RDS PostgreSQL | db.r6g.large, Multi-AZ | $350 |
| ALB | 10 k RPS | $50 |
| Data transfer | ~100 GB/mo | $10 |
| **Total** | | **~$740/mo** |

---

## Observability

- **Structured logs** — Fastify's pino already emits JSON; ship to CloudWatch / Datadog.
- **Prometheus metrics** (add `fastify-metrics` plugin):
  - `signals_created_total{result="ok|idem|rejected"}` 
  - `rate_limit_hits_total{userId}` 
  - `db_retries_total{attempt}` 
  - `http_request_duration_seconds` (p50 / p95 / p99)
- **Alerts:**
  - `db_retries_total` rate spikes → DB struggling.
  - HTTP error rate > 0.1 % → investigate.
  - p99 latency > 200 ms → scale out or optimize queries.

---

## Failure modes

| Failure | Current behaviour | At-scale behaviour |
|---|---|---|
| Transient DB error | Retry × 3, exponential back-off + jitter | Same; circuit-breaker opens after threshold |
| Hard DB outage | 503 after max retries | Circuit-breaker opens immediately; fast 503 |
| Duplicate idempotency key (concurrent) | `INSERT OR IGNORE` + SELECT; both callers get same row | Same via DB `ON CONFLICT DO NOTHING` |
| Redis down | N/A (single node) | Fail-open on rate limit; idempotency falls back to DB |
| Node.js crash mid-write | Client retries; idempotency key prevents duplicate | Same |
| Rate limit bypass attempt | Sliding window prevents burst exploitation at boundary | Redis Lua script is atomic; no race |

---

## Further optimisations (beyond 10 k RPS)

1. **Read replica** for `GET /v1/signals` — offloads reads from the primary.
2. **SQS / Kafka queue** — decouple write spikes; workers drain into DB asynchronously (trade consistency for throughput).
3. **HTTP/2 multiplexing** — reduces connection overhead from mobile clients.
4. **Bloom filter** on idempotency keys — reject known-existing keys before hitting Redis.
