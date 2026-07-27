FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public/ ./public/

RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && mkdir -p /app/data/gtfs \
    && chown -R appuser:appgroup /app/data
USER appuser

EXPOSE 4040

CMD ["node", "server.js"]
