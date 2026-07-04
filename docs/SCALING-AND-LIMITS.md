# Scaling, limits, and runtime choices

Why Node.js, what scale the current architecture handles, and what breaks when you depend heavily on PostgreSQL and API pods.

Related: [ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](DECISIONS.md) (D5, D6, D7, D13, D19), [CODE-AND-DATA.md](CODE-AND-DATA.md), [RUNBOOK.md](RUNBOOK.md).

---

## Current deployment baseline

| Resource | MVP size |
|----------|----------|
| Managed PostgreSQL | `db-s-1vcpu-1gb` (1 vCPU, 1 GB) |
| API Deployment | 2 replicas (HPA 2→10, CPU 70%) |
| Worker Deployment | 2 replicas (HPA 2→20, CPU 70%) |
| Queue store | PostgreSQL only (no Redis) |
| Ingress | LoadBalancer → API Service |

---

## Why Node.js (TypeScript + Fastify)? — D5

This was a **pragmatic MVP choice**, not “Node is the best queue runtime.”

| Reason | Detail |
|--------|--------|
| **Speed to ship** | One language for API, worker, and handlers |
| **TypeScript** | Typed job model, handlers, and REST contracts |
| **I/O-bound workload** | API is HTTP + PostgreSQL waits — Node handles that well |
| **Ecosystem** | `pg`, Fastify, native `fetch` in workers — small dependency surface |

**Not chosen for:** maximum throughput, CPU-heavy handlers, or lowest latency dequeue.

**Alternatives deferred:** Go (more boilerplate), Python FastAPI (also viable).

**Node caveat:** A handler that **blocks the event loop** (long CPU work, sync I/O) stalls **that worker pod**. Other pods continue. Mitigation: separate worker Deployments for heavy handlers (Layer 2).

---

## Two scaling planes

The system has **two independent bottlenecks**. Scaling one does not automatically fix the other.

```
                    ACCEPT PATH                 EXECUTE PATH
                    ───────────                 ─────────────
Traffic             Clients POST /v1/jobs       Workers POST /v1/worker/lease
Primary work        INSERT into jobs            SKIP LOCKED dequeue + handler
Scales with         API pod count (HPA)         Worker pod count (HPA)
First bottleneck    PostgreSQL write rate       PostgreSQL dequeue poll rate
```

| Plane | Question it answers |
|-------|---------------------|
| **Accept** | “Can we ingest jobs fast enough?” |
| **Execute** | “Can we hand jobs to workers fast enough?” |

Workers **never** connect to PostgreSQL (D7). Every lease goes **Worker → API → PG**. More workers increase **dequeue pressure on PG**, not worker→PG connections.

---

## Rough capacity (honest estimates)

These are **order-of-magnitude** guides for `db-s-1vcpu-1gb`, not load-test guarantees.

| Workload | Comfortable | Starts to hurt |
|----------|-------------|----------------|
| Job submit bursts | Hundreds/sec (short) | Sustained thousands/sec |
| Queued backlog | Thousands of rows | Very large table without maintenance |
| **Idle workers long-polling** | **2** (current) | **~30–50** on 1 vCPU PG (D19) |
| Active workers (handlers running) | 2 × handler throughput | Long handlers tie slots |
| Status polling | Moderate rate with 2 API pods | Very high poll rate |

### Drain time example

1,000 jobs accepted immediately (all INSERT). Drain time ≈:

```
( job_count / worker_count ) × avg_handler_duration
```

| Workers | Handler | ~Drain time for 1,000 jobs |
|---------|---------|----------------------------|
| 2 | echo (~instant) | Seconds |
| 2 | 60s each | ~8+ hours |
| 20 | echo | Sub-minute |

---

## Long-poll and connection model

Each idle worker holds **one HTTP request** open to the API for up to **20 seconds** (`waitTimeSec`).

Inside the API, `leaseNextJob` loops:

1. Short PG transaction (`tryLeaseOnce`) — **milliseconds**
2. Release PG connection
3. `sleep(1s)`
4. Repeat until job found or deadline

| Resource | Held for 20s? |
|----------|----------------|
| HTTP connection (worker ↔ API) | **Yes** — one per idle worker slot |
| PostgreSQL connection | **No** — only during each dequeue attempt |
| API async handler | Yes — cheap (sleep + short queries) |

**Empty-queue load:** ~**1 dequeue transaction per second per idle worker**.

| Idle workers | PG dequeue queries/sec |
|--------------|------------------------|
| 2 | ~2 |
| 20 | ~20 |
| 50 | ~50 |

That poll rate is the main **execute-path ceiling** on small Managed PG (D19).

---

## PostgreSQL as single dependency — D6

PostgreSQL is **everything** in MVP:

| Role | How |
|------|-----|
| Queue | `status = 'queued'` rows |
| Running leases | `running` + `lease_id` + `lease_expires_at` |
| Retries | `next_retry_at` |
| DLQ | `status = 'dead_letter'` |
| Job history | Same table |

