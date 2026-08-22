#!/usr/bin/env node
// 这个命令行是运维接机器时真正会敲的东西，而它此前每一条失败路径都是【一段 Node 崩溃栈】：
// 连不上、令牌没给、子命令打错、ttl 写错，人看到的都是 at Object.<anonymous> 那一堆。
// 同一形状在 agent 运行时那侧已经修过（AIMAC_AGENT_DEBUG）。这里同规：一句人话 + 下一步，
// 堆栈留给 AIMAC_AGENTCTL_DEBUG=1。
const args = parseArgs(process.argv.slice(2));
const action = args._.join(" ");
const serverUrl = String(args.server || process.env.AIMAC_PUBLIC_URL || "http://127.0.0.1:4317").replace(/\/+$/u, "");

// 这两张表要声明在【用到它们的地方之前】：--help 那段会读它们，放在后面就是 TDZ，
// 表现是敲 --help 直接崩在一行源码上（本仓撞过多次的坑，这里第一版又踩了一遍）。
// 子命令打错会大声报错（上面那段），参数名打错却一声不吭 —— 同一个文件里的孪生分支只补了一半，
// 而这一半的默认值全都偏向"少做一点"：--verified 打错就静默给出【不做校验】的安装命令
// （verified 那条会另下 .sha256 校验安装脚本再执行），--roles/--ttl/--node-name 打错退回默认，
// nodes list 上写 --project 更是彻底空转。人以为自己要了某件事，屏幕上没有任何相反的迹象。
const GLOBAL_FLAGS = ["server", "session-token", "email", "token"];
const SUBCOMMAND_FLAGS = {
  "join-token create": ["project", "project-id", "node-name", "roles", "ttl", "max-uses", "idempotency-key", "verified"],
  "nodes list": [],
  doctor: []
};

// `--help` 是任何人敲的第一件事。此前它走到"认不出这个子命令"那条路上去了 ——
// 该说的内容本来就在下面，只是以"你做错了"的姿态给出、并且非零退出。
if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
  console.log("用法：npm run agentctl -- <子命令> [参数]");
  console.log("  · 子命令：join-token create | nodes list | doctor");
  console.log(`  · 通用参数：${GLOBAL_FLAGS.map((key) => `--${key}`).join(" ")}`);
  for (const [name, flags] of Object.entries(SUBCOMMAND_FLAGS)) {
    console.log(`  · ${name}：${flags.length ? flags.map((key) => `--${key}`).join(" ") : "只认上面那几个通用参数"}`);
  }
  console.log("  · 接一台新机器通常不用它：到「AI 智能体」页的「加入令牌管理」面板点「签发一次性加入令牌」");
  process.exit(0);
}
if (action !== "join-token create" && action !== "nodes list" && action !== "doctor") {
  fail(`认不出这个子命令${action ? `：${action}` : "（一个都没给）"}`,
    ["可用：agentctl join-token create | nodes list | doctor",
     "都要带 --server=<控制面地址>（默认 http://127.0.0.1:4317，也可用 AIMAC_PUBLIC_URL）",
     // 这句原先写的是"项目管理界面上「发加入令牌」"——页名和控件名两个都不存在
     // （真名：「AI 智能体」页 →「加入令牌管理」面板 →「签发一次性加入令牌」）。
     // 写成【页 + 面板 + 点某按钮】这三种形状，指路核对那道门才看得见它。
     "接一台新机器通常不用它：到「AI 智能体」页的「加入令牌管理」面板点「签发一次性加入令牌」，"
       + "会直接给出可粘贴的安装命令"]);
}

const knownFlags = new Set([...GLOBAL_FLAGS, ...SUBCOMMAND_FLAGS[action]]);
const unknownFlags = Object.keys(args).filter((key) => key !== "_" && !knownFlags.has(key));
if (unknownFlags.length) {
  fail(`认不出这些参数：${unknownFlags.map((key) => `--${key}`).join(" ")}`,
    [`「${action}」认得的参数：${[...knownFlags].map((key) => `--${key}`).join(" ")}`,
     "打错的参数会被当成没给，命令照跑 —— 所以这里直接拒绝，而不是替你猜",
     ...(SUBCOMMAND_FLAGS[action].length === 0 ? [`${action} 本身不接参数，只认上面那几个通用的`] : [])]);
}

