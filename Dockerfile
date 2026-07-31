# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build-time deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Copy sources and build (tsc + copy dashboard public assets).
COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Prune devDependencies for a leaner production install.
RUN npm prune --omit=dev

# ---- Runtime stage ----
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    OPENCODE_ROUTER_PLUGIN_MODE=1

# Bring over the production node_modules and the build output.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# The proxy and dashboard ports (overridable via env at runtime).
EXPOSE 18904 18905

# Persisted config/state lives here (router-config.json, router-state.json,
# router-keys.enc, router.pid, logs). Mount a named volume on /data and point
# CONFIG_DIR at it.
ENV CONFIG_DIR=/data

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.DASHBOARD_PORT||18904) +'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/bin.js"]