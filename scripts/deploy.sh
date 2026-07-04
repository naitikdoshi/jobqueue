#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY="${DO_REGISTRY:-jobqueue}"
REGISTRY_HOST="registry.digitalocean.com/${REGISTRY}"
NS="${K8S_NAMESPACE:-jobqueue}"
TARGET="${1:-all}"

cd "$ROOT"

echo "==> DOCR login"
doctl registry login >/dev/null

build_push() {
  local target=$1
  local tag="${REGISTRY_HOST}/${target}:latest"
  echo "==> Building $tag"
  if docker info >/dev/null 2>&1; then
    docker build --target "$target" -t "$tag" .
    docker push "$tag"
  elif command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
    podman build --target "$target" -t "$tag" .
    podman push "$tag"
  else
    echo "No local container engine; using Kaniko on DOKS"
    setup_kaniko_auth
    kubectl create configmap jobqueue-dockerfile -n "$NS" \
      --from-file=Dockerfile="$ROOT/Dockerfile" \
      --dry-run=client -o yaml | kubectl apply -f -
    tar -cf /tmp/jobqueue-src.tar -C "$ROOT" package.json tsconfig.json migrations scripts handlers src
    kubectl delete configmap jobqueue-src -n "$NS" 2>/dev/null || true
    kubectl create configmap jobqueue-src -n "$NS" --from-file=/tmp/jobqueue-src.tar
    for t in api worker; do
      [[ "$TARGET" != "all" && "$TARGET" != "$t" ]] && continue
      kubectl delete job "kaniko-${t}" -n "$NS" 2>/dev/null || true
      sed "s|TARGET|${t}|g;s|REGISTRY_HOST|${REGISTRY_HOST}|g" "$ROOT/deploy/kaniko-job.yaml" | kubectl apply -f -
      kubectl wait --for=condition=complete "job/kaniko-${t}" -n "$NS" --timeout=600s
    done
    return
  fi
}

apply_secret() {
  local db_url
  if [[ -f "$ROOT/.infra/database-url" && -s "$ROOT/.infra/database-url" ]]; then
    db_url=$(cat "$ROOT/.infra/database-url")
  else
    local db_id
    db_id=$(doctl databases list --format ID,Name --no-header | awk -v n="${DO_DB_NAME:-jobqueue-pg}" '$2==n{print $1; exit}')
    db_url=$(doctl databases connection "$db_id" --format URI --no-header)
  fi
  db_url=$(echo "$db_url" | sed 's/[?&]sslmode=[^&]*//g' | sed 's/?$//')
  kubectl create namespace "$NS" 2>/dev/null || true
  kubectl create secret generic jobqueue-secrets -n "$NS" \
    --from-literal=DATABASE_URL="$db_url" \
    --dry-run=client -o yaml | kubectl apply -f -
}

setup_kaniko_auth() {
  doctl registry login >/dev/null
  kubectl create secret generic kaniko-docr -n "$NS" \
    --from-file=config.json="${HOME}/.docker/config.json" \
    --dry-run=client -o yaml | kubectl apply -f -
}

doctl registry kubernetes-manifest "$REGISTRY" --namespace="$NS" | kubectl apply -f -

apply_secret

if [[ "$TARGET" == "all" || "$TARGET" == "api" ]]; then
  build_push api
  kubectl apply -f "$ROOT/deploy/api.yaml"
  kubectl rollout status deployment/api -n "$NS" --timeout=300s
  kubectl delete job migrate -n "$NS" 2>/dev/null || true
  kubectl apply -f "$ROOT/deploy/migrate-job.yaml"
  kubectl wait --for=condition=complete job/migrate -n "$NS" --timeout=300s || true
fi

if [[ "$TARGET" == "all" || "$TARGET" == "worker" ]]; then
  build_push worker
  kubectl apply -f "$ROOT/deploy/worker.yaml"
  kubectl rollout status deployment/worker -n "$NS" --timeout=300s
fi

if [[ "$TARGET" == "all" ]]; then
  kubectl apply -f "$ROOT/deploy/api-hpa.yaml" -f "$ROOT/deploy/worker-hpa.yaml"
fi

echo "==> Ingress:"
kubectl get svc api -n "$NS"