// 参数值也要在【联网之前】校验：写错了却先去登录、再撞一句"连不上控制面"，
// 人会以为是网络问题，而真正的问题是他手上那条命令。
const joinTokenBody = action === "join-token create"
  ? {allowedRoles: parseRoles(args.roles), ttlSeconds: parseDurationSeconds(args.ttl || 1800),
    maxUses: parseMaxUses(args["max-uses"])}
  : null;

if (action === "doctor") {
  const health = await request("/api/health");
  const manifest = await request("/api/agent/v1/bootstrap-manifest");
  if (health.mcp?.transport !== "streamable-http" || manifest.localMcpServerAllowed !== false) {
    fail("这台控制面不是「集中式 MCP + 轻量 Agent 运行时」的配置",
      [`它自报的 MCP 传输是 ${health.mcp?.transport || "（没说）"}，期望 streamable-http`,
       `是否允许 agent 自带本地 MCP：${manifest.localMcpServerAllowed}（期望 false）`,
       "多半是连错了地址，或者这台服务跑的是旧版本"]);
  }
  console.log(`agent gateway doctor ok: ${manifest.serverUrl}`);
  process.exit(0);
}

const sessionToken = args["session-token"] || process.env.AIMAC_SESSION_TOKEN || await login();

if (action === "nodes list") {
  const nodes = await request("/api/agent-nodes", {token: sessionToken});
  console.log(JSON.stringify(nodes, null, 2));
  process.exit(0);
}

const projectId = args.project || args["project-id"];
if (!projectId) fail("发加入令牌必须指定项目", ["加 --project=<项目 id>（也可写 --project-id=）",
  "项目 id 在控制台「项目管理」页每行的最前面，形如 prj_xxx"]);
const result = await request("/api/agent-join-tokens", {
  method: "POST",
  token: sessionToken,
  idempotencyKey: args["idempotency-key"] || `agentctl-${Date.now()}`,
  body: {
    projectId,
    nodeName: args["node-name"] || undefined,
    ...joinTokenBody
  }
});
console.log(args.verified ? result.verifiedInstallCommand : result.installCommand);
console.log(`joinTokenId=${result.joinTokenRecord.joinTokenId}`);
console.log(`expiresAt=${result.joinTokenRecord.expiresAt}`);

