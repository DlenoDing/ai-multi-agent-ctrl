import { execFileSync } from "node:child_process";
import { clampEnvNumber } from "./env-number.mjs";

// 命中网络的 git（ls-remote / 技能源 clone·fetch / push）必须有墙钟超时：execFileSync 默认无超时，
// 一个只接受不响应的远端会让它无限阻塞。其中【最危险的是同步阻塞事件循环】——syncSkillSource 跑在
// runAutonomousCycle→orchestrator tick（主线程）里，一次挂死的技能源 clone 就能冻住整个控制面（不再服务
// 任何请求）。本地快操作（rev-parse 等）远在超时之内、不受影响；超时到点 execFileSync 会 SIGTERM 掉 git
// 并抛 ETIMEDOUT，各调用点本就 catch（git() 返 fallback、gitStrict 抛 git_command_failed、技能同步转
// skillSyncBlocked），挂死因此变成干净降级。默认 10 分钟，AIMAC_GIT_COMMAND_TIMEOUT_MS 可调、下限 1 分钟、NaN 安全。
export function gitCommandTimeoutMs() {
  return clampEnvNumber(process.env.AIMAC_GIT_COMMAND_TIMEOUT_MS, 60000, 600000);
}

export function git(root = process.cwd(), args = [], fallback = "") {
  try {
    return execFileSync("git", ["-C", root, ...args], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: gitCommandTimeoutMs()}).trim();
  } catch {
    return fallback;
  }
}

// execFileSync 抛出来的 message 是 "Command failed: git -C <本机绝对路径> push origin …"：
// 【真正的原因在 stderr 里】（被拒的非快进、认证失败、连不上远端），而这条 message 会原样
// 变成运维在控制台看到的那句失败摘要 —— 既没说为什么，又把服务器的绝对路径给了出去。
export function gitStrict(root = process.cwd(), args = []) {
  try {
    return execFileSync("git", ["-C", root, ...args], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: gitCommandTimeoutMs()}).trim();
  } catch (error) {
    // stderr/status 原样带上：commitWithRuntimeIdentity 这类调用方要靠它认出"缺身份"那一种失败。
    throw Object.assign(new Error(`git_command_failed:${gitFailureText(args, error)}`),
      {cause: error, stderr: error?.stderr, status: error?.status});
  }
}

// git 自己说的原因。只取它的结论行（fatal/error/remote/warning 开头的那些）：其余是进度输出，
// 而进度里恰恰带着本机路径 —— "Cloning into '/var/folders/…'" 就会把服务器目录塞进给人看的报文。
// 一条结论行都没有时才退回末尾几行，并把这种情况如实说成"只有进度输出"。
export function gitFailureDetail(error) {
  const lines = String(error?.stderr || error?.stdout || "").trim().split("\n")
    .map((line) => line.trim()).filter(Boolean);
  const conclusions = lines.filter((line) => /^(fatal|error|remote|warning):/iu.test(line));
  const detail = (conclusions.length ? conclusions : lines).slice(-3).join("；").slice(0, 400);
  const prefix = conclusions.length || !detail ? "" : "只有进度输出：";
  return `退出码 ${error?.status ?? "?"}${detail ? `：${prefix}${detail}` : "，且没有任何输出"}`;
}

// 只保留命令与原因，不带 -C 后面的路径。
function gitFailureText(args, error) {
  return `git ${args.join(" ")}（${gitFailureDetail(error)}）`;
}

// 一次编排周期内的"仓库事实"备忘录。为什么需要：gitHead 与 gitRemoteUrl 都落在【每个工作项】
// 都会走的路径上（准备产出目标、写契约的 resourceDigestBefore），每次都是一个 git 子进程 ≈ 40ms。
// 实测 2000 个单元的一轮编排 83 秒，其中 96.6% 的 CPU 时间在 spawnSync —— 而编排是同步跑在
// 主线程上的，这段时间整个控制面不响应。这两样在一轮里都不会变，那些子进程算的是同一个值。
//
// 只收"一轮内不变的只读事实"：HEAD 与 remote url。像 diff --cached 这类会被同一轮里的写入
// 改变的查询绝不能进来 —— 它们在检查点受理路径上，那条路径确实会改仓库。
// 作用域刻意只到"一次周期"，不做 TTL：TTL 会让同一轮里的两次调用横跨过期点而读到两个值，
// 反而不如现在一致。周期之外备忘录为 null，行为与改动前完全相同（请求路径仍然实时取）。
let orchestrationGitFacts = null;

function memoizedGitFact(key, compute) {
  if (orchestrationGitFacts?.has(key)) return orchestrationGitFacts.get(key);
  const value = compute();
  orchestrationGitFacts?.set(key, value);
  return value;
}

