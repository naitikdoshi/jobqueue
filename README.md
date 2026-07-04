# DigitalOcean Job Queue

Custom job queue platform on **DigitalOcean** (DOKS + Managed PostgreSQL + DOCR).

Clients submit async jobs via a control-plane API; **independently scalable workers** pull jobs and run **pluggable handlers**; failures retry and land in a **dead-letter queue**.

## Documentation

| Doc | Description |
|-----|-------------|
| [docs/PLAN.md](docs/PLAN.md) | Executive plan — scope, architecture, build sequence |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, lifecycle, worker polling, handlers |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture decision record (D1–D20) |
| [docs/BUILD-SEQUENCE.md](docs/BUILD-SEQUENCE.md) | DO-first 1-hour phases with verify gates |
| [docs/PREREQUISITES.md](docs/PREREQUISITES.md) | Tools, auth, access checklist |
| [docs/FULL-PLAN.md](docs/FULL-PLAN.md) | Complete planning artifact (all detail) |

## Prerequisites

```bash
./scripts/check-prereqs.sh
```

See [docs/PREREQUISITES.md](docs/PREREQUISITES.md).

## Build (after plan — not started yet)

1. `./scripts/provision.sh` — DOCR, Managed PG, DOKS
2. `./scripts/verify-infra.sh` — connectivity gates
3. Follow [docs/BUILD-SEQUENCE.md](docs/BUILD-SEQUENCE.md)

## Status

**Planning complete · Application code not started**

All verify gates run against **DigitalOcean Ingress** (not localhost).
