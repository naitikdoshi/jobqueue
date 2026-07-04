#!/usr/bin/env bash
set -euo pipefail

CLUSTER="${DO_CLUSTER:-jobqueue}"
REGISTRY="${DO_REGISTRY:-jobqueue}"
DB_NAME="${DO_DB_NAME:-jobqueue-pg}"
NS="${K8S_NAMESPACE:-jobqueue}"

echo "Checking DigitalOcean account..."
doctl account get >/dev/null

echo "Checking DOCR..."
doctl registry get "$REGISTRY" >/dev/null

echo "Checking Managed PostgreSQL..."
if ! doctl databases list --format Name,Status --no-header | awk -v n="$DB_NAME" '$1==n && $2=="online"{found=1} END{exit !found}'; then
  echo "Database $DB_NAME not found or not online"
  exit 1
fi

echo "Checking DOKS cluster..."
doctl kubernetes cluster get "$CLUSTER" >/dev/null

echo "Checking nodes..."
kubectl get nodes
NOT_READY=$(kubectl get nodes --no-headers | grep -vc " Ready" || true)
if [[ "$NOT_READY" -gt 0 ]]; then
  echo "Some nodes not Ready yet"
  exit 1
fi

echo "Ensuring namespace $NS..."
kubectl create namespace "$NS" 2>/dev/null || true

echo "All infra checks passed."
