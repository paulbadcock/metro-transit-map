FROM node:26-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Strips ~30MB of transitive dependencies that are only installed because
# gtfs-realtime-bindings mis-declares its own build-time-only codegen CLI
# (protobufjs-cli) as a regular dependency -- see the script for the full
# explanation. Needs package.json/package-lock.json already in place (just
# copied above) since it inspects the installed tree via `npm ls`.
COPY scripts/prune-unused-transitive-deps.js ./scripts/
RUN node scripts/prune-unused-transitive-deps.js

# Pre-create the GTFS data directory here (this stage still has a shell) so
# it exists in the image with the right ownership. docker-compose mounts a
# named volume at this path; on first use Docker seeds a fresh volume from
# whatever the image already has there -- including ownership -- so without
# this the volume ends up root-owned and unwritable by the non-root runtime.
RUN mkdir -p /app/data/gtfs

FROM gcr.io/distroless/nodejs26-debian13:nonroot AS runtime

WORKDIR /app

COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/data ./data
COPY --chown=65532:65532 package.json ./
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
