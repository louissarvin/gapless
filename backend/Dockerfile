# One image, three processes. Pick the entrypoint with the container command:
#   docker run gapless-backend                      -> relay (default)
#   docker run gapless-backend src/keeper/index.ts  -> keeper (internal /healthz on KEEPER_PORT 3702;
#     set KEEPER_HOST to the private interface, never publish it)
#   docker run gapless-backend src/jobs/index.ts    -> jobs
#
# Relay and jobs share one read-write volume at /app/data:
#   jobs writes jobs.sqlite and gap-index/*.json; the relay reads them (jobs.sqlite read-only)
#   and owns relay.sqlite. Do not mount it :ro for the relay: a read-only WAL open needs the
#   -shm and -wal files to exist or be creatable. Both containers run as the same `bun` user.
#   docker volume create gapless-data
#   docker run -d -v gapless-data:/app/data -e ENVIO_API_TOKEN gapless-backend src/jobs/index.ts
#   docker run -d -v gapless-data:/app/data -p 127.0.0.1:3700:3700 -p 127.0.0.1:3701:3701 \
#     -e APP_ORIGIN -e RELAY_INTERNAL_TOKEN gapless-backend
# Publish on loopback only (or not at all, on a private network): a bare -p binds every host
# interface and serves plain http/ws. TLS terminates at the reverse proxy; set TRUST_PROXY to that
# proxy's exact address, never a whole Docker range.
#
# Runtime hardening (docker-compose.example.yml has all of it): read-only root filesystem with
# /app/data as the only writable mount and a tmpfs /tmp, all capabilities dropped,
# no-new-privileges, pid, memory and CPU limits, a /healthz healthcheck, and a 35 s stop grace for jobs.
# Pinned by digest so a retagged upstream image cannot change the build.
ARG BUN_IMAGE=oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM ${BUN_IMAGE} AS release
# OUT_DIR (jobs) and GAP_INDEX_DIR (relay) must name the same directory.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3700 \
    WS_PORT=3701 \
    DB_PATH=/app/data/relay.sqlite \
    KEEPER_DB_PATH=/app/data/keeper.sqlite \
    OUT_DIR=/app/data/gap-index \
    GAP_INDEX_DIR=/app/data/gap-index \
    JOBS_DB_PATH=/app/data/jobs.sqlite
WORKDIR /app
# Code stays root-owned and read-only for the runtime user; only /app/data is writable.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
RUN mkdir -p /app/data && chown bun:bun /app/data && chmod 0750 /app/data
USER bun
VOLUME ["/app/data"]
# 3700: Fastify HTTP API. 3701: Bun.serve /ws/market (route it at the reverse proxy).
EXPOSE 3700 3701
ENTRYPOINT ["bun"]
CMD ["src/relay/index.ts"]
