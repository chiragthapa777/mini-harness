# The job runner. Same image shape as the API — TS straight off source via tsx.
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

WORKDIR /app

# Workspace manifests first so `pnpm install` is cached across source-only edits.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/memory/package.json packages/memory/package.json
COPY packages/search/package.json packages/search/package.json

RUN pnpm install --frozen-lockfile

COPY apps/worker apps/worker
COPY packages packages
COPY skills skills

ENV SKILLS_DIR=/app/skills

# `pnpm start` runs `tsx --env-file=../../.env`; real config comes from compose
# `environment`/`env_file`, which Node's --env-file never overrides — this file
# just has to exist so the flag doesn't fail on a missing path.
RUN touch /app/.env

WORKDIR /app/apps/worker
CMD ["pnpm", "start"]
