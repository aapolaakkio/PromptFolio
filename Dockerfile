# syntax=docker/dockerfile:1

# --- build stage -------------------------------------------------------
FROM node:26-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm run build

# --- runtime stage -------------------------------------------------------
FROM node:26-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Nitro's build output carries its own dependencies, so no node_modules comes
# with it. `drizzle/` does: the migrations are SQL files read at boot, not code
# the bundler can inline.
COPY --from=build /app/.output ./.output
COPY --from=build /app/drizzle ./drizzle

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
ENV DATABASE_PATH=/data/promptfolio.db
EXPOSE 3000

# Deliberately /api/health, which touches no database: a check that runs a query
# turns a slow one -- a big import, a WAL checkpoint -- into a restart loop.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No separate migration step: the server entry runs them before answering
# anything (src/web/instrumentation.ts), so a fresh volume becomes a working
# database on first boot.
#
# The nightly price refresh is not in here. It is POST /api/cron/refresh,
# authorised by CRON_SECRET, for a cron outside the container to call.
CMD ["node", ".output/server/index.mjs"]
