#!/usr/bin/env bash
set -euo pipefail

REGION="${DO_REGION:-nyc1}"
CLUSTER="${DO_CLUSTER:-jobqueue}"
REGISTRY="${DO_REGISTRY:-jobqueue}"
DB_NAME="${DO_DB_NAME:-jobqueue-pg}"

echo "==> Creating container registry: $REGISTRY"
doctl registry create "$REGISTRY" 2>/dev/null || echo "Registry may already exist"

echo "==> Creating Managed PostgreSQL: $DB_NAME (several minutes)"
if ! doctl databases list --format Name --no-header | grep -qx "$DB_NAME"; then
  doctl databases create "$DB_NAME" \
    --engine pg \
    --region "$REGION" \
    --size db-s-1vcpu-1gb \
    --num-nodes 1 \
    --wait
else
  echo "Database $DB_NAME already exists"
fi

echo "==> Creating DOKS cluster: $CLUSTER (several minutes)"
if ! doctl kubernetes cluster list --format Name --no-header | grep -qx "$CLUSTER"; then
  doctl kubernetes cluster create "$CLUSTER" \
    --region "$REGION" \
    --node-pool "name=pool;size=s-2vcpu-2gb;count=2" \
    --wait
else
  echo "Cluster $CLUSTER already exists"
fi

doctl kubernetes cluster kubeconfig save "$CLUSTER"

DB_ID=$(doctl databases list --format ID,Name --no-header | awk -v n="$DB_NAME" '$2==n{print $1; exit}')
CLUSTER_ID=$(doctl kubernetes cluster list --format ID,Name --no-header | awk -v n="$CLUSTER" '$2==n{print $1; exit}')

echo "==> Allowing DOKS cluster to access database"
doctl databases firewalls append "$DB_ID" --rule "k8s:$CLUSTER_ID" 2>/dev/null || true

mkdir -p /workspaces/my-project/.infra
doctl databases connection "$DB_ID" --format URI --no-header > /workspaces/my-project/.infra/database-url
echo "==> DATABASE_URL saved to .infra/database-url"
echo "==> Provision complete"
