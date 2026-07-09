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
RUN mkdir -p db uploads && chown -R node:node /app
VOLUME ["/app/db", "/app/uploads"]

USER node
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
