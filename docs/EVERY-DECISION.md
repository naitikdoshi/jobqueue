# Jobqueue — every decision

From-first-principles guide to **what we built**, **why each piece exists**, and **what we deliberately deferred**.

Related docs:

| Topic | Doc |
|-------|-----|
| High-level architecture (diagrams) | [ARCHITECTURE.md](ARCHITECTURE.md) |
| ADR table (D1–D20) | [DECISIONS.md](DECISIONS.md) |
| Code + PostgreSQL pattern | [CODE-AND-DATA.md](CODE-AND-DATA.md) |
| User & operator flows | [USER-FLOWS.md](USER-FLOWS.md) |
| Operations runbook | [RUNBOOK.md](RUNBOOK.md) |

---

## Part 0: The problem

You need a system where:

1. A **client** submits work asynchronously.
2. **Workers** pull work when ready (pull, not push).
3. Work **survives crashes** (durable queue).
4. Failures **retry**, then land in a **dead-letter queue (DLQ)**.
5. Clients **check status** (`queued` → `running` → `completed` / `dead_letter`).
6. Operators get **visibility** (depth, cancel).

That is a **job queue**. AWS has SQS; we built a **custom one on DigitalOcean** (D1, D4).

**Why custom?** Full control, DO-native infra, pluggable handlers, no AWS SDK lock-in.  
**Trade-off:** You own correctness, scaling, and ops.

---

## Part 1: What is a job?

Every job is one durable row:

| Field | Meaning |
|-------|---------|
| `jobId` | Client-visible id (optional; server UUID if omitted) |
| `queue` | Logical queue name — workers subscribe to queues |
| `handler` | Which code runs (`echo`, `fail-once`, `slow`) |
| `payload` | JSON input |
| `priority` | `critical` / `high` / `normal` / `low` → weights 4/3/2/1 |
| `max_retry` | Max **attempts** before DLQ |
| `timeout_sec` | Max handler runtime; drives lease expiry |

**Statuses:**

```
queued → running → completed
                 → dead_letter (permanent fail or max retries)
                 → queued again (transient fail + backoff)
queued/running → cancelled (ops cancel)
```

**Nuance:** No persistent `failed` row status. Transient failures return to `queued` with `next_retry_at`. Terminal: `completed`, `dead_letter`, `cancelled`.

---

## Part 2: Three API surfaces

```
Client ──► Jobs API ──► API pods ──► PostgreSQL
Worker ──► Worker Lease API ──► (same API pods)
Operator ──► Ops API ──► (same API pods)
```

| Surface | Routes | Audience |
|---------|--------|----------|
| **Jobs API** | `POST/GET /v1/jobs`, `GET /v1/jobs?queue=` | End users |
| **Worker Lease API** | `POST /v1/worker/lease`, complete, fail | Worker fleet |
| **Ops API** | queue status, cancel | Operators |

**Decision D7:** Workers **never** connect to PostgreSQL.

**Why?** Centralized pooling + SKIP LOCKED; workers scale without N× DB connections; workers only need HTTP creds. **Cost:** extra hop per lease.

---

## Part 3: PostgreSQL as the queue (D6, D8)

**First principle:** A queue is rows waiting to be consumed.

| Choice | Reason |
|--------|--------|
| Single `jobs` table | One lifecycle: queue, running, history, DLQ |
| No Redis in MVP | Fewer parts; PG already durable |
| `FOR UPDATE SKIP LOCKED` | Concurrent workers don't block |
| Partial index on `queued` | Small, fast dequeue scans |
| `ORDER BY priority DESC, created_at ASC` | Durable priority (D8), not in-memory heap |

**Dequeue (core transaction):**

```sql
BEGIN;
SELECT * FROM jobs
  WHERE queue = $1 AND status = 'queued'
    AND (next_retry_at IS NULL OR next_retry_at <= now())
  ORDER BY priority DESC, created_at ASC
  LIMIT 1 FOR UPDATE SKIP LOCKED;
UPDATE jobs SET status='running', lease_id=..., attempt=attempt+1,
  lease_expires_at = now() + timeout_sec;
COMMIT;
```

**Scale ceiling (D19):** ~30–50 idle pollers on small PG. **Layer 3 escape:** Redis buffer; worker HTTP contract unchanged.

---

## Part 4: Leases and at-least-once (D9)

**At-least-once:** Every submitted job is **offered to a worker at least once**, unless cancelled. Workers **may run the same job twice** after crashes.

| Guaranteed | Mechanism |
|------------|-----------|
| Job not lost | Durable PG row |
| One owner at a time | `lease_id` + `status=running` |
| Crash recovery | `lease_expires_at` + sweeper (30s) |
| No duplicate **completion** | complete/fail require `lease_id` + `running` |

