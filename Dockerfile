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

# 以非 root 运行。node 镜像自带 node 用户；容器里这个进程只需要写 /app/.runtime（具名卷）。
# 先把目录建出来并改属主：Docker 首次创建具名卷时会把镜像里那个目录的内容与属主复制进去，
# 所以属主必须在镜像里就是对的，否则挂上来的卷是 root 的、非 root 进程写不进去。
# 【升级注意】已经存在的旧卷是 root 属主，换到非 root 之后要手工 chown 一次（见 README）。
RUN mkdir -p /app/.runtime && chown -R node:node /app
USER node

ENV AIMAC_HOST=0.0.0.0
ENV AIMAC_PORT=4317
ENV AIMAC_RUNTIME_DIR=/app/.runtime
ENV AIMAC_REPOSITORY_ROOT=/app

EXPOSE 4317

CMD ["npm", "run", "shell:start"]
