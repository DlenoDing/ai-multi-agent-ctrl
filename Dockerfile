FROM node:22-alpine

RUN apk add --no-cache ruby git

WORKDIR /app

# Install runtime deps first for layer caching. The Postgres backend uses the pooled
# `pg` client (node-postgres, pure JS — no native build), reached from a worker thread;
# `psql` is no longer needed in this image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY Dockerfile ./
COPY docker-compose.yml ./
COPY .dockerignore ./
COPY .env.example ./
COPY README.md ./
COPY docs ./docs
COPY spec ./spec
COPY scripts ./scripts
COPY apps ./apps
COPY data ./data

ENV AIMAC_HOST=0.0.0.0
ENV AIMAC_PORT=4317
ENV AIMAC_RUNTIME_DIR=/app/.runtime
ENV AIMAC_REPOSITORY_ROOT=/app

EXPOSE 4317

CMD ["npm", "run", "shell:start"]
