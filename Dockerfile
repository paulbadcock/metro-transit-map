FROM node:24-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime

WORKDIR /app

COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --chown=65532:65532 server.js ./
COPY --chown=65532:65532 lib/ ./lib/
COPY --chown=65532:65532 public/ ./public/

# Base image runs as non-root (uid 65532) with no shell/package manager present.
EXPOSE 4040

# No shell in this image, so HEALTHCHECK must exec node directly rather than
# a shell one-liner with curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch(`http://localhost:${process.env.PORT || 4040}/api/status`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["server.js"]
