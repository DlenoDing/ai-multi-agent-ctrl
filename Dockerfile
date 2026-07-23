FROM node:22-alpine

RUN apk add --no-cache ruby git

WORKDIR /app

COPY package.json ./
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

RUN npm run init -- --force

EXPOSE 4317

CMD ["npm", "start"]
