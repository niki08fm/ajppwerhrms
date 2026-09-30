# AJPWER Workforce — one image: the API serves the built web app.
# Build:  docker build -t ajpwer-workforce .
# Run:    docker compose --profile app up -d   (see docker-compose.yml)

FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci
COPY . .
RUN npm run build --workspace=@ajpwer/api && npm run build --workspace=@ajpwer/web

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    SERVE_WEB_DIR=/app/apps/web/dist \
    UPLOAD_DIR=/data/uploads \
    EXPORT_DIR=/data/exports \
    TZ=UTC
COPY --from=build /app /app
RUN mkdir -p /data/uploads /data/exports && chown -R node:node /data
USER node
EXPOSE 4000
ENTRYPOINT ["/usr/bin/tini", "--"]
# Apply migrations, then start. The same image runs the worker with: node apps/api/dist/worker.js
CMD ["sh", "-c", "npx prisma migrate deploy --schema apps/api/prisma/schema.prisma && node apps/api/dist/server.js"]
