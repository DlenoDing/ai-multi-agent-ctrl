// 「运维真会跑的入口」只此一份。此前它散在两处各写一遍：
// 参数拒绝那道门有完整清单，而环境变量那道门是手写的三个 —— 于是
// register-mcp-client.mjs 里读的 AIMAC_ALLOW_INSECURE_REMOTE_MCP 被后者报成"代码里根本没有"。
// 门的枚举面比真实窄，报出来的却是一句斩钉截铁的假话。
export const OPERATOR_CLIS = {
  "scripts/agentctl.mjs": "运维接机器时敲的命令行",
  "scripts/init-control-plane.mjs": "npm run init（--check 打错会真的去初始化）",
  "scripts/sync-agent-skills.mjs": "npm run skills:sync（--source 打错会同步默认源）",
  "scripts/register-mcp-client.mjs": "生成 MCP 客户端配置（--apply 打错会静默空跑）",
  "scripts/backup-runtime.mjs": "npm run backup（参数打错会把备份写到一个叫 --xxx 的目录里）"
};

// shell 入口。rejects=false 的那个把参数原样透传给别的命令，所以「认不出的参数要拒绝」
// 与「要答得上 --help」两条都不适用于它 —— 拦下来反而把人挡在真正的帮助前面。
export const OPERATOR_SHELL_ENTRIES = {
  "scripts/install-agent.sh": {rejects: true, why: "新机器上 curl | sh 装 agent"},
  "scripts/start.sh": {rejects: true, why: "本地起控制面"},
  "scripts/docker-up.sh": {rejects: false, why: "参数原样透传给 docker compose up --build"}
};

// 环境变量这类"代码里到底读没读过"的核对，要连 shell 入口一起看：
// 装机脚本里的 AIMAC_AGENT_* 就只出现在 .sh 里。
export const OPERATOR_ENTRY_FILES = [...Object.keys(OPERATOR_CLIS), ...Object.keys(OPERATOR_SHELL_ENTRIES)];
// run-with-env.mjs 是透传壳，不是运维入口，但它确实读环境变量 —— 环境旋钮那道门要看它。
export const ENV_READING_SUPPORT_FILES = ["scripts/run-with-env.mjs"];
