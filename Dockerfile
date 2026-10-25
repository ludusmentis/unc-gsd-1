# syntax=docker/dockerfile:1

# ---- deps + build stage ----
FROM node:20-slim AS build
WORKDIR /app
# Build toolchain for better-sqlite3's node-gyp fallback (python3/make/g++).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Full node_modules (better-sqlite3 native module + tsx are runtime deps).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY package.json package-lock.json tsconfig.json next.config.js ./
COPY src ./src
COPY scripts ./scripts
# Non-root user + writable data dir (DB_PATH default ./data/nursehound.db).
RUN useradd --system --home /app --shell /usr/sbin/nologin nursehound \
    && mkdir -p /app/data && chown -R nursehound:nursehound /app/data
USER nursehound
EXPOSE 3000
CMD ["npx", "tsx", "src/server/main.ts"]
