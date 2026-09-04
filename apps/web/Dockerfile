# --- build stage --------------------------------------------------------
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/tui/package.json apps/tui/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/memory/package.json packages/memory/package.json
COPY packages/search/package.json packages/search/package.json

RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY packages/config packages/config
COPY tsconfig.base.json ./

RUN pnpm --filter @mini-agent/web build

# --- serve stage ---------------------------------------------------------
FROM nginx:alpine

# A template, not a config: the entrypoint renders it with envsubst at start,
# so the API's host and port come from the environment. The defaults below are
# what compose uses, so the image still works with no configuration at all.
ENV API_HOST=api
ENV API_PORT=3001

COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template

# Sourced by the nginx entrypoint before the template is rendered; it has to be
# executable or the entrypoint skips it.
COPY apps/web/docker-entrypoint.d/19-normalize-api-host.envsh /docker-entrypoint.d/
RUN chmod +x /docker-entrypoint.d/19-normalize-api-host.envsh
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
