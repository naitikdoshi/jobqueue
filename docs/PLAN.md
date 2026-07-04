# Executive Plan — DigitalOcean Job Queue

## Goal

Ship a **working MVP on DigitalOcean in ~1 hour** with incremental verify gates on live infra — not a local-only demo.

## What we build

| Surface | Users | Purpose |
|---------|-------|---------|
| **Jobs API** | End users | `POST /v1/jobs`, `GET /v1/jobs/{id}` |
| **Worker Lease API** | Worker fleet | `POST /v1/worker/lease`, complete, fail |
| **Ops API** | Operators | Queue depth, cancel, health |

## Job model

Every job: `jobId`, `queue`, `handler`, `payload`, `priority`, `max_retry`, `timeout_sec`.

**Statuses:** `queued` → `running` → `completed` | `failed` → retry | `dead_letter` | `cancelled`

## DigitalOcean services (MVP)

| Service | Role |
|---------|------|
| **Managed PostgreSQL** | Durable job store + queue (`SKIP LOCKED`) |
| **DOKS** | Separate `api` and `worker` Deployments + HPA |
| **DOCR** | Container images |
| **Load Balancer** | Public Ingress to API |

**Not in MVP:** Redis (Layer 3 escape for dequeue scale), Prometheus (Layer 2).

## Architecture (one glance)

```
Client ──► DO LB ──► API (DOKS) ──► Managed PostgreSQL
                         ▲
Worker pods (DOKS) ──────┘  HTTP lease/complete/fail only
```

Workers **never** connect to PostgreSQL directly.

## Must-have scope (hour 1)

- Infra: `doctl` → DOCR + Managed PG + DOKS + verify script
- Submit + status API with priority, max_retry, timeout_sec
- Lease engine: long-poll, SKIP LOCKED, priority ORDER BY
- Worker Deployment + pluggable handlers (echo, fail-once)
- Retry + DLQ + lease sweeper + lease dedup
- Ops depth + cancel
- api-hpa + worker-hpa manifests
- `scripts/e2e-do.sh` + GitHub CI workflow

## Deferred post-MVP

Redis hot queue, Prometheus/Grafana, heartbeat, JWT auth, delayed/recurring jobs.

## Build principles

1. **DO only** — every gate hits Ingress URL on DOKS
2. **Infra first** — `verify-infra.sh` before app deploy
3. **Incremental verify** — curl/e2e after each phase
4. **Foundation in migrations** — dequeue indexes from day 1

## Success checklist

See [BUILD-SEQUENCE.md](BUILD-SEQUENCE.md) for phase gates and [DECISIONS.md](DECISIONS.md) for trade-offs.
