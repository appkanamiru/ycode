# Ycode on plain Postgres (YCODE_DB_DRIVER=postgres), see deploy/README.md.
#
# One image for the app and its migrations: `npm run migrate:postgres` runs
# the TypeScript migrations with ts-node, so the full node_modules is kept.

FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
# Git hooks are for development only
ENV HUSKY=0
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24.22.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    HUSKY=0 \
    STORAGE_DIR=/data/uploads
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
EXPOSE 3002
CMD ["node_modules/.bin/next", "start", "-p", "3002"]
