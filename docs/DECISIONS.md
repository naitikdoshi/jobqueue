# Architecture Decisions (ADR)

| # | Decision | Choice | Trade-off accepted |
|---|----------|--------|-------------------|
| D1 | Platform | Custom job queue on DO | No AWS SQS SDK |
| D2 | Cloud infra | DOKS + Managed PG + DOCR | ~10 min provision wait |
| D3 | Provisioning | `doctl` scripts (MVP) | Terraform in Layer 4 |
| D4 | API style | Custom REST | Not SQS-compatible |
| D5 | Runtime | TypeScript + Fastify | Team needs TS |
| D6 | Queue store | PostgreSQL SKIP LOCKED | Dequeue ceiling → Redis L3 |
| D7 | Worker ↔ DB | HTTP Worker Lease API only | Extra hop; better pooling |
| D8 | Priority | PG index ORDER BY (not heap) | Shared durable ordering |
| D9 | Delivery | At-least-once + lease dedup | Handlers must be idempotent |
| D10 | Failures | Retry + DLQ on max_retry | Monitor DLQ |
| D11 | Handlers | JobHandler registry | Rebuild image per handler (MVP) |
| D12 | Deploy | Separate api/worker Deployments | Two images |
| D13 | Autoscale | Dual HPA api + worker | CPU MVP; queue metric L2 |
| D14 | Auth | None in MVP | Layer 4 JWT |
| D15 | Observability | Ops JSON + logs | Prometheus L2 |
| D16 | CI/CD | GitHub Actions + e2e-do | Needs DO token secret |
| D17 | Scope | 1-hour MVP + layers | Many features deferred |
| D18 | Extensibility | Domain ports QueuePort etc. | Light refactor OK later |
| D19 | Poll protection | Long-poll + indexes; Redis L3 | ~30–50 worker PG limit |
| D20 | Target env | **DigitalOcean only** | No local-MVP fallback |

## Key trade-offs

### PostgreSQL as queue
- **Win:** single durable store, ACID leases
- **Cost:** dequeue contention at scale → Redis front buffer (Layer 3)
- **Implementation detail:** [CODE-AND-DATA.md](CODE-AND-DATA.md) — SKIP LOCKED dequeue, lease columns, partial indexes, backoff, DLQ as status

### At-least-once
- **Win:** simpler than exactly-once
- **Cost:** idempotent handlers required for side effects

### DO-first 1 hour
- **Win:** demo runs on real infra
- **Cost:** ~15 min infra wait; requires token + docker + kubectl
