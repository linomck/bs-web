# syntax=docker/dockerfile:1

# ---- Builder: installiert Dependencies (better-sqlite3 braucht Build-Tools) ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# ---- Runtime: schlankes Image ohne Build-Tools ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN groupadd -r bsweb && useradd -r -g bsweb bsweb \
    && mkdir -p /app/data \
    && chown -R bsweb:bsweb /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

RUN chown -R bsweb:bsweb /app
USER bsweb

EXPOSE 3000
CMD ["node", "server.js"]
