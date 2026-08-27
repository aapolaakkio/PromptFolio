# syntax=docker/dockerfile:1

# --- build stage -------------------------------------------------------
# Installs the full lockfile (including devDependencies -- bun-plugin-tailwind
# is a devDependency but is required at *runtime*, not just build time; see
# the runtime stage's comment on bunfig.toml) and runs the project's own
# build script, `bun run build.ts` (== `bun run build`), as a build-time
# sanity gate. The CLI form (`bun build --plugin bun-plugin-tailwind ...`)
# is deliberately NOT used here: it bundles the Tailwind plugin's own
# server-side code into the browser output. `build.ts` calls `Bun.build()`
# programmatically instead, which does not have that problem -- see that
# file.
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# --- runtime stage -------------------------------------------------------
FROM oven/bun:1.4-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# What actually gets served: `src/server/index.ts` imports
# `../web/index.html` directly and hands it to `Bun.serve`'s `routes`,
# which bundles that HTML entrypoint (and everything it references --
# main.tsx, styles.css) itself at server startup. This is Bun's own
# full-stack HTML-import feature, not a static file server -- it reads
# from `src/`, not from a prebuilt `dist/` directory, so `dist/` (built
# above purely to catch a build failure before it reaches this stage) is
# never copied into this image; nothing here would ever read it.
#
# `bunfig.toml` is copied for the same reason `src/` is: its
# `[serve.static] plugins = ["bun-plugin-tailwind"]` line is what tells
# Bun's runtime HTML bundler to run Tailwind on `styles.css` at all.
# Without it present in this image, the CSS Bun serves would still contain
# raw `@import "tailwindcss"` and unprocessed utility classes -- verified
# by removing it and re-building; see task-22-report.md.
#
# `node_modules` is copied whole (not pruned to production-only) precisely
# because `bun-plugin-tailwind` lives in devDependencies but is loaded at
# runtime by the line above.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/bunfig.toml ./bunfig.toml
COPY --from=build /app/package.json ./package.json

RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun
VOLUME ["/data"]
ENV DATABASE_PATH=/data/promptfolio.db
EXPOSE 3000

# Deliberately hits /api/health, not any route that touches the database:
# see src/server/index.ts's healthRoute comment. A health check that runs
# a SQLite query turns a slow query (a big import, a WAL checkpoint) into
# a container restart loop.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD bun -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No separate migration step or entrypoint script: src/server/index.ts
# itself runs `migrate(db)` before starting the server, inside its
# `import.meta.main` guard (Task 22). A fresh volume becomes a working
# database on first boot; re-running against an already-current database
# on every later boot is a safe, cheap no-op.
CMD ["bun", "src/server/index.ts"]
