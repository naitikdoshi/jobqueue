# Code map — file structure & pointers

Where everything lives and what to read when changing behavior.

Related: [ARCHITECTURE.md](ARCHITECTURE.md), [CODE-AND-DATA.md](CODE-AND-DATA.md), [RUNBOOK.md](RUNBOOK.md).

---

## Repo tree

```
jobqueue/
├── README.md                 # Entry point + doc index
├── package.json              # Scripts: build, test, api, worker
├── tsconfig.json             # TypeScript → dist/
├── Dockerfile                # Multi-stage: build → api | worker images
│
├── docs/                     # Architecture, runbook, decisions, scaling…
├── .github/workflows/ci.yml  # test → deploy → e2e
│
├── migrations/
│   └── 001_jobs.sql          # jobs table + indexes (schema)
│
├── handlers/                 # Pluggable job handlers
│   ├── echo.ts
│   ├── fail-once.ts
│   └── slow.ts
│
├── src/
│   ├── domain/types.ts       # JobRecord, JobHandler, priorities
│   ├── api/
│   │   ├── main.ts           # API entry: startApi()
│   │   └── server.ts         # All HTTP routes + sweeper timer
│   ├── worker/
│   │   ├── main.ts           # Worker entry
│   │   ├── worker.ts         # Poll loop, timeout, complete/fail
│   │   └── registry.ts       # Register handlers
│   └── infrastructure/
│       ├── db.ts             # pg Pool, SSL config
│       └── job-repository.ts # PostgreSQL queue logic
│
├── scripts/
│   ├── provision.sh          # DOCR + PG + DOKS
│   ├── verify-infra.sh       # Pre-deploy gates
│   ├── deploy.sh             # Build + kubectl apply
│   ├── migrate.ts            # Runs 001_jobs.sql
│   ├── e2e-do.sh             # Smoke test on Ingress
│   └── test-scenarios.sh     # Live scenario tests
│
├── tests/                    # Local unit tests (npm test)
│   ├── domain.test.ts
│   ├── repository.test.ts
│   └── scenarios.test.ts
│
├── deploy/                   # Kubernetes manifests
│   ├── api.yaml              # API Deployment + LoadBalancer
│   ├── worker.yaml           # Worker Deployment
│   ├── migrate-job.yaml      # One-shot schema Job
│   ├── kaniko-job.yaml       # In-cluster image build
│   ├── api-hpa.yaml / worker-hpa.yaml
│   └── secret.yaml           # Template only (REPLACE_ME)
│
└── .infra/                   # gitignored — local DATABASE_URL
    └── database-url
```

**Not in git:** `.infra/`, `node_modules/`, `dist/`.

---

## Request flow → files

```
Client POST /v1/jobs
    → src/api/server.ts
    → src/infrastructure/job-repository.ts  (createJob)
    → src/infrastructure/db.ts
    → migrations/001_jobs.sql

Worker POST /v1/worker/lease
    → src/api/server.ts
    → job-repository.ts  (leaseNextJob → tryLeaseOnce)

Worker runs job
    → src/worker/worker.ts
    → src/worker/registry.ts  (getHandler)
    → handlers/*.ts

Worker POST complete/fail
    → server.ts
    → job-repository.ts  (completeJob / failJob)

Every 30s (API pod)
    → server.ts setInterval
    → job-repository.ts  (sweepExpiredLeases)
```

---

## Entry points

| File | Role |
|------|------|
| `src/api/main.ts` | Starts API server |
| `src/api/server.ts` | All routes, sweeper, Fastify app |
| `src/worker/main.ts` | Starts worker |
| `src/worker/worker.ts` | Worker loop, HTTP to API, handler timeout |
| `scripts/migrate.ts` | Migration CLI (migrate Job) |

---

## Domain

| File | Contents |
|------|----------|
| `src/domain/types.ts` | `JobRecord`, `JobStatus`, `JobHandler`, `HandlerResult`, `PRIORITY_WEIGHT` |

---

## Queue / database

| File | Role |
|------|------|
| `src/infrastructure/db.ts` | `getPool()`, `stripSslModeParam`, SSL |
| `src/infrastructure/job-repository.ts` | Core queue engine |
| `migrations/001_jobs.sql` | Table + partial indexes |