| Not guaranteed | Mitigation |
|----------------|------------|
| Exactly-once **execution** | Idempotent handlers |
| Instant cancel of running handler | Best-effort; see USER-FLOWS.md |

**Submit idempotency:** UNIQUE `job_id`; `ON CONFLICT DO NOTHING` → return existing row.

**Execution idempotency:** Handler responsibility — dedupe on `jobId` + `attempt` before side effects.

---

## Part 5: Workers and handlers (D11)

Workers loop: lease → run handler → complete/fail.

**Long-poll:** ~1 dequeue query/sec per idle worker when queue empty.

**Handlers (Open/Closed):**

```typescript
interface JobHandler {
  handlerType: string;
  handle(ctx: JobContext, payload): Promise<HandlerResult>;
}
```

Outcomes: `success` | `transient_failure` | `permanent_failure`.

| Handler | Purpose |
|---------|---------|
| `echo` | Happy path |
| `fail-once` | Retry / DLQ testing |
| `slow` | Timeout / cancel testing |

**Timeout:** Worker `AbortSignal` + DB `lease_expires_at` + sweeper.

---

## Part 6: Retry, backoff, DLQ (D10)

```
attempt < max_retry  →  queued + next_retry_at (10→30→90→300s)
attempt >= max_retry →  dead_letter
permanent_failure    →  dead_letter
```

DLQ = `status = 'dead_letter'` on same table (no separate DLQ table in MVP).

---

## Part 7: Infrastructure (D2, D3, D12, D20)

| Service | Role |
|---------|------|
| Managed PostgreSQL | Queue + state |
| DOKS | api + worker Deployments, HPA |
| DOCR | Container images |
| LoadBalancer | Public Ingress |

**Separate api/worker Deployments (D12):** Accept and execute scale independently.

**DO-only (D20):** All verify gates on live Ingress; PG firewall allows DOKS only.

**Provisioning (D3):** `doctl` scripts; Terraform deferred.

**Production lessons:**
- Kaniko needs `--target=api|worker` per image
- Strip `sslmode` from DATABASE_URL for Node `pg` pool
- `doctl databases get` by name may 404 — use DB ID

---

## Part 8: Application structure (D5, D17, D18)

```
handlers/           → plugins
src/domain/         → types
src/worker/         → poll + registry (no DB)
src/api/            → Fastify routes
src/infrastructure/ → pg + job-repository
```

**Skipped for speed (D17):** formal ports, use-case layer. **Done well:** handler plugins (D18).

---

## Part 9: CI/CD (D16)

```
PR/push → test (npm test + build)
master  → deploy (DOKS)
       → e2e (live Ingress scenarios)
```

GitHub secret: `DIGITALOCEAN_ACCESS_TOKEN`. Repo: https://github.com/naitikdoshi/jobqueue

---

## Part 10: Deferred (Layers 2–4)

| Area | MVP | Later |
|------|-----|-------|
| Auth (D14) | None | JWT / API keys |
| Metrics (D15) | Ops JSON + logs | Prometheus |
| Redis (D6 escape) | PG only | Front buffer |
| Heartbeat | Lease = timeout | Extend long jobs |
| Bulk cancel / per-user list | Partial | Layer 2 |
| Terraform (D3) | doctl scripts | Layer 4 |

---

## Part 11: All 20 decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Platform | Custom queue on DO |
| D2 | Infra | DOKS + Managed PG + DOCR |
| D3 | Provision | `doctl` scripts |
| D4 | API | Custom REST |
| D5 | Runtime | TypeScript + Fastify |
| D6 | Queue | PostgreSQL SKIP LOCKED |
| D7 | Workers | HTTP lease API only |
| D8 | Priority | PG index ORDER BY |
| D9 | Delivery | At-least-once + lease dedup |
| D10 | Failures | Retry + DLQ |
| D11 | Handlers | JobHandler registry |
| D12 | Deploy | Separate api/worker |
| D13 | Scale | Dual HPA (CPU) |
| D14 | Auth | None |
| D15 | Observability | Ops JSON + logs |
| D16 | CI/CD | GitHub Actions |
| D17 | Scope | 1-hour MVP + layers |
| D18 | Extensibility | Ports deferred |
| D19 | Poll load | Long-poll + indexes |
| D20 | Environment | DigitalOcean only |

---

## Mental model (one paragraph)

Submit a **durable row** in PostgreSQL. **API pods** dequeue with **SKIP LOCKED**, grant a **lease** to **workers** over HTTP. Workers run **pluggable handlers** with **timeout**. Success completes; failure **retries with backoff** or **DLQ**. **Sweeper** fixes crashed workers. Delivery is **at-least-once** — handlers must be **idempotent**; platform prevents duplicate **completions** via **lease_id**. Runs on **DigitalOcean**, verified on **live Ingress**, with **CI** test → deploy → e2e.
