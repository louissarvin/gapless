# Running the backend with Docker Compose (Monad mainnet canary)

Single host, `docker-compose.yml` in this directory. Env values and their sources: `DEPLOYMENT_143.md`. Process behavior: `CLAUDE.md`.

## Layout

| Service | Network | Volume (`/app/data`) | Published | Health |
|:-|:-|:-|:-|:-|
| jobs | `gapless-jobs` (egress only) | `gapless-data` | none | `summary.json` under 15 min old |
| relay | `gapless`, alias `relay.internal` | `gapless-data` (shared, owns `relay.sqlite`) | `127.0.0.1:3700`, `127.0.0.1:3701` | `GET /healthz` |
| keeper | `gapless`, alias `keeper.internal` | `gapless-keeper-data` | none | `GET /healthz` with bearer token |

Keeper and relay reach each other at `ws://relay.internal:3701/ws/market` and `http://keeper.internal:3702`. The `.internal` suffix is what lets the env schema accept plain ws/http. The `gapless` network is pinned to `172.28.143.0/24`, so `TRUST_PROXY=172.28.143.1` (the gateway) is fixed. Change both together.

## Host prerequisites

- Linux, Docker Engine 28 or newer (older engines let hosts on the same L2 segment reach ports published on 127.0.0.1), Compose v2.
- A reverse proxy on the host that terminates TLS, forwards to `127.0.0.1:3700`, routes `/ws/market` (WebSocket upgrade) to `127.0.0.1:3701`, and sets `X-Forwarded-For`. Use `127.0.0.1`, not `localhost` (which may resolve to `::1`, and nothing listens there).
- `172.28.143.0/24` free on the host. If `docker compose up` reports a pool overlap, pick another /24 and update `TRUST_PROXY` to match.

## 1. Build the image

```sh
cd backend
docker build -t gapless-backend:canary .
```

Compose never pulls or builds (`pull_policy: never`). A missing image is an error, never a registry pull.

## 2. Create `.env.docker`

One-time, because a hook protects `.env*` paths from automated edits: `cp env.docker.example.proposed .env.docker.example` (gitignore already allows `.env.docker.example`), then remove the `.proposed` copy.

```sh
cp .env.docker.example .env.docker
chmod 600 .env.docker
"$EDITOR" .env.docker
export COMPOSE_ENV_FILES=.env.docker   # every compose command needs it; add it to the deploy user's shell profile
docker compose config --quiet          # no output means every required value is set
```

- Fill the values from the secret store in an editor. Never with `echo` or as command arguments, which end up in shell history.
- Leave `RELAY_KEY` blank while `SPONSOR_ENABLED=false`.
- `docker compose config` without `--quiet` prints the resolved secrets. Never paste or share its output. To review the file, use `docker compose config --no-interpolate`.
- Container env is visible to anyone who can run `docker inspect`, so treat docker group membership as root.
- `.env.docker` is gitignored and excluded from the build context by `.dockerignore`. Keep no `backend/.env` on the host.

## 3. Start in order: jobs, relay, keeper

`depends_on` encodes the order, but start one service at a time so each can be checked before the next.

```sh
docker compose up -d jobs
docker compose logs --tail=50 jobs      # expect jobs.start; env.invalid lists bad variable names (never values)

docker compose up -d relay
curl -fsS http://127.0.0.1:3700/healthz # 200 once the Perpl feed is subscribed

docker compose up -d keeper
docker compose logs --tail=50 keeper    # expect keeper.started
```

Jobs goes first because it applies jobs migration 3; the relay never migrates. The keeper goes last because its feed and `/sigma-refresh` use the relay. It exits 1 with `keeper.not_configured` if a runtime var is missing, and with `env.invalid` on a malformed one.

Check that `keeper.started` reports `keeper: 0xC0C1EEe02794005eC4ba9ac20A818da42c97a219` (`roles.keeper`). Any other address means `KEEPER_KEY` is wrong: `docker compose stop keeper` immediately.

