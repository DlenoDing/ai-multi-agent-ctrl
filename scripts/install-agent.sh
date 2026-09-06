#!/usr/bin/env sh
set -eu

SERVER_URL="${AIMAC_SERVER_URL:-__AIMAC_SERVER_URL__}"
JOIN_TOKEN="${AIMAC_AGENT_JOIN_TOKEN:-}"
JOIN_TOKEN_FILE=""
NODE_NAME="${AIMAC_AGENT_NODE_NAME:-$(hostname 2>/dev/null || uname -n)}"
case "$(uname -s)" in
  Darwin) DEFAULT_WORK_DIR="${HOME}/Library/Application Support/aimac-agent" ;;
  *) DEFAULT_WORK_DIR="${HOME}/.local/share/aimac-agent" ;;
esac
WORK_DIR="${AIMAC_AGENT_DATA_ROOT:-${AIMAC_AGENT_WORK_DIR:-${DEFAULT_WORK_DIR}}}"
ROLES="${AIMAC_AGENT_ROLES:-}"
EXECUTOR_COMMAND="${AIMAC_AGENT_EXECUTOR_COMMAND:-}"
START_DAEMON=true
CONFIGURE_GLOBAL_CLIENTS=true

# 带取值的参数少了取值时，set -u 会让 $2 直接炸成 "line 20: $2: unbound variable" ——
# 这是 shell 版的崩溃栈，而复制安装命令时被截断正是最常见的情形。
need_value() {
  if [ "$2" -lt 2 ]; then
    printf '%s\n' "install-agent: $1 后面少了取值" >&2
    printf '%s\n' "  · 多半是复制安装命令时被截断了 —— 回控制台那一页重新复制整条命令" >&2
    exit 2
  fi
}

# --help 是任何人敲的第一件事。此前它落到下面的 * 分支被当成打错的参数（退出码 2、报错口吻）——
# 该说的内容本来就在那里，只是以"你做错了"的姿态给出。同样的话，问的时候就该给。
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      printf '%s\n' "用法：sh install-agent.sh --server <地址> --join-token-file <文件> [其它参数]"
      printf '%s\n' "  · 必给：--server，以及 --join-token 或 --join-token-file 之一"
      printf '%s\n' "  · 认得的参数：--server --join-token --join-token-file --node-name --work-dir"
      printf '%s\n' "                --roles --executor-command --no-daemon"
      printf '%s\n' "                --configure-global-clients / --no-configure-global-clients（默认自动配置；别名 --configure-clients / --no-configure-clients）"
      printf '%s\n' "  · --executor-command：自定义模型执行器。不给时自动探测 codex / claude / gemini / ollama；"
      printf '%s\n' "    四个都没有、也不给它，这台节点就没有可用执行器，派发会卡住"
      exit 0
      ;;
  esac
done

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) need_value "$1" "$#"; SERVER_URL=$2; shift 2 ;;
    --join-token) need_value "$1" "$#"; JOIN_TOKEN=$2; shift 2 ;;
    --join-token-file) need_value "$1" "$#"; JOIN_TOKEN_FILE=$2; shift 2 ;;
    --node-name) need_value "$1" "$#"; NODE_NAME=$2; shift 2 ;;
    --work-dir) need_value "$1" "$#"; WORK_DIR=$2; shift 2 ;;
    --roles) need_value "$1" "$#"; ROLES=$2; shift 2 ;;
    --executor-command) need_value "$1" "$#"; EXECUTOR_COMMAND=$2; shift 2 ;;
    --no-daemon) START_DAEMON=false; shift ;;
    --configure-global-clients|--configure-clients) CONFIGURE_GLOBAL_CLIENTS=true; shift ;;
    --no-configure-global-clients|--no-configure-clients) CONFIGURE_GLOBAL_CLIENTS=false; shift ;;
    *)
      printf '%s\n' "install-agent: 认不出这个参数：$1" >&2
      printf '%s\n' "  · 认得的参数：--server --join-token --join-token-file --node-name --work-dir" >&2
      printf '%s\n' "                --roles --executor-command --no-daemon --configure-global-clients" >&2
      printf '%s\n' "  · 打错的参数会被当成没给（例如 --join-token 打错就变成"没有入网票"）——" >&2
      printf '%s\n' "    所以这里拒绝。整条命令建议回控制台那一页直接复制" >&2
      exit 2
      ;;
  esac
