# Hosting the demo against a live catalog

The demo page validates a runbook against a catalog. With no DataHub configured
it uses a committed fixture and says so. With one configured it reads the real
datasets during each request and prints which catalog, at what version, when it
read, and the fingerprints that came back.

This directory is what it takes to run the second kind.

## Why it is not on Vercel

The app reaches DataHub through `mcp-server-datahub`, which it spawns as a
subprocess over stdio. Serverless runtimes will not do that. So the app is
deployed *next to* DataHub on one box rather than in front of it — which is also
the safer shape: `datahub-gms` is never published, and the only port on the
internet belongs to the app.

The app writes nothing to the catalog on this path. A visitor's breaking changes
are applied to the snapshot their request just read and thrown away. Write-back
against a real catalog is `npm run prove`, which CI re-derives on every push.

## What free costs

DataHub's quickstart wants about 8 GB of RAM. Being straight about the options:

| Option | Free? | Fit |
| --- | --- | --- |
| **Oracle Cloud Always Free** (Ampere A1, up to 4 OCPU / 24 GB) | free indefinitely; card required for identity, not billed | the only mainstream free tier big enough to run this 24/7 |
| GitHub Codespaces | 120 core-hours/month | works, but sleeps when idle — no good as a link a judge clicks at 2am |
| AWS / GCP / Azure always-free instances | free | 1 GB of RAM. Not close |
| Fly / Render / Railway free tiers | free | nowhere near 8 GB |

So: Oracle Always Free if the link has to stay up. A1 capacity is genuinely
hard to get in some regions — retry, or pick another region.

`datahub-lowmem.yml` caps the JVM heaps to bring the stack to roughly 4.5–5 GB
if the box is smaller. **It has not been tested** — this project has only ever
run DataHub on a 16 GB laptop and a 16 GB CI runner. Watch `docker stats` on the
first boot.

## The sequence

On a fresh Ubuntu box with Docker installed:

```bash
# 1. DataHub, and the catalog the demo's runbook is written against.
sudo sysctl -w vm.max_map_count=262144          # OpenSearch will not start without this
pipx install acryl-datahub                       # or: uv tool install acryl-datahub
datahub docker quickstart                        # add the lowmem override here if needed

git clone https://github.com/mcrowley19/Instaboard.git
cd Instaboard
DATAHUB_GMS_URL=http://localhost:8080 npm run seed

# 2. Confirm the catalog holds what the demo reads, before exposing anything.
curl -s localhost:8080/api/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ dataset(urn:\"urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)\"){ name } }"}'

# 3. Point Caddy at your hostname, then bring up the app.
$EDITOR deploy/Caddyfile
docker compose -f deploy/docker-compose.yml up -d --build

# 4. It should say fixture:false and carry a live receipt.
curl -s localhost:3000/api/demo/drift -X POST \
  -H 'Content-Type: application/json' -d '{"mutations":[]}' | head -c 400
```

If step 4 comes back `"fixture": true`, the app could not reach GMS. Check that
`docker network inspect datahub_network` lists the app container, and that
`DEMO_MODE` is not set to `true` anywhere.

## Before you leave it running

- **Firewall.** Only 80 and 443 open. GMS on 8080 and the DataHub frontend on
  9002 must not be reachable from outside the box — the compose file does not
  publish them, but a cloud provider's default security group might.
- **The catalog is the demo's, not yours.** Seed it with the sample catalog.
  Do not point this at a catalog holding anything real: the demo reads owner
  names and descriptions and prints them to whoever loads the page.
- **`DEMO_LIVE_TTL_MS`.** One catalog read is shared between visitors for this
  many milliseconds, so a burst of traffic costs one read rather than one per
  visitor. Raise it on a small box.

## Files

| File | What it is |
| --- | --- |
| `Dockerfile` | the app, plus `uv` for the MCP server it spawns |
| `docker-compose.yml` | app + Caddy, joined to DataHub's existing network, GMS unpublished |
| `Caddyfile` | TLS and the reverse proxy; edit the hostname |
| `datahub-lowmem.yml` | JVM heap caps for a small box — untested, see above |
