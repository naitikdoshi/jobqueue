# Prerequisites

Run `./scripts/check-prereqs.sh` before Phase 0.

## Required tools

| Tool | Purpose |
|------|---------|
| `doctl` | Provision DOCR, Managed PG, DOKS |
| `kubectl` | Deploy to DOKS |
| `docker` | Build and push images to DOCR |
| `git` | Version control |
| `node` / `npm` | TypeScript API and worker |

## Authentication

```bash
export DIGITALOCEAN_ACCESS_TOKEN=your_token
doctl auth init -t "$DIGITALOCEAN_ACCESS_TOKEN"
doctl account get    # must succeed
doctl registry login # after DOCR created
```

## Environment status (last checked)

| Item | Status |
|------|--------|
| `doctl` | Installed |
| `kubectl` | Installed (v1.36) |
| `docker` CLI | Installed (daemon may need start — see below) |
| `node` | v24 |
| DO token | **Pending** — user providing |
| `gh auth` | Not logged in (optional for remote push) |

## Docker daemon

If `docker ps` fails with socket error:

```bash
sudo service docker start
# or use rootless / remote Docker host
```

Image build requires a running Docker daemon or alternative (e.g. DO App Platform build, GitHub Actions).

## GitHub (optional)

```bash
gh auth login
gh repo create jobqueue --source=. --public
```

## Cost note

MVP infra (~1 hour): DOKS 2 nodes + db-s-1vcpu-1gb PG + DOCR — remember to tear down after demo:

```bash
./scripts/teardown.sh   # to be added in implementation phase
```
