# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/data/package.json ./packages/data/
COPY packages/domain/package.json ./packages/domain/
RUN npm ci

FROM dependencies AS builder
COPY . .
RUN npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/perfectly-balanced.sqlite
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node apps/web/package.json ./apps/web/
COPY --chown=node:node apps/web/src/server ./apps/web/src/server
COPY --chown=node:node packages ./packages
COPY --chown=node:node scripts/container/migrate.ts scripts/container/account.ts \
    scripts/container/import.ts scripts/container/dump.ts scripts/container/backup.ts \
    scripts/container/worker.ts scripts/container/start.ts scripts/container/health.ts ./scripts/container/
COPY --chown=node:node scripts/cutover/legacy.ts ./scripts/cutover/
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "scripts/container/start.ts"]
