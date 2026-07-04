#!/usr/bin/env bash
set -euo pipefail

INGRESS_URL="${INGRESS_URL:-}"
if [[ -z "$INGRESS_URL" ]]; then
  IP=$(kubectl get svc api -n jobqueue -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  HOST=$(kubectl get svc api -n jobqueue -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)
  if [[ -n "$IP" ]]; then INGRESS_URL="http://${IP}"
  elif [[ -n "$HOST" ]]; then INGRESS_URL="http://${HOST}"
  else echo "Set INGRESS_URL or wait for LoadBalancer"; exit 1; fi
fi

echo "Testing $INGRESS_URL"
curl -sf "$INGRESS_URL/health" | grep -q ok
curl -sf "$INGRESS_URL/ready" | grep -q ok

JOB=$(curl -sf -X POST "$INGRESS_URL/v1/jobs" -H 'content-type: application/json' \
  -d '{"queue":"default","handler":"echo","payload":{"test":true},"priority":"high","max_retry":3,"timeout_sec":60}')
JOB_ID=$(echo "$JOB" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).jobId))")
echo "Submitted job $JOB_ID"

for i in $(seq 1 60); do
  STATUS=$(curl -sf "$INGRESS_URL/v1/jobs/$JOB_ID" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).status))")
  echo "status=$STATUS"
  [[ "$STATUS" == "completed" ]] && break
  sleep 2
done

[[ "$STATUS" == "completed" ]] || { echo "Job did not complete"; exit 1; }
echo "E2E passed"
