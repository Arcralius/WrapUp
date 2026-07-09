# WrapUp

A self-hosted "year in review" dashboard for your gaming backlog. Import a
markdown list of games you've played, and WrapUp turns it into a dashboard
with yearly stats, a scrollable timeline, cover art and Metacritic links
pulled in automatically, and read-only links you can share with friends.

Multi-user, SQLite-backed, no external services required beyond outbound
HTTPS to fetch Metacritic cover art.

## Features

- **Markdown import** — paste your list in a simple `- Game (HLTB N Hours)` /
  `- Game DD/MM/YYYY (HLTB N Hours)` / `- Game (Live Service)` format and
  upload it. Re-upload any time to refresh.
- **Manual entries** — add games one at a time with a start date, a
  completion date, or mark them as still-playing/live-service; edit or
  delete anything afterward.
- **Automatic cover art + Metacritic links** — resolved in the background
  against Metacritic's own search data (no API key needed) and cached, with
  a manual override field for the rare bad match.
- **Dashboard** — total hours, games per year, an hours-by-game pie chart
  (whole library or a single year), and a month-grouped game grid.
- **Timeline** — a scrolling, month-by-month view of the year with a reveal
  animation, defaulting to the current year and month.
- **Share links** — generate a read-only link to your whole library or to a
  single year's wrap-up. Viewers don't need an account and can't edit
  anything; links are revocable and regenerable at any time.
- **Accounts** — email/username/password signup, salted+hashed passwords
  (scrypt), server-side sessions, and strict per-user data isolation.

## Quick start (Docker)

```bash
docker run -d \
  --name wrapup \
  -p 3000:3000 \
  -v wrapup-db:/app/db \
  -v wrapup-uploads:/app/uploads \
  arcralius/wrapup:latest
```

Then open `http://localhost:3000`. The two `-v` flags are what make your
data survive `docker rm` — they're named volumes, not paths inside the
container, so removing and recreating the container (even with a newer
image) keeps your accounts and games intact. Skip them and you get a
disposable, empty instance every time.

### docker-compose

```bash
docker compose up -d
```

See [`docker-compose.yml`](docker-compose.yml) — it defines the same two
volumes (`wrapup-db`, `wrapup-uploads`) so `docker compose down && docker
compose up -d` preserves data the same way.

### Building the image yourself

```bash
docker build -t wrapup .
```

## Quick start (local, no Docker)

Requires Node.js 22.5+ (uses the built-in `node:sqlite` module — no native
build step, no `bcrypt`/`better-sqlite3` compilation).

```bash
npm install
npm start
```

The database is created automatically on first run at `db/games.db` if it
doesn't already exist — there's no separate migration step to run.

## How data is stored

- `db/games.db` — a single SQLite file holding accounts, sessions, games,
  the Metacritic lookup cache, and share links. Created fresh automatically
  if missing.
- `uploads/<user-id>/` — each user's uploaded markdown source files
  (server-generated filenames only, never the client's original name).

Both directories are declared as Docker volumes in the `Dockerfile`, so a
container can be freely destroyed and recreated (including for image
upgrades) without losing anything.

## Security notes

- Passwords are hashed with `scrypt` (per-password random salt,
  constant-time verification) — never stored in plaintext.
- Sessions are opaque, server-generated tokens checked against the database
  on every request (not stateless JWTs), so logging out actually revokes
  access immediately.
- Session cookies are `HttpOnly` + `SameSite=Lax`, and `Secure` when served
  over HTTPS.
- Uploaded files are validated by content (extension, size, UTF-8/text
  sanity, line-count/length caps) before ever touching disk, and are always
  written under a random, server-generated filename — never the client's.
- Every API route scoped to a user filters by that user's id; share links
  use a separate, entirely read-only route tree that has no write endpoints
  at all, not a permission check that could have a bug in it.
- [`helmet`](https://github.com/helmetjs/helmet) sets a locked-down
  Content-Security-Policy (`script-src 'self'`, no inline scripts anywhere
  in the app) plus the usual `X-Content-Type-Options`/`X-Frame-Options`
  headers, and hides `X-Powered-By`.
- Rate limiting: a global cap on `/api/*` and a much tighter one on
  signup/login specifically (the two endpoints actually worth attacking —
  account enumeration, credential stuffing, or just burning CPU on scrypt).
- The Docker image is a multi-stage build that ships **without npm** —
  npm's own vendored dependencies (`tar`, `undici`, etc., used for registry
  access) periodically pick up CVEs of their own, and the running container
  never needs npm, only `node server.js`. Scanned with `docker scout cves`
  at 0 known vulnerabilities as of the last build. The final image is also
  built from an explicit file allowlist rather than `COPY . .`, so nothing
  outside the app itself (git metadata, editor/tool config, docs) can ever
  end up in it.
- Deploying behind a reverse proxy that terminates TLS (nginx, Traefik, a
  cloud load balancer)? Set `TRUST_PROXY=1` (or a specific hop count/subnet
  per [Express's `trust proxy` docs](https://expressjs.com/en/guide/behind-proxies.html))
  so the app correctly sees the connection as secure and marks session
  cookies `Secure`. It's opt-in and off by default, since trusting
  `X-Forwarded-*` headers you don't actually control lets a client spoof
  its own IP — which matters here since rate limiting keys on it.

## Troubleshooting

**`unable to open database file`** — the `db/` volume is mounted but the
container can't write to it. This happens on hosting platforms that don't
run the container as the image's built-in `node` user or don't preserve its
ownership on a fresh volume (Kubernetes PVCs mount empty, root-owned storage
regardless of what the image had baked in; several PaaS platforms run
containers as an arbitrary, randomly-assigned UID). `db/` and `uploads/` are
world-writable in the image specifically so this shouldn't happen — if
you're still hitting it, check whatever your platform calls "run as user" /
`fsGroup` / `securityContext` and make sure it isn't overriding that.

**`ValidationError ... X-Forwarded-For ...` / the app crashes behind a
reverse proxy** — express-rate-limit refuses to key rate limits off an
`X-Forwarded-For` header unless you've told Express to trust it. Set
`TRUST_PROXY=1` (see the Security notes below) if you're behind nginx,
Traefik, Cloudflare, or any platform's edge proxy — the app no longer
crashes without it, but rate limiting is more accurate with it set.

## Tech stack

Node.js + Express, `node:sqlite` (SQLite, no native deps), vanilla
HTML/CSS/JS on the frontend — no build step, no frontend framework.

## Project structure

```
server.js          Express app, all API routes
lib/                Auth, DB schema/migrations, Metacritic scraping,
                    markdown parsing, sharing, background enrichment
routes/             Auth and file-upload routes
scripts/import.js   Markdown → SQLite import
public/             Dashboard, Timeline, and shared read-only pages
db/                 SQLite database (gitignored, Docker volume)
uploads/            Per-user uploaded markdown files (gitignored, Docker volume)
```