**Wins:** one durable store, ACID leases, no Redis to operate.  
**Cost:** every hot path hits PG — INSERT, SKIP LOCKED, UPDATE, sweeper, ops aggregates.

---

## API pod scaling — issues and limits

The API is not “just REST.” Each pod runs:

| Responsibility | Load |
|----------------|------|
| `POST /v1/jobs` | INSERT |
| `GET /v1/jobs` | SELECT |
| `POST /v1/worker/lease` (long-poll) | Open HTTP + ~1 dequeue/sec per waiting worker |
| complete / fail | Lease-guarded UPDATE |
| **Sweeper** | Every 30s per pod — expired leases → `failJob` |
| Ops | GROUP BY aggregations |

### Issue 1: API scales HTTP, PG may not

More API pods help submit and status traffic. Dequeue capacity is bounded by **PostgreSQL**, not API replica count. On an empty queue, more API pods can mean **more concurrent dequeue attempts** hitting the same PG.

### Issue 2: Long-poll consumes API connections

| Workers | Open lease HTTP connections (idle) |
|---------|-------------------------------------|
| 2 | 2 |
| 50 | 50 |
| 200 | 200 (watch file descriptors + memory) |

PG connections stay short-lived; **HTTP** connections are the API-side stress.

### Issue 3: Duplicate sweepers

Each API pod runs:

```typescript
setInterval(() => sweepExpiredLeases(), 30_000);
```

With **2 API replicas**, both sweep the same expired leases. Usually safe (second `failJob` no-ops) but redundant PG work.

**Layer 2:** dedicated sweeper Job, or advisory lock / leader election.

### Issue 4: Connection pool per API pod

Default `PG_POOL_MAX` ≈ 20 per pod. Ten API pods → up to ~200 PG connections. Watch Managed PG connection limits.

### Issue 5: CPU-based HPA is blunt

HPA uses **CPU**, not queue depth or lease latency. API CPU can look healthy while PG is saturated from dequeue polls.

**Layer 2:** custom metrics — `queue_depth`, `lease_latency_seconds`.

---

## Worker scaling — PG still limits you

```
Worker pod ──HTTP long-poll──► API pod ──SKIP LOCKED──► PostgreSQL
```

| More workers | Effect |
|--------------|--------|
| Good | More handlers run in parallel when jobs exist |
| Bad (empty queue) | More dequeue polls/sec on PG |
| Bad (saturated PG) | Higher lease latency → timeouts → retries → more load |

**Layer 3 escape:** Redis (or similar) as dequeue buffer. Workers keep the same HTTP lease API; PG remains source of truth for state, not every poll.

---

## Where it breaks first (on current infra)

```
Clients ──► [ API × N ] ──► PostgreSQL  ◄── bottleneck #1
                ▲
Workers ────────┘   (long-poll × worker count)
```

On **`db-s-1vcpu-1gb`**, expect pain in this order:

1. **Many idle workers** — dequeue poll storm (~1 query/sec/worker)
2. **High sustained submit rate** — INSERT contention
3. **Duplicate sweepers + many API pods** — extra PG writes on recovery path
4. **Heavy ops aggregations** — less common than 1–3

---

## Sweeper (who runs it)

The **API process** runs the sweeper — not workers. See [USER-FLOWS.md](USER-FLOWS.md) and `src/api/server.ts` (`setInterval` every 30s).

Recovery path for at-least-once:

```
Worker dies without complete/fail
  → lease_expires_at passes
  → API sweeper → failJob(LEASE_EXPIRED) → requeue (or DLQ)
  → another worker leases again
```

---

## Layer roadmap when you outgrow MVP

| Layer | When | Mitigation |
|-------|------|------------|
| **2** | ~10–30 workers, need smarter scale | Queue-depth HPA, dedicated sweeper, bigger PG, `LISTEN/NOTIFY` to reduce blind polling, Prometheus |
| **3** | ~30–50+ idle workers | Redis ZSET/list dequeue buffer in front of PG |
| **4** | Production hardening | Auth, Terraform, cron/delayed jobs, KEDA |

---

## Quick reference

| Question | Answer |
|----------|--------|
| Why Node.js? | Fast MVP, one TS codebase, I/O-bound API |
| Comfortable scale today | Small prod / demo: few workers, thousands queued jobs |
| Hard ceiling (no Redis) | ~**30–50 idle workers** on 1 vCPU PG |
| Main DB risk | PG is queue + state — single choke point |
| Main API risk | Long-polls + N× sweepers + pool × replicas |
| What scales well | Accept (more API), execution (more workers **if** PG keeps up) |
| What does not (MVP) | Unlimited workers on PG dequeue; exactly-once execution |

---

## Monitoring signals (Layer 2)

| Signal | Meaning |
|--------|---------|
| `depthByStatus.queued` rising | Workers slower than submit rate — scale workers |
| Lease latency up | PG dequeue contention — Redis or bigger PG |
| PG CPU high, queue often empty | Too many idle pollers — reduce workers or add Redis |
| API connections high, PG OK | Long-poll fan-out — normal at scale; watch API limits |
| DLQ depth rising | Handler or config problem — not a scale issue |
