# Runbook — Jobqueue on DigitalOcean

Operational guide: provision, deploy, verify, troubleshoot, tear down.

**Ingress (current):** `http://165.245.153.10`  
**Namespace:** `jobqueue`  
**Cluster / registry / DB:** `jobqueue` / `jobqueue` / `jobqueue-pg`

---

## Prerequisites

```bash
./scripts/check-prereqs.sh
doctl auth init   # if needed
gh auth login     # for CI only
```

Required: `doctl`, `kubectl`, `node`, `npm`, `git`. Local Docker optional (Kaniko on DOKS used when absent).

---

## Initial provision (once)

```bash
./scripts/provision.sh      # DOCR + Managed PG + DOKS (~8–15 min)
./scripts/verify-infra.sh   # must pass before deploy
```

Artifacts: `.infra/database-url` (gitignored — **never commit**).

**Known issue:** `doctl databases get jobqueue-pg` may 404 by name; scripts use DB **ID** from list.

---

## Deploy application

```bash
./scripts/deploy.sh           # api + worker + migration + HPA
# or:
./scripts/deploy.sh api       # api + migrate only
./scripts/deploy.sh worker    # worker only
```

What deploy does:

1. DOCR login + K8s pull secret
2. Create/update `jobqueue-secrets` (DATABASE_URL, sslmode stripped)
3. Kaniko build (if no local Docker) or docker build
4. Rollout `api`, run `migrate` Job, rollout `worker`, apply HPA

**Force worker to pull new image:**

```bash
kubectl rollout restart deployment/worker -n jobqueue
kubectl rollout restart deployment/api -n jobqueue
```

---

## Verify deployment

```bash
export INGRESS=http://165.245.153.10   # or:
export INGRESS=http://$(kubectl get svc api -n jobqueue -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

curl -s $INGRESS/health
curl -s $INGRESS/ready

npm test                              # local unit tests
./scripts/e2e-do.sh                   # smoke e2e
./scripts/test-scenarios.sh           # 14 live scenarios
```

---

## Common operations

### Submit a job

```bash
curl -s -X POST $INGRESS/v1/jobs \
  -H 'Content-Type: application/json' \
  -d '{"queue":"default","handler":"echo","payload":{"x":1},"priority":"high","max_retry":3,"timeout_sec":60}'
```

### Get job status

```bash
curl -s $INGRESS/v1/jobs/JOB_ID
```

### List recent jobs on a queue

```bash
curl -s "$INGRESS/v1/jobs?queue=default&limit=20"
```

### Queue depth (ops)

```bash
curl -s $INGRESS/v1/ops/queues/default/status
```

### Cancel job (queued or running)

```bash
curl -s -X POST $INGRESS/v1/ops/jobs/JOB_ID/cancel
```

### Kubernetes status

```bash
kubectl get pods,deploy,svc,hpa,jobs -n jobqueue
kubectl logs -n jobqueue deployment/api --tail=50
kubectl logs -n jobqueue deployment/worker --tail=50
kubectl logs -n jobqueue job/migrate
```

---

## CI/CD (GitHub Actions)

Workflow: `.github/workflows/ci.yml`

| Job | Trigger | Needs |
|-----|---------|-------|
| test | push, PR | — |
| deploy | push to master | `DIGITALOCEAN_ACCESS_TOKEN` secret |
| e2e | after deploy | same secret + live cluster |

Re-run failed jobs: Actions → ci workflow → Re-run failed jobs.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `/ready` 503, SSL errors in logs | `sslmode=require` in DATABASE_URL | Redeploy secret (deploy.sh strips sslmode) or restart API pods |
| API pods crash, worker logs in API | Kaniko built wrong stage | Ensure `--target=api` in kaniko-job.yaml |
| `relation "jobs" does not exist` | Migration not run | `kubectl apply -f deploy/migrate-job.yaml` |
| Worker 500 on lease | Same as above | Run migrate Job |
| Deploy rollout timeout | Readiness waits on PG | Fix DATABASE_URL / SSL first |
| Local migrate ETIMEDOUT | PG firewall blocks devcontainer | Run migrate Job in cluster only |
| CI deploy: `token` missing | Secret not set | Add `DIGITALOCEAN_ACCESS_TOKEN` in GitHub |
| Jobs stuck in running | Worker crash | Sweeper requeues after lease expiry (~30s cycle) |
| Handler always DLQ | `max_retry` too low | Increase max_retry or fix handler |

---

## Migration (manual)

```bash
kubectl delete job migrate -n jobqueue 2>/dev/null || true
kubectl apply -f deploy/migrate-job.yaml
kubectl wait --for=condition=complete job/migrate -n jobqueue --timeout=120s
kubectl logs -n jobqueue job/migrate
```

---

## Tear down (save cost after demo)

```bash
doctl kubernetes cluster delete jobqueue --force
doctl databases delete jobqueue-pg --force
doctl registry delete jobqueue --force
```

Remove local `.infra/` if present. Delete GitHub secret if decommissioning CI deploy.

---

## Security notes

- `.infra/database-url` is gitignored — contains DB credentials
- MVP has **no API auth** — restrict Ingress / add auth before production use
- Rotate DO token if exposed in logs (provision output may contain connection strings)
