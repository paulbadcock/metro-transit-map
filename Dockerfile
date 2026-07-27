FROM node:24-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime

WORKDIR /app

COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --chown=65532:65532 server.js ./
COPY --chown=65532:65532 public/ ./public/

# Base image runs as non-root (uid 65532) with no shell/package manager present.
EXPOSE 4040

CMD ["server.js"]