### `job-repository.ts` functions

| Function | Purpose |
|----------|---------|
| `createJob` | Submit + idempotent `job_id` |
| `getJobByJobId` / `listJobs` | Status / list |
| `leaseNextJob` / `tryLeaseOnce` | SKIP LOCKED dequeue |
| `completeJob` / `failJob` | Finish lease, retry, DLQ |
| `cancelJob` | Cancel queued/running |
| `queueStatus` | Ops depth |
| `sweepExpiredLeases` | Recover stuck `running` |
| `backoffSeconds` / `isPermanentFailure` | Retry/DLQ rules |
| `toPublicJob` | API JSON shape |

---

## HTTP routes (`src/api/server.ts`)

| Route | Purpose |
|-------|---------|
| `GET /health`, `/ready` | Liveness / PG ping |
| `POST /v1/jobs` | Submit job |
| `GET /v1/jobs`, `/v1/jobs/:id` | List / status |
| `POST /v1/worker/lease` | Worker dequeue |
| `POST /v1/worker/lease/:id/complete` | Worker success |
| `POST /v1/worker/lease/:id/fail` | Worker failure |
| `GET /v1/ops/queues/:q/status` | Queue depth |
| `POST /v1/ops/jobs/:id/cancel` | Cancel job |

---

## Handlers

| File | `handlerType` | Use |
|------|---------------|-----|
| `handlers/echo.ts` | `echo` | Happy path |
| `handlers/fail-once.ts` | `fail-once` | Retry/DLQ tests |
| `handlers/slow.ts` | `slow` | Timeout/cancel tests |
| `src/worker/registry.ts` | — | `registerHandler`, `getHandler` |

**Add a handler:** new file in `handlers/` → register in `registry.ts` → add to `ALLOWED_HANDLERS` in `deploy/api.yaml`.

---

## Deploy & infra scripts

| File | Role |
|------|------|
| `Dockerfile` | Targets `api` and `worker` |
| `scripts/provision.sh` | DOCR, PG, DOKS |
| `scripts/deploy.sh` | Build, secrets, apply, migrate |
| `deploy/api.yaml` | API pods, probes, LoadBalancer |
| `deploy/worker.yaml` | Worker pods, internal `API_URL` |
| `deploy/migrate-job.yaml` | Schema Job |
| `deploy/kaniko-job.yaml` | Build without local Docker |

---

## Tests

| Command / file | Covers |
|----------------|--------|
| `npm test` → `tests/*.test.ts` | Backoff, handlers, DLQ logic |
| `scripts/test-scenarios.sh` | Live Ingress scenarios |
| `scripts/e2e-do.sh` | Submit → completed smoke |

---

## Docker / compile output

```
Dockerfile stages:
  build  → npm install + tsc → dist/
  api    → CMD node dist/src/api/main.js
  worker → CMD node dist/src/worker/main.js
```

---

## Change cheat sheet

| Change | File(s) |
|--------|---------|
| New API endpoint | `src/api/server.ts` |
| Dequeue / retry / DLQ | `src/infrastructure/job-repository.ts` |
| DB / SSL | `src/infrastructure/db.ts`, `scripts/deploy.sh` |
| New handler | `handlers/*.ts`, `registry.ts`, `deploy/api.yaml` |
| Schema | `migrations/001_jobs.sql`, `scripts/migrate.ts` |
| Worker poll / timeout | `src/worker/worker.ts` |
| Sweeper interval | `src/api/server.ts` (`setInterval` 30_000) |
| Pod sizing | `deploy/api.yaml`, `deploy/worker.yaml`, HPA YAML |
| CI | `.github/workflows/ci.yml` |

---

## Mental model

| Layer | Path | Role |
|-------|------|------|
| Plugins | `handlers/` | What runs |
| Worker | `src/worker/` | Poll + dispatch |
| API | `src/api/` | HTTP + sweeper |
| Queue engine | `src/infrastructure/` | PostgreSQL |
| Schema | `migrations/` | Table definition |
| Runtime | `deploy/` | DOKS manifests |
| Ops | `scripts/` | Provision, deploy, test |

**Most important files:** `job-repository.ts` (queue behavior), `server.ts` (HTTP surface).
