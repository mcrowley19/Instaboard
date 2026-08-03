# The hosted demo, packaged.
#
# Two things this image has to carry that a plain Next.js image would not:
#
#   - `uv`, because the app reaches DataHub through `mcp-server-datahub`, which
#     it spawns over stdio. That is why the demo cannot run on a serverless host
#     and why the app is deployed next to DataHub rather than in front of it.
#   - Nothing else. No API key is baked in; the drift detection the demo runs has
#     no model in it, and the chat panel takes a key from the visitor's browser.

FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Runtime ──────────────────────────────────────────────────────────────
FROM node:22-slim

# curl for the healthcheck, uv for the DataHub MCP server the app spawns.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
  && ln -s /root/.local/bin/uv /usr/local/bin/uv \
  && ln -s /root/.local/bin/uvx /usr/local/bin/uvx

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.mjs ./

# Warm the MCP server into the uv cache at build time. Otherwise the first
# visitor pays a package download inside their request and sees a timeout.
RUN uvx mcp-server-datahub@latest --help > /dev/null 2>&1 || true

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD curl -fsS http://localhost:3000/ > /dev/null || exit 1

CMD ["npm", "start"]
