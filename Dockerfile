# syntax=docker/dockerfile:1.7

# ---------- Build stage: has Python + build tools ----------
FROM node:22-bookworm-slim AS deps

WORKDIR /app

# Install Python and build deps needed by mediasoup
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    pkg-config \
    libtool \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python

COPY package.json package-lock.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ---------- Runtime stage: slim, no Python ----------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

USER node

EXPOSE 3001

CMD ["node", "index.js"]