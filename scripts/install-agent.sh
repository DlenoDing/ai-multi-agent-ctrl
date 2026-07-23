#!/usr/bin/env sh
set -eu

SERVER_URL="${AIMAC_SERVER_URL:-__AIMAC_SERVER_URL__}"
JOIN_TOKEN="${AIMAC_AGENT_JOIN_TOKEN:-}"
NODE_NAME="${AIMAC_AGENT_NODE_NAME:-$(hostname 2>/dev/null || uname -n)}"
WORK_DIR="${AIMAC_AGENT_WORK_DIR:-${HOME}/.local/share/aimac-agent}"
ROLES="${AIMAC_AGENT_ROLES:-}"
EXECUTOR_COMMAND="${AIMAC_AGENT_EXECUTOR_COMMAND:-}"
START_DAEMON=true
CONFIGURE_GLOBAL_CLIENTS=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) SERVER_URL=$2; shift 2 ;;
    --join-token) JOIN_TOKEN=$2; shift 2 ;;
    --node-name) NODE_NAME=$2; shift 2 ;;
    --work-dir) WORK_DIR=$2; shift 2 ;;
    --roles) ROLES=$2; shift 2 ;;
    --executor-command) EXECUTOR_COMMAND=$2; shift 2 ;;
    --no-daemon) START_DAEMON=false; shift ;;
    --configure-global-clients|--configure-clients) CONFIGURE_GLOBAL_CLIENTS=true; shift ;;
    --no-configure-global-clients|--no-configure-clients) CONFIGURE_GLOBAL_CLIENTS=false; shift ;;
    *) printf '%s\n' "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$SERVER_URL" ]; then
  printf '%s\n' "--server is required" >&2
  exit 2
fi
if [ -z "$JOIN_TOKEN" ]; then
  printf '%s\n' "--join-token or AIMAC_AGENT_JOIN_TOKEN is required" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "Node.js 20 or newer is required on the Agent host" >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 20 ]; then
  printf '%s\n' "Node.js 20 or newer is required; found $(node --version)" >&2
  exit 1
fi
for required_command in curl git; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf '%s\n' "$required_command is required on the Agent host" >&2
    exit 1
  fi
done

SERVER_URL=${SERVER_URL%/}
case "$SERVER_URL" in
  https://*) ;;
  http://127.0.0.1*|http://localhost*|http://\[::1\]*) ;;
  http://*)
    if [ "${AIMAC_AGENT_ALLOW_INSECURE_HTTP:-false}" != "true" ]; then
      printf '%s\n' "Public Agent Gateway requires HTTPS. Set AIMAC_AGENT_ALLOW_INSECURE_HTTP=true only for isolated verification." >&2
      exit 1
    fi
    ;;
  *) printf '%s\n' "invalid server URL: $SERVER_URL" >&2; exit 2 ;;
esac

BIN_DIR="$WORK_DIR/bin"
RUNTIME_PATH="$BIN_DIR/aimac-agent-runtime.mjs"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/aimac-agent-install.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

mkdir -p "$BIN_DIR" "$WORK_DIR/logs" "$WORK_DIR/run"
curl -fsSL "$SERVER_URL/agent-runtime.mjs" -o "$TMP_DIR/agent-runtime.mjs"
curl -fsSL "$SERVER_URL/agent-runtime.mjs.sha256" -o "$TMP_DIR/agent-runtime.mjs.sha256"

EXPECTED_HASH=$(awk '{print $1}' "$TMP_DIR/agent-runtime.mjs.sha256")
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_HASH=$(sha256sum "$TMP_DIR/agent-runtime.mjs" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_HASH=$(shasum -a 256 "$TMP_DIR/agent-runtime.mjs" | awk '{print $1}')
else
  printf '%s\n' "sha256sum or shasum is required" >&2
  exit 1
fi
if [ -z "$EXPECTED_HASH" ] || [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
  printf '%s\n' "Agent Runtime checksum verification failed" >&2
  exit 1
fi

install -m 700 "$TMP_DIR/agent-runtime.mjs" "$RUNTIME_PATH"

set -- bootstrap --server "$SERVER_URL" --join-token "$JOIN_TOKEN" --node-name "$NODE_NAME" --work-dir "$WORK_DIR" --configure-global-clients "$CONFIGURE_GLOBAL_CLIENTS"
if [ -n "$ROLES" ]; then
  set -- "$@" --roles "$ROLES"
fi
if [ -n "$EXECUTOR_COMMAND" ]; then
  set -- "$@" --executor-command "$EXECUTOR_COMMAND"
fi
node "$RUNTIME_PATH" "$@"

unset JOIN_TOKEN AIMAC_AGENT_JOIN_TOKEN

if [ "$START_DAEMON" = "true" ]; then
  PID_FILE="$WORK_DIR/run/agent.pid"
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
  fi
  nohup node "$RUNTIME_PATH" run --work-dir "$WORK_DIR" >>"$WORK_DIR/logs/agent.log" 2>&1 &
  AGENT_PID=$!
  printf '%s\n' "$AGENT_PID" >"$PID_FILE"
  printf '%s\n' "AGENT_RUNTIME_STARTED pid=$AGENT_PID log=$WORK_DIR/logs/agent.log"
else
  printf '%s\n' "AGENT_RUNTIME_READY command=node $RUNTIME_PATH run --work-dir $WORK_DIR"
fi
