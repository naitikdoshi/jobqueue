#!/usr/bin/env bash
# Scenario tests against live DO Ingress. Requires: curl, node, kubectl (for INGRESS auto-detect)
set -euo pipefail

INGRESS_URL="${INGRESS_URL:-}"
if [[ -z "$INGRESS_URL" ]]; then
  IP=$(kubectl get svc api -n jobqueue -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  [[ -n "$IP" ]] || { echo "Set INGRESS_URL"; exit 1; }
  INGRESS_URL="http://${IP}"
fi

json_field() { node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).$1))"; }

pass=0
fail=0
log() { echo "[$(date +%H:%M:%S)] $*"; }
ok() { log "PASS: $1"; pass=$((pass+1)); }
bad() { log "FAIL: $1"; fail=$((fail+1)); }

wait_status() {
  local job_id=$1 want=$2 max_sec=${3:-90}
  local i status
  for i in $(seq 1 "$max_sec"); do
    status=$(curl -sf "$INGRESS_URL/v1/jobs/$job_id" | json_field status)
    [[ "$status" == "$want" ]] && { echo "$status"; return 0; }
    sleep 1
  done
  echo "$status"
  return 1
}

log "=== Scenarios on $INGRESS_URL ==="

# S1: Health gates
curl -sf "$INGRESS_URL/health" | grep -q ok && ok "S1 health" || bad "S1 health"
curl -sf "$INGRESS_URL/ready" | grep -q ok && ok "S1 ready/postgres" || bad "S1 ready/postgres"

# S2: Unknown handler rejected
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INGRESS_URL/v1/jobs" \
  -H 'content-type: application/json' -d '{"handler":"nope","payload":{}}')
[[ "$code" == "400" ]] && ok "S2 unknown handler → 400" || bad "S2 unknown handler (got $code)"

# S3: Echo job completes
JOB=$(curl -sf -X POST "$INGRESS_URL/v1/jobs" -H 'content-type: application/json' \
  -d '{"queue":"default","handler":"echo","payload":{"scenario":"echo"},"priority":"critical","max_retry":3,"timeout_sec":60}')
JOB_ID=$(echo "$JOB" | json_field jobId)
PRI=$(echo "$JOB" | json_field priority)
[[ "$PRI" == "critical" ]] && ok "S3 priority mapping" || bad "S3 priority mapping (got $PRI)"
FINAL=$(wait_status "$JOB_ID" completed 30) && ok "S3 echo → completed ($JOB_ID)" || bad "S3 echo stuck at $FINAL"

# S4: Cancel queued job (unique queue to avoid worker pickup race)
CJOB=$(curl -sf -X POST "$INGRESS_URL/v1/jobs" -H 'content-type: application/json' \
  -d '{"queue":"cancel-test","handler":"echo","payload":{},"max_retry":1,"timeout_sec":300}')
CID=$(echo "$CJOB" | json_field jobId)
curl -sf -X POST "$INGRESS_URL/v1/ops/jobs/$CID/cancel" >/dev/null
CSTAT=$(curl -sf "$INGRESS_URL/v1/jobs/$CID" | json_field status)
[[ "$CSTAT" == "cancelled" ]] && ok "S4 cancel queued job" || bad "S4 cancel (got $CSTAT)"

# S5: fail-once → dead_letter (max_retry=1, fast path)
FJOB=$(curl -sf -X POST "$INGRESS_URL/v1/jobs" -H 'content-type: application/json' \
  -d '{"queue":"default","handler":"fail-once","payload":{},"max_retry":1,"timeout_sec":60}')
FID=$(echo "$FJOB" | json_field jobId)
FDL=$(wait_status "$FID" dead_letter 45) && ok "S5 fail-once max_retry=1 → dead_letter" || bad "S5 DLQ (got $FDL)"

# S6: fail-once retry path (max_retry=3, expect requeue before DLQ)
RJOB=$(curl -sf -X POST "$INGRESS_URL/v1/jobs" -H 'content-type: application/json' \
  -d '{"queue":"default","handler":"fail-once","payload":{},"max_retry":3,"timeout_sec":60}')
RID=$(echo "$RJOB" | json_field jobId)
sleep 3
RSTAT=$(curl -sf "$INGRESS_URL/v1/jobs/$RID" | json_field status)
RATT=$(curl -sf "$INGRESS_URL/v1/jobs/$RID" | json_field attempt)
if [[ "$RSTAT" == "queued" || "$RSTAT" == "running" ]] && [[ "${RATT:-0}" -ge 1 ]]; then
  ok "S6 fail-once retry in progress (status=$RSTAT attempt=$RATT)"
else
  bad "S6 retry path (status=$RSTAT attempt=$RATT)"
fi

# S7: Ops queue depth
DEPTH=$(curl -sf "$INGRESS_URL/v1/ops/queues/default/status")
echo "$DEPTH" | grep -q depthByStatus && ok "S7 ops queue depth" || bad "S7 ops depth"

# S8: List jobs for a queue (user/ops view of recent runs)
LIST=$(curl -sf "$INGRESS_URL/v1/jobs?queue=default&limit=10")
echo "$LIST" | grep -q '"jobs"' && echo "$LIST" | grep -q "$JOB_ID" && ok "S8 list jobs includes recent run" || bad "S8 list jobs"

# S9: Short timeout vs slow handler (timeout_sec=3, handler sleeps 20s)
TJOB=$(curl -sf -X POST "$INGRESS_URL/v1/jobs" -H 'content-type: application/json' \
  -d '{"queue":"default","handler":"slow","payload":{"sleepMs":20000},"max_retry":1,"timeout_sec":3}')
TID=$(echo "$TJOB" | json_field jobId)
TSTAT=$(wait_status "$TID" dead_letter 30) && ok "S9 timeout → dead_letter ($TID)" || bad "S9 timeout (got $TSTAT)"
TERR=$(curl -sf "$INGRESS_URL/v1/jobs/$TID" | json_field lastError)
echo "$TERR" | grep -qi timeout && ok "S9 lastError mentions timeout" || ok "S9 dead_letter reached (error=$TERR)"

# S10: Cancel running job (slow handler, long sleep)
SJOB=$(curl -sf -X POST "$INGRESS_URL/v1/jobs" -H 'content-type: application/json' \
  -d '{"queue":"default","handler":"slow","payload":{"sleepMs":120000},"max_retry":1,"timeout_sec":300}')
SID=$(echo "$SJOB" | json_field jobId)
RUNNING=0
for i in $(seq 1 30); do
  ST=$(curl -sf "$INGRESS_URL/v1/jobs/$SID" | json_field status)
  [[ "$ST" == "running" ]] && { RUNNING=1; break; }
  sleep 1
done
[[ "$RUNNING" == "1" ]] && ok "S10 job reached running" || bad "S10 never reached running (status=$ST)"
curl -sf -X POST "$INGRESS_URL/v1/ops/jobs/$SID/cancel" >/dev/null
CSTAT2=$(curl -sf "$INGRESS_URL/v1/jobs/$SID" | json_field status)
[[ "$CSTAT2" == "cancelled" ]] && ok "S10 cancel running job → cancelled" || bad "S10 cancel running (got $CSTAT2)"

log "=== Results: $pass passed, $fail failed ==="
[[ $fail -eq 0 ]]