done

if [ -z "$SERVER_URL" ]; then
  printf '%s\n' "--server is required" >&2
  exit 2
fi
if [ -n "$JOIN_TOKEN_FILE" ]; then
  if [ ! -f "$JOIN_TOKEN_FILE" ]; then
    # 把找的是哪个路径说出来：人多半是从控制台复制的整条命令，路径错在哪儿只有脚本知道。
    printf '%s\n' "--join-token-file does not exist: $JOIN_TOKEN_FILE" >&2
    exit 2
  fi
  JOIN_TOKEN=$(sed -n '1p' "$JOIN_TOKEN_FILE")
fi
if [ -z "$JOIN_TOKEN" ]; then
  printf '%s\n' "--join-token-file, --join-token or AIMAC_AGENT_JOIN_TOKEN is required" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "Node.js 20 or newer is required on the Agent host" >&2
  printf '%s\n' "  · 装好 Node 20+ 后重跑这条安装命令即可；本机什么都没有被安装" >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 20 ]; then
  printf '%s\n' "Node.js 20 or newer is required; found $(node --version)" >&2
  printf '%s\n' "  · 升级 Node 后重跑这条安装命令即可；本机什么都没有被安装" >&2
  exit 1
fi
for required_command in curl git; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf '%s\n' "$required_command is required on the Agent host" >&2
    printf '%s\n' "  · 装好它之后重跑这条安装命令即可；本机什么都没有被安装" >&2
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
      printf '%s\n' "  · 明文 http 会把加入令牌暴露在链路上；换 https 地址后重跑；本机什么都没有被安装" >&2
      exit 1
    fi
    ;;
  *) printf '%s\n' "invalid server URL: $SERVER_URL" >&2; exit 2 ;;
esac

