#!/usr/bin/env sh
set -eu

if docker compose version >/dev/null 2>&1; then
  exec docker compose up --build "$@"
fi

exec docker-compose up --build "$@"
