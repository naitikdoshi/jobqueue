#!/usr/bin/env bash
set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'; fail=0
check() { if command -v "$2" >/dev/null 2>&1; then echo -e "${GREEN}✓${NC} $1"; else echo -e "${RED}✗${NC} $1"; fail=1; fi; }
check "doctl" doctl; check "kubectl" kubectl; check "docker" docker; check "git" git; check "node" node; check "npm" npm
if doctl account get >/dev/null 2>&1; then echo -e "${GREEN}✓${NC} DigitalOcean API auth"; else echo -e "${RED}✗${NC} DigitalOcean API auth"; fail=1; fi
if docker info >/dev/null 2>&1; then echo -e "${GREEN}✓${NC} Docker daemon"; elif command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then echo -e "${GREEN}✓${NC} Podman"; else echo -e "${YELLOW}!${NC} No local builder — Kaniko on DOKS will be used"; fi
[[ $fail -eq 0 ]] || exit 1; echo "All prerequisites OK."
