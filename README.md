# Jobqueue

Custom job queue platform on **DigitalOcean** (DOKS + Managed PostgreSQL + DOCR).

Clients submit async jobs via a control-plane API; **independently scalable workers** pull jobs and run **pluggable handlers**; failures retry and land in a **dead-letter queue**.

## Documentation

| Doc | Description |
|-----|-------------|
| [docs/PLAN.md](docs/PLAN.md) | Executive plan — scope, architecture, build sequence |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, lifecycle, worker polling, handlers |
| [docs/CODE-AND-DATA.md](docs/CODE-AND-DATA.md) | Code review, Open/Closed assessment, PostgreSQL queue pattern |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture decision record (D1–D20) |
| [docs/BUILD-SEQUENCE.md](docs/BUILD-SEQUENCE.md) | DO-first 1-hour phases with verify gates |
| [docs/PREREQUISITES.md](docs/PREREQUISITES.md) | Tools, auth, access checklist |
| [docs/FULL-PLAN.md](docs/FULL-PLAN.md) | Complete planning artifact (all detail) |

## Prerequisites

```bash
./scripts/check-prereqs.sh
npm test                  # local unit tests (all scenarios)
./scripts/test-scenarios.sh  # live DO Ingress tests
```

See [docs/PREREQUISITES.md](docs/PREREQUISITES.md).

## Build

1. `./scripts/provision.sh` — DOCR, Managed PG, DOKS
2. `./scripts/verify-infra.sh` — connectivity gates
3. `./scripts/deploy.sh` — Kaniko build, API, worker, migration
4. `./scripts/test-scenarios.sh` — live scenario tests on Ingress
5. `./scripts/e2e-do.sh` — smoke e2e

See [docs/BUILD-SEQUENCE.md](docs/BUILD-SEQUENCE.md).

## Status

**Deployed on DO** — Ingress `http://165.245.153.10` (API 2/2, worker 2/2, migration applied)

All verify gates run against **DigitalOcean Ingress** (not localhost).