export function beginOrchestrationGitFacts() {
  orchestrationGitFacts = new Map();
}

export function endOrchestrationGitFacts() {
  orchestrationGitFacts = null;
}

// git 答不上来时回落成的那个值。它长得像一个短提交号，所以【必须能被认出来】——
// 把「这台机器上根本没有那个仓库」记成一个看起来正常的基线提交，是本仓「缺省不得等于
// 有利结果」那一族最安静的样子：证据栏是满的，而它什么也没证明。
export const GIT_HEAD_UNAVAILABLE = "000000000000";

export function gitHead(root = process.cwd()) {
  return memoizedGitFact(`head\u0000${root}`, () => git(root, ["rev-parse", "--short=12", "HEAD"], GIT_HEAD_UNAVAILABLE));
}

// 要「取不到就是取不到」的调用方用这个。12 个 0 不可能是真实提交的短号，
// 而它是 gitHead 唯一会自己编出来的值，所以这个比较是可靠的。
export function gitHeadOrNull(root = process.cwd()) {
  const head = gitHead(root);
  return head === GIT_HEAD_UNAVAILABLE ? null : head;
}

export function gitRemoteUrl(root = process.cwd(), remote = "origin") {
  return memoizedGitFact(`remote\u0000${root}\u0000${remote}`, () => git(root, ["remote", "get-url", remote], ""));
}

// 用运行时身份提交，但【不改用户的仓库配置】。
// 原写法是每次提交前先问两次 `git config`，没配就把 agent-runtime@local 永久写进那个仓库 ——
// 常见路径上白付两次子进程，而且留下一个我们不该留的副作用（在别人的仓库里改配置）。
// 这里改成：先按仓库自己的身份提交；只有 git 因为缺身份拒绝时，才用 -c 就地补一个。
// 语义与原来一致（配了就用配的），-c 只作用于这一次调用。
// 抽成导出函数是为了让"没配身份的仓库"这个情形【测得到】：它在真实夹具里造不出来
// （机器全局配置里总有身份），而不可测的分支等于没写。
export function commitWithRuntimeIdentity(root, message) {
  try {
    return gitStrict(root, ["commit", "-m", message]);
  } catch (error) {
    const text = String(error?.stderr || error?.message || "");
    if (!/user\.email|user\.name|empty ident|Author identity unknown/iu.test(text)) throw error;
    return gitStrict(root, ["-c", "user.email=agent-runtime@local", "-c", "user.name=AI Agent Runtime",
      "commit", "-m", message]);
  }
}

export function gitIsAncestor(root, ancestor, descendant) {
  try {
    execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", ancestor, descendant], {stdio: ["ignore", "pipe", "pipe"]});
    return true;
  } catch {
    return false;
  }
}

export function gitRemoteSha(root, remote, ref) {
  const output = git(root, ["ls-remote", remote, ref], "");
  const line = output.split("\n").find(Boolean);
  return line?.split(/\s+/u)[0] || "";
}

// 必须用 -z。`git status --porcelain`（不带 -z）会把【带空格或非 ASCII 的路径】加引号并做八进制
// 转义（core.quotePath 默认开着）：`docs/a b.md` 变成 `"docs/a b.md"`，`docs/设计说明.md` 变成
// `"docs/\350\256\276..."`。而这里解析出来的路径要跟执行方申报的路径逐条比对，对不上就判成
// 「未申报的改动」把提交拒掉 —— 也就是说，仓库里只要有一个中文文件名，提交路径就走不通，
// 而报文里是一串八进制。这是个中文产品。agent 运行时那份孪生实现一直用的是 -z。
// -z 的记录形态：`XY <path>` NUL 结尾；重命名/复制（X 或 Y 是 R/C）后面【另起一个字段】放源路径，
// 不带 `XY ` 前缀，也不会出现 ` -> `。所以要逐字段走，不能对源路径再 slice(3)。
export function gitStatusPaths(root = process.cwd()) {
  const fields = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "").split("\0");
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (!entry) continue;
    paths.push(entry.slice(3));
    if (/[RC]/u.test(entry.slice(0, 2))) {
      const source = fields[index + 1];
      if (source) paths.push(source);
      index += 1;
    }
  }
  return [...new Set(paths)].filter(Boolean);
}

export function gitPathExists(root, commit, path) {
  return git(root, ["cat-file", "-e", `${commit}:${path}`], "__missing__") !== "__missing__";
}

export function normalizeGitRemoteUrl(url = "") {
  return String(url).trim().replace(/\.git$/u, "");
}