async function login() {
  const email = args.email || process.env.AIMAC_ADMIN_EMAIL || "system.admin@local";
  const token = args.token || process.env.AIMAC_ADMIN_TOKEN || process.env.AIMAC_BOOTSTRAP_TOKEN;
  if (!token) {
    fail("没有可用的登录凭据",
      ["给 --token=<令牌>，或设环境变量 AIMAC_ADMIN_TOKEN / AIMAC_BOOTSTRAP_TOKEN",
       "已经有会话的话可以给 --session-token=<会话令牌>",
       "本地初始化时打印过 local bootstrap token（npm run init 的输出里）"]);
  }
  const result = await request("/api/auth/login", {method: "POST", body: {email, token}});
  return result.sessionToken;
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${serverUrl}${path}`, {
    method: options.method || (options.body ? "POST" : "GET"),
    headers: {
      accept: "application/json",
      ...(options.body ? {"content-type": "application/json"} : {}),
      ...(options.token ? {authorization: `Bearer ${options.token}`} : {}),
      ...(options.idempotencyKey ? {"idempotency-key": options.idempotencyKey} : {})
    },
      ...(options.body ? {body: JSON.stringify(options.body)} : {})
    });
  } catch (networkError) {
    fail(`连不上控制面 ${serverUrl}`,
      [String(networkError?.message || networkError).slice(0, 160),
       "确认服务在跑（npm start），或用 --server=<地址> 指到正确的位置",
       "默认地址是 http://127.0.0.1:4317，也可用环境变量 AIMAC_PUBLIC_URL"]);
  }
  // 服务端不一定回 JSON：连到别的服务、被代理挡下、502 空响应，都会让 .json() 抛
  // "Unexpected token <" —— 那句话对运维没有任何意义。
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail(`${serverUrl}${path} 返回的不是 JSON（HTTP ${response.status}）`,
      ["多半是连到了别的服务，或中间有代理/网关挡着",
       "先用浏览器打开控制面地址确认它是本产品的控制台"]);
  }
  if (!response.ok) {
    fail(`${path} 请求失败（HTTP ${response.status}：${payload.error || "request_failed"}）`,
      [payload.message || payload.reason || "服务端没有给更多说明",
       ...(Array.isArray(payload.supported) ? [`可选值：${payload.supported.join(" / ")}`] : []),
       ...(Array.isArray(payload.required) ? [`还需要：${payload.required.join(" / ")}`] : [])]);
  }
  return payload;
}

function parseArgs(argv) {
  const result = {_ : []};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) result._.push(arg);
    else if (arg.includes("=")) result[arg.slice(2, arg.indexOf("="))] = arg.slice(arg.indexOf("=") + 1);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) result[arg.slice(2)] = argv[++index];
    else result[arg.slice(2)] = true;
  }
  return result;
}

// 参数【名】打错会被上面那段拒掉，参数【值】写错原先一声不吭，而默认值全都偏向"少做一点"：
// --max-uses=abc 变成 NaN（JSON 里成了 null，服务端按自己的默认走）、--max-uses=0 静默变成 1、
// --roles= 静默退回 agent-runtime。人以为自己要了某件事，屏幕上没有任何相反的迹象。
function parseMaxUses(raw) {
  if (raw === undefined) return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    fail(`--max-uses 认不出：${raw}`,
      ["要一个 ≥1 的整数（一次性票写 1）",
       "写 0 原先会被静默当成 1 —— 想让一张票能用多次就明确写次数，别指望它替你猜"]);
  }
  return value;
}

function parseRoles(raw) {
  if (raw === undefined) return ["agent-runtime"];
  const roles = String(raw).split(",").map((item) => item.trim()).filter(Boolean);
  if (!roles.length) {
    fail(`--roles 是空的：${JSON.stringify(String(raw))}`,
      ["逗号分隔，例如 --roles=agent-runtime,reviewer",
       "不写这个参数才是用默认的 agent-runtime；写了却是空的，原先会静默退回默认"]);
  }
  return roles;
}

function parseDurationSeconds(value) {
  if (typeof value === "number") return value;
  const raw = String(value || "").trim();
  if (/^\d+$/u.test(raw)) return Number(raw);
  const match = raw.match(/^(\d+)(s|m|h|d)$/u);
  if (!match) fail(`--ttl 写法认不出：${raw}`, ["可写秒数（1800），或 30m / 2h / 1d 这种形式"]);
  const amount = Number(match[1]);
  const scale = {s: 1, m: 60, h: 3600, d: 86400}[match[2]];
  return amount * scale;
}

// 一句人话 + 下一步，退出码 1；堆栈留给 AIMAC_AGENTCTL_DEBUG=1。
// 与 agent 运行时那侧同规：运维在自己机器上敲命令，不该收到一段 Node 崩溃栈。
function fail(summary, nextSteps = []) {
  console.error(`agentctl: ${summary}`);
  for (const step of nextSteps.filter(Boolean)) console.error(`  · ${step}`);
  if (process.env.AIMAC_AGENTCTL_DEBUG === "1") console.error(new Error(summary).stack);
  else console.error("  （要看完整堆栈：AIMAC_AGENTCTL_DEBUG=1 重跑）");
  process.exit(1);
}
