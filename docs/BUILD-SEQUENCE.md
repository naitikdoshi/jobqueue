# Build Sequence — DO-first, 1 hour

Every verify gate runs against **DigitalOcean Ingress** (not localhost).

## Timeline

| Phase | Min | Build | ✓ Gate on DO |
|-------|-----|-------|--------------|
| **0** | 0–20 | check-prereqs, provision.sh, verify-infra.sh | DOCR + PG + DOKS Ready |
| **1** | 20–25 | Migration Job on Managed PG | `jobs` table exists |
| **2** | 25–35 | Deploy API → DOCR → DOKS | Ingress /health, POST/GET jobs |
| **3** | 35–40 | Lease / complete / fail routes | Manual curl lease → completed |
| **4** | 40–47 | Deploy worker + echo handler | Auto-complete without manual curl |
| **5** | 47–52 | fail-once, retry, DLQ, sweeper | status dead_letter |
| **6** | 52–55 | Ops depth/cancel, HPA YAML | depth counts, cancel works |
| **7** | 55–60 | e2e-do.sh, GitHub CI | e2e exit 0 |

## Phase 0 commands

```bash
./scripts/check-prereqs.sh
./scripts/provision.sh      # DOCR + Managed PG + DOKS (~8–15 min)
./scripts/verify-infra.sh   # must pass before Phase 1
```

## Phase 2 verify (example)

```bash
export INGRESS_URL=https://$(kubectl get ingress -n jobqueue -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -s $INGRESS_URL/health
curl -s -X POST $INGRESS_URL/v1/jobs -H 'Content-Type: application/json' \
  -d '{"queue":"default","handler":"echo","payload":{"x":1},"priority":"high","max_retry":3,"timeout_sec":60}'
```

## While infra provisions (min 3–18)

Safe to write (not verify): migrations SQL, domain types, Dockerfile, deploy YAML, handler stubs.

## If behind schedule

| Cut last | Never cut |
|----------|-----------|
| CI (Phase 7) | Phase 0 verify-infra |
| HPA (Phase 6) | Phase 1 schema on Managed PG |
| Ops (Phase 6) | Phases 2–5 core loop on Ingress |

## Must-have checklist

- [ ] Managed PostgreSQL + DOKS + DOCR
- [ ] POST/GET jobs (priority, max_retry, timeout_sec)
- [ ] Worker Lease API (long-poll, SKIP LOCKED, priority)
- [ ] Worker Deployment + pluggable handlers
- [ ] Retry + DLQ + sweeper + dedup
- [ ] Ops depth + cancel
- [ ] api-hpa + worker-hpa
- [ ] e2e-do.sh + CI workflow
