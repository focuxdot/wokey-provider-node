# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG PROVIDER_NODE_GIT_COMMIT=unknown
ARG PROVIDER_NODE_GIT_DIRTY=0
ARG PROVIDER_NODE_BUILD_AT
ENV PROVIDER_NODE_GIT_COMMIT=${PROVIDER_NODE_GIT_COMMIT}
ENV PROVIDER_NODE_GIT_DIRTY=${PROVIDER_NODE_GIT_DIRTY}
ENV PROVIDER_NODE_BUILD_AT=${PROVIDER_NODE_BUILD_AT}

RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PROVIDER_NODE_DOCKER=1
ENV PROVIDER_NODE_APP_DIR=/opt/wokey-provider-node/app
ENV PROVIDER_NODE_DATA_DIR=/data
ENV PROVIDER_CONFIG_PATH=/data/provider-node.json
ENV PROVIDER_CONSOLE_HOST=0.0.0.0
ENV PROVIDER_CONSOLE_PORT=16888
ENV PROVIDER_NODE_CLI_BASE_URL=http://127.0.0.1:16888
ENV NODE_USE_ENV_PROXY=1
ENV LOG_LEVEL=info

WORKDIR /opt/wokey-provider-node/app

COPY package.json package-lock.json README.md ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
RUN mkdir -p /opt/wokey-provider-node/bin /data

COPY --from=build --chown=node:node /src/dist ./dist
COPY --chmod=755 --chown=node:node packaging/linux/provider-node /opt/wokey-provider-node/bin/provider-node
COPY --chmod=755 --chown=node:node packaging/linux/provider-node-cli.mjs /opt/wokey-provider-node/bin/provider-node-cli.mjs

RUN chown -R node:node /opt/wokey-provider-node /data \
  && ln -sf /opt/wokey-provider-node/bin/provider-node /usr/local/bin/wokey-node

USER node

VOLUME ["/data"]
EXPOSE 16888

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PROVIDER_CONSOLE_PORT || '16888') + '/api/status').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["wokey-node"]
CMD ["serve"]
