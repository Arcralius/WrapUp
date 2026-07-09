# Pure-JS dependencies only (express, cookie-parser, multer) and Node's
# built-in node:sqlite module — no native build toolchain needed.

# ---- deps: install with npm here, in a stage that never ships ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- final: only the runtime needs, nothing else ----
FROM node:24-alpine
WORKDIR /app

# npm carries its own vendored copies of packages (tar, undici, etc.) for
# registry access that periodically pick up CVEs of their own — irrelevant
# here since the running container only ever executes `node server.js`.
# Dropping npm/npx/corepack removes that surface entirely rather than
# waiting on upstream patches for code we never call.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY --from=deps /app/node_modules ./node_modules

# Explicit allowlist rather than `COPY . .` + .dockerignore — nothing not
# named here (local editor/tool config, git metadata, docs, logs) can end
# up in the image even by future accident.
COPY package.json server.js ./
COPY lib ./lib
COPY routes ./routes
COPY scripts ./scripts
COPY public ./public

# db/ holds the SQLite database; uploads/ holds each user's uploaded
# markdown source files. Both are the only state that isn't reproducible
# from the image itself, so both are declared as volumes — removing and
# recreating the container must not lose either.
#
# db/ and uploads/ are made world-writable (not just owned by `node`)
# because a *lot* of hosting platforms don't honor this image's USER/chown
# at all: Kubernetes PVCs mount fresh, root-owned, empty storage that
# ignores whatever the image had baked in; several PaaS platforms run
# containers as an arbitrary, randomly-assigned UID for their own security
# reasons. `chown -R node:node` alone only works when the platform actually
# runs the process as uid 1000 against a volume Docker itself provisioned
# (its plain `docker run -v` / compose behavior) — anywhere else it leaves
# an owner mismatch and node:sqlite fails with "unable to open database
# file". World-writable data dirs are the standard fix for "arbitrary
# runtime UID" environments; everything else in the image stays owned by
# node/root as normal.
RUN mkdir -p db uploads && chown -R node:node /app && chmod -R 777 db uploads
VOLUME ["/app/db", "/app/uploads"]

USER node
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
