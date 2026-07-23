#!/usr/bin/env sh
set -eu

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
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex") + "\\n")'
    return
  fi
  printf '%s\n' 'secure random source required: install openssl or node' >&2
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

if docker compose version >/dev/null 2>&1; then
  exec docker compose --env-file "$ENV_FILE" up --build "$@"
fi

exec docker-compose --env-file "$ENV_FILE" up --build "$@"
