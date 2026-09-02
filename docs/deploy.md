# Deploying

Four containers: Postgres, the API, the worker, and nginx serving the web app.
`deploy/docker-compose.yml` runs the published images — nothing is built on the host, so
that file plus a `.env` is the entire deployment. The repo is not needed on the server.

The root `docker-compose.yml` is the *development* one: it builds from source and exposes
Postgres to the host. Do not use it on a server.

## Publishing a release

Images are built by `.github/workflows/release-images.yml` and pushed to GHCR. The tag is
the release signal — nothing publishes on a branch push:

```sh
git tag -a v0.1.0 -m "..." && git push origin v0.1.0
```

That produces `ghcr.io/chiragthapa777/mini-harness/{api,worker,web}` tagged `0.1.0`,
`0.1`, `0`, and `latest`. A pre-release tag (`v0.2.0-rc.1`) publishes only the full
version and never moves `latest`. Images are `linux/amd64` only — on Graviton or Apple
Silicon, add `linux/arm64` to the workflow's `platforms`.

## On the server

```sh
mkdir mini-agent && cd mini-agent
curl -O https://raw.githubusercontent.com/chiragthapa777/mini-harness/main/deploy/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/chiragthapa777/mini-harness/main/deploy/.env.example

# fill in .env — at minimum POSTGRES_PASSWORD, JWT_SECRET, OPENROUTER_API_KEY,
# EMBEDDINGS_API_KEY, ADMIN_EMAIL, ADMIN_PASSWORD
docker compose pull
docker compose up -d
```

The web UI is on `WEB_PORT` (8080 by default). Sign in with the `ADMIN_EMAIL` /
`ADMIN_PASSWORD` seeded on first boot, then create the rest of the accounts from
`/admin/users` — there is no public sign-up.

If the images are private, `docker login ghcr.io` with a PAT that has `read:packages`
before pulling.

### What is exposed

Only `web` publishes a port. Postgres, the API, and the worker are reachable only on the
compose network. Put TLS in front of `web` — Caddy, nginx, or a load balancer — and keep
it the only thing listening publicly. The API has no CORS handling and expects to be
reached through the web container's `/api/` proxy.

## Schema

The `db-init` service applies `packages/db/schema.sql` (baked into the API image) and
exits before anything else starts. The schema is idempotent — `CREATE TABLE IF NOT
EXISTS`, `ADD COLUMN IF NOT EXISTS` — so it runs on every deploy and a fresh database
ends up identical to one several versions old. There is no migration table and no
ordering to get wrong.

By hand, against a running stack:

```sh
docker compose run --rm api pnpm migrate
```

Destructive changes and data backfills deliberately are *not* in that file. Anything that
cannot be re-run safely does not belong in something that runs on every boot.

## Upgrading

```sh
docker compose pull && docker compose up -d
```

`db-init` re-applies the schema first. With `VERSION` pinned in `.env`, bump it and repeat
— that is the deliberate version of the same two commands.

## Scaling and knobs

- **No worker.** Drop the `worker` service and set `JOBS_ENABLED=false`; every producer
  then does its work inline. The API stays fully functional, only slower — embeddings
  happen on the request, and consolidation and summaries stop running at all.
- **More than one worker.** `docker compose up -d --scale worker=3`, but exactly one may
  run the scheduler: set `SCHEDULER_ENABLED=false` on the others. The overlap guard and
  the `schedule:<id>` dedupe key make a double-fire harmless, there is just no reason to
  pay for it. Job claiming is `FOR UPDATE SKIP LOCKED`, so the workers themselves need no
  coordination.
- **Model and cadences.** `AGENT_MODEL`, `SUMMARY_MODEL`, and the `*_CRON` schedules are
  all environment variables — see the root [`.env.example`](../.env.example) for the full
  list. Changing a cron takes effect on the next worker start, which re-seeds the system
  schedules from config.

## Backups

Everything durable is in Postgres — conversations, memory, jobs, schedules, traces:

```sh
docker compose exec postgres pg_dump -U postgres mini_agent | gzip > backup-$(date +%F).sql.gz
```

The volume is `mini-agent_postgres-data`. Nothing else on the host holds state.