BIN_DIR="$WORK_DIR/bin"
RUNTIME_PATH="$BIN_DIR/aimac-agent-runtime.mjs"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/aimac-agent-install.XXXXXX")
cleanup() {
  rm -rf "$TMP_DIR"
  if [ -n "$JOIN_TOKEN_FILE" ] && [ "${AIMAC_AGENT_KEEP_JOIN_TOKEN_FILE:-false}" != "true" ]; then
    rm -f "$JOIN_TOKEN_FILE" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$BIN_DIR" "$WORK_DIR/logs" "$WORK_DIR/run"
# 原先失败时只有 curl 自己那句英文（set -e 直接收场）：不说脚本当时在做什么、
# 也不说下一步。人是在一台新机器上 curl | sh，手上没有任何别的上下文。
download() {
  if ! curl -fsSL "$1" -o "$2"; then
    printf '%s\n' "install-agent: 下载不到$3" >&2
    printf '%s\n' "  · 地址：$1" >&2
    printf '%s\n' "  · 上面那行 curl 的报错就是原因：连不上多半是 --server 写错、或控制面没在跑；" >&2
    printf '%s\n' "    404 则说明这个地址上的服务不是本产品的控制面" >&2
    printf '%s\n' "  · 本机什么都没有被安装" >&2
    exit 1
  fi
}
download "$SERVER_URL/agent-runtime.mjs" "$TMP_DIR/agent-runtime.mjs" "Agent 运行时"
download "$SERVER_URL/agent-runtime.mjs.sha256" "$TMP_DIR/agent-runtime.mjs.sha256" "Agent 运行时的校验和"

EXPECTED_HASH=$(awk '{print $1}' "$TMP_DIR/agent-runtime.mjs.sha256")
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_HASH=$(sha256sum "$TMP_DIR/agent-runtime.mjs" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_HASH=$(shasum -a 256 "$TMP_DIR/agent-runtime.mjs" | awk '{print $1}')
else
  printf '%s\n' "sha256sum or shasum is required（校验下载下来的运行时要用它）" >&2
  printf '%s\n' "  · 装好其中一个后重跑；本机什么都没有被安装" >&2
  exit 1
fi
if [ -z "$EXPECTED_HASH" ] || [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
  # 校验和对不上是这套安装流程里最要紧的一次失败：它要么是下载损坏，要么是产物在路上被换过。
  # 原先只说 "verification failed"——不说是哪个文件、期望什么、实到什么，也不说接下来该怎么办。
  # 人在这一刻最需要的恰恰是这三件事，而它们都是脚本此刻就知道的。
  printf '%s\n' "Agent Runtime checksum verification failed" >&2
  printf '%s\n' "  file:     $SERVER_URL/agent-runtime.mjs" >&2
  printf '%s\n' "  expected: ${EXPECTED_HASH:-（校验和文件是空的，服务端没给出期望值）}" >&2
  printf '%s\n' "  actual:   $ACTUAL_HASH" >&2
  printf '%s\n' "  这份产物没有被安装。重试一次；仍不一致就【不要运行它】——" >&2
  printf '%s\n' "  说明下载损坏，或者控制面到本机之间有人替换了产物。" >&2
  exit 1
fi

install -m 700 "$TMP_DIR/agent-runtime.mjs" "$RUNTIME_PATH"

if [ -z "$JOIN_TOKEN_FILE" ]; then
  JOIN_TOKEN_FILE="$TMP_DIR/aimac.join"
  ( umask 077 && printf '%s' "$JOIN_TOKEN" > "$JOIN_TOKEN_FILE" )
fi

set -- bootstrap --server "$SERVER_URL" --join-token-file "$JOIN_TOKEN_FILE" --node-name "$NODE_NAME" --work-dir "$WORK_DIR" --configure-global-clients "$CONFIGURE_GLOBAL_CLIENTS"
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
  # 原先起完就无条件宣布 AGENT_RUNTIME_STARTED —— 进程当场退出也照说不误，
  # 装机的人以为装好了，而控制面那边永远等不到这个节点。先确认它还活着再宣布。
  sleep 1
  if ! kill -0 "$AGENT_PID" 2>/dev/null; then
    printf '%s\n' "install-agent: Agent 运行时起来之后立刻退出了" >&2
    printf '%s\n' "  · 日志：$WORK_DIR/logs/agent.log" >&2
    printf '%s\n' "  · 日志最后几行：" >&2
    tail -n 10 "$WORK_DIR/logs/agent.log" 2>/dev/null | sed 's/^/      /' >&2 || true
    printf '%s\n' "  · 排掉原因后重跑安装命令即可，不需要先清理" >&2
    exit 1
  fi
  printf '%s\n' "$AGENT_PID" >"$PID_FILE"
  printf '%s\n' "AGENT_RUNTIME_STARTED pid=$AGENT_PID log=$WORK_DIR/logs/agent.log"
  # 这个进程是 nohup 起的：宿主重启、或它自己崩掉之后【不会自己回来】。
  # 装的人看到 STARTED 会以为"装好了就一直在"，而节点一失联，排队的派发就没人认领
  #（控制面那边只会显示这个节点没有心跳，不会有人被通知）。这里说清楚，并给出常驻的做法。
  printf '%s\n' "注意：这是一个 nohup 进程 —— 宿主重启或它自己崩掉之后不会自动回来。"
  printf '%s\n' "  · 重新拉起：node $RUNTIME_PATH run --work-dir $WORK_DIR"
  printf '%s\n' "  · 要让它常驻（开机自启 + 崩了自动重启）：docs/agent-runtime-protocol.md 里有 systemd 与 launchd 两份现成配置"
else
  printf '%s\n' "AGENT_RUNTIME_READY command=node $RUNTIME_PATH run --work-dir $WORK_DIR"
fi
