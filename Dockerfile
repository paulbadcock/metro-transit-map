FROM cgr.dev/chainguard/node:latest-dev AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

FROM cgr.dev/chainguard/node:latest AS runtime

WORKDIR /app

COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --chown=65532:65532 server.js ./
COPY --chown=65532:65532 public/ ./public/

# Base image runs as non-root (uid 65532) by default.
EXPOSE 4040

CMD ["server.js"]