A service that fails at boot restarts in a loop (`restart: unless-stopped`). `docker compose stop <service>` halts it while you fix the cause.

Then run the canary checks in `CLAUDE.md` (funding, landing gap, M-2) before any cover is sold.

## 4. Health

```sh
docker compose ps                       # STATUS: starting, healthy or unhealthy
docker inspect --format '{{json .State.Health}}' gapless-keeper-1   # last probe results
```

Plain Compose does not restart an unhealthy container. Point your alerting at these checks.

Relay, public body from the host:

```sh
curl -fsS http://127.0.0.1:3700/healthz
```

Relay detailed body and keeper. Both read the token from the container env, so it never appears on a command line:

```sh
docker compose exec relay bun -e "fetch('http://127.0.0.1:3700/healthz',{headers:{authorization:'Bearer '+process.env.RELAY_INTERNAL_TOKEN}}).then(async r=>console.log(r.status,await r.text()))"
docker compose exec keeper bun -e "fetch('http://127.0.0.1:3702/healthz',{headers:{authorization:'Bearer '+process.env.RELAY_INTERNAL_TOKEN}}).then(async r=>console.log(r.status,await r.text()))"
```

The keeper answers 503 when heads are unsubscribed or older than 10 s, lag exceeds 10 blocks, or the balance is under `KEEPER_LOW_BALANCE_WEI` (2 MON: refill).

Jobs has no HTTP server. Check the age of its last output:

```sh
docker compose exec jobs bun -e "console.log(Math.round((Date.now()-require('fs').statSync(process.env.OUT_DIR+'/summary.json').mtimeMs)/1000)+' s')"
```

The first run backfills 7 days before writing anything, so jobs stays `starting` (up to 30 min) until then.

## 5. Logs

Pino JSON on stdout. Each container keeps 5 x 10 MB rotated files.

```sh
docker compose logs -f --tail=200 keeper
docker compose logs --since 1h relay
docker compose logs --no-log-prefix keeper | jq -c 'select(.level=="warn" or .level=="error" or .level=="fatal")'
docker compose logs --no-log-prefix keeper | jq -c 'select(.msg|test("^keeper\\.(chain_gap|low_balance|touch_budget)"))'
```

## 6. Verify `TRUST_PROXY` once

The relay must see the host proxy as `172.28.143.1`. Otherwise every client shares one rate-limit bucket (5 public `/ws/market` sockets for the whole internet), or `X-Forwarded-For` is trusted from the wrong hop. After the first `up` creates the network, run:

```sh
docker run --rm -d --name ip-probe --network gapless -p 127.0.0.1:3799:3799 gapless-backend:canary \
  -e "Bun.serve({hostname:'0.0.0.0',port:3799,fetch:(r,s)=>new Response(s.requestIP(r).address+'\n')})"
curl -s http://127.0.0.1:3799/   # expect 172.28.143.1
docker rm -f ip-probe
```

If it prints something else, for example with the daemon's `userland-proxy` disabled, set `TRUST_PROXY` in `docker-compose.yml` to that address.

## 7. Stop, upgrade, roll back

- Stop the keeper before anything else signs with its key, the CRE broadcast included (L-4): `docker compose stop keeper`. On restart it waits up to 35 s for the signer lease.
- Upgrade: `docker tag gapless-backend:canary gapless-backend:prev`, rebuild `canary`, then `docker compose up -d jobs`, `relay`, `keeper` in that order (jobs first: it applies any new jobs migration).
- Roll back: `GAPLESS_IMAGE_TAG=prev docker compose up -d jobs relay keeper`. Before rolling back across a schema migration, check `src/*/migrations.ts`. Migrations only move forward.
- Never run `docker compose down -v` or `docker volume rm` on `gapless-data` or `gapless-keeper-data`. They hold the keeper spend ledger and walk starts (the daily caps), the relay sponsor ledger, and the jobs store. Volume names are fixed, so a different project name reuses them instead of starting empty.
