#!/usr/bin/env sh
set -eu

# 此前任何参数都被静默忽略：start.sh --port 8080 照样按默认端口起，人只会纳闷端口没变。
# 这个脚本本来就不接参数，所以给了就是误会 —— 直接说清它接不了，并指出该去哪儿改。
# --help 是任何人敲的第一件事：此前它落进下面那条"认不出这个参数"，非零退出、报错口吻。
case "${1:-}" in
  --help|-h)
    printf '%s\n' "用法：sh scripts/start.sh（不接任何参数）"
    printf '%s\n' "  · 它只是依次跑 npm run init 和 npm start"
    printf '%s\n' "  · 端口、存储、公开地址这些用环境变量配（见 README 的运维一节）"
    exit 0
    ;;
esac
if [ "$#" -gt 0 ]; then
  printf '%s\n' "start.sh: 认不出这个参数：$1" >&2
  printf '%s\n' "  · 这个脚本不接任何参数，它只是依次跑 npm run init 和 npm start" >&2
  printf '%s\n' "  · 端口、存储、公开地址这些用环境变量配（见 README 的运维一节）" >&2
  exit 2
fi

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

npm run init
npm start
