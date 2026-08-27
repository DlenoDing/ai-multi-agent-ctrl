#!/usr/bin/env sh
set -eu

# 先收紧 umask，再落盘。下面写的是本机的引导令牌与 PostgreSQL 口令；
# 只在写完之后 chmod 600 的话，从 `cat >` 到 chmod 之间那一瞬，文件是按默认 umask 建的
# （多用户机器上通常 0644）—— 别人在那一瞬读得到。装 agent 的那条命令用的是同一招。
umask 077
ENV_FILE="${AIMAC_DOCKER_ENV_FILE:-.runtime/docker.env}"
mkdir -p "$(dirname "$ENV_FILE")"

random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  if [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
    printf '\n'
    return
  fi
  if command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex") + "\n")'
    return
  fi
  printf '%s\n' 'docker-up: 生成密钥需要一个安全随机源，这台机器上 openssl 与 node 都没有' >&2
  printf '%s\n' '  · 装其中任意一个再重跑（openssl 通常随系统自带）' >&2
  printf '%s\n' '  · 这一步之前什么都没有被改；不需要先清理' >&2
  exit 1
}

value_or_generated() {
  name="$1"
  fallback_prefix="$2"
  eval "current=\${$name:-}"
  if [ -n "$current" ]; then
    printf '%s\n' "$current"
  elif [ -n "$(existing_env_value "$name")" ]; then
    existing_env_value "$name"
  else
    printf '%s-%s\n' "$fallback_prefix" "$(random_token)"
  fi
}

existing_env_value() {
  name="$1"
  if [ ! -f "$ENV_FILE" ]; then
    return
  fi
  awk -F= -v key="$name" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE"
}

value_or_existing_or_default() {
  name="$1"
  fallback="$2"
  eval "current=\${$name:-}"
  if [ -n "$current" ]; then
    printf '%s\n' "$current"
  elif [ -n "$(existing_env_value "$name")" ]; then
    existing_env_value "$name"
  else
    printf '%s\n' "$fallback"
  fi
}

AIMAC_PORT_VALUE="$(value_or_existing_or_default AIMAC_PORT 4317)"
AIMAC_PUBLIC_URL_VALUE="$(value_or_existing_or_default AIMAC_PUBLIC_URL "http://127.0.0.1:${AIMAC_PORT_VALUE}")"
AIMAC_TRUST_PROXY_VALUE="$(value_or_existing_or_default AIMAC_TRUST_PROXY false)"
AIMAC_SYSTEM_ADMIN_EMAIL_VALUE="$(value_or_existing_or_default AIMAC_SYSTEM_ADMIN_EMAIL system.admin@local)"
AIMAC_SYSTEM_ADMIN_NAME_VALUE="$(value_or_existing_or_default AIMAC_SYSTEM_ADMIN_NAME "System Owner")"
AIMAC_BOOTSTRAP_TOKEN_VALUE="$(value_or_generated AIMAC_BOOTSTRAP_TOKEN aimac-bootstrap)"
AIMAC_MCP_SERVICE_TOKEN_VALUE="$(value_or_generated AIMAC_MCP_SERVICE_TOKEN aimac-mcp-service)"
AIMAC_LOCAL_SEED_WORKSPACE_OWNER_TOKEN_VALUE="$(value_or_generated AIMAC_LOCAL_SEED_WORKSPACE_OWNER_TOKEN aimac-workspace-owner)"
AIMAC_LOCAL_SEED_REVIEWER_TOKEN_VALUE="$(value_or_generated AIMAC_LOCAL_SEED_REVIEWER_TOKEN aimac-reviewer)"
AIMAC_LOCAL_SEED_AGENT_RUNTIME_TOKEN_VALUE="$(value_or_generated AIMAC_LOCAL_SEED_AGENT_RUNTIME_TOKEN aimac-agent-runtime)"
POSTGRES_PASSWORD_VALUE="$(value_or_generated POSTGRES_PASSWORD aimac-postgres)"

cat > "$ENV_FILE" <<EOF
AIMAC_PORT=${AIMAC_PORT_VALUE}
AIMAC_PUBLIC_URL=${AIMAC_PUBLIC_URL_VALUE}
AIMAC_TRUST_PROXY=${AIMAC_TRUST_PROXY_VALUE}
AIMAC_SYSTEM_ADMIN_EMAIL=${AIMAC_SYSTEM_ADMIN_EMAIL_VALUE}
AIMAC_SYSTEM_ADMIN_NAME=${AIMAC_SYSTEM_ADMIN_NAME_VALUE}
AIMAC_BOOTSTRAP_TOKEN=${AIMAC_BOOTSTRAP_TOKEN_VALUE}
AIMAC_MCP_SERVICE_TOKEN=${AIMAC_MCP_SERVICE_TOKEN_VALUE}
AIMAC_LOCAL_SEED_WORKSPACE_OWNER_TOKEN=${AIMAC_LOCAL_SEED_WORKSPACE_OWNER_TOKEN_VALUE}
AIMAC_LOCAL_SEED_REVIEWER_TOKEN=${AIMAC_LOCAL_SEED_REVIEWER_TOKEN_VALUE}
AIMAC_LOCAL_SEED_AGENT_RUNTIME_TOKEN=${AIMAC_LOCAL_SEED_AGENT_RUNTIME_TOKEN_VALUE}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD_VALUE}
EOF
chmod 600 "$ENV_FILE"

# 起容器之前把人接下来要找的三样说清：密钥在哪个文件、控制台在哪、拿哪把令牌登录。
# 原先直接 exec 进 compose 的日志流，人只看得到服务端横幅里的地址，令牌得自己去猜在 .runtime/docker.env。
announce_keys() {
  printf '%s\n' "docker-up: 密钥已写在 ${ENV_FILE}（权限 600，别提交进仓库）。起来后打开控制台 ${AIMAC_PUBLIC_URL:-http://127.0.0.1:4317}，登录账号 system.admin@local，令牌是该文件里的 AIMAC_BOOTSTRAP_TOKEN；远程 MCP 客户端用 AIMAC_MCP_SERVICE_TOKEN。" >&2
}

if docker compose version >/dev/null 2>&1; then
  announce_keys
  exec docker compose --env-file "$ENV_FILE" up --build "$@"
fi
# 两个都没有时，原先会落到下面那行 exec 上，人看到的是 "docker-compose: command not found" ——
# 那指的是已经废弃的 v1，照着它去装反而走错路。这里明说该装什么。
if ! command -v docker-compose >/dev/null 2>&1; then
  printf '%s\n' 'docker-up: 这台机器上找不到 Docker Compose' >&2
  printf '%s\n' '  · 装 Docker Desktop（自带 compose 插件），或给已有的 Docker 装上 compose 插件' >&2
  printf '%s\n' '  · 验证：docker compose version' >&2
  printf '%s\n' '  · 只想本地跑、不用容器的话：npm run init && npm start' >&2
  printf '%s\n' "  · 已经生成 $ENV_FILE（含随机密钥，权限 600）：装好 compose 后直接重跑即可，不必删它" >&2
  exit 1
fi

announce_keys
exec docker-compose --env-file "$ENV_FILE" up --build "$@"
