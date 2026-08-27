import { execFileSync as rawExecFileSync, spawn as rawSpawn, spawnSync as rawSpawnSync } from "node:child_process";
import {waitForChildExit, waitForChildExitCode} from "./lib/child-tracking.mjs";
// 【子进程计时】AIMAC_PROC_TIMING=1 打印最贵的几个子进程。
// 这条 e2e 是提交回路里最慢的一段（实测 145 秒），而它的成本几乎全在等子进程：
// 32 个子进程合计 81 秒，其中控制面服务的整段生命周期 41 秒、两次 agent 真跑批各 16 秒。
// HTTP 只有 0.6 秒（64 次请求）—— 量之前我以为是轮询慢，方向完全错了。
// 那两次跑批共用同一个 agentWorkDir、顺序相关（轮换→控制→跑→重放），不能并行；
// 也就是说这 145 秒是"真的把一个 agent 跑起来"的代价，不是浪费。留着这个开关，
// 免得下一个人重新搭一遍计时（我为此走了三条死路：console.log 打点、行距打点、包全局 fetch）。
const __proc = [];
const __lbl = (cmd, args) => `${String(cmd).split("/").pop()} ${(args || []).slice(0, 2).map((a) => String(a).split("/").pop()).join(" ")}`.slice(0, 50);
const spawnSync = (...a) => { const t = Date.now(); try { return rawSpawnSync(...a); } finally { __proc.push([`spawnSync ${__lbl(a[0], a[1])}`, Date.now() - t]); } };
const execFileSync = (...a) => { const t = Date.now(); try { return rawExecFileSync(...a); } finally { __proc.push([`execFileSync ${__lbl(a[0], a[1])}`, Date.now() - t]); } };
const spawn = (...a) => { const t = Date.now(); const c = rawSpawn(...a); c.on("exit", () => __proc.push([`spawn ${__lbl(a[0], a[1])}`, Date.now() - t])); return c; };
process.on("exit", () => {
  if (!process.env.AIMAC_PROC_TIMING) return;
  // 两类进程不能加在一起报总数：长期存活的（服务端、agent 运行时）那个毫秒数是【它活了多久】，
  // 也就是整场测试的时长，不是它花掉的成本；短命的才是"这一步等了多久"。
  // 加在一起会得出"81 秒都在起子进程"这种结论，而那会把人引去优化进程启动 —— 完全找错方向。
  // （这份汇总自己就骗过一次：一份记录据此写下"32 个子进程 81s"，其中 56s 是两个长期进程的存活时长。）
  const longLived = __proc.filter(([label]) => label.startsWith("spawn "));
  const shortLived = __proc.filter(([label]) => !label.startsWith("spawn "));
  const sum = (rows) => rows.reduce((acc, item) => acc + item[1], 0);
  console.error(`\n[proc] 短命子进程 ${shortLived.length} 个，合计 ${sum(shortLived)} ms —— 这才是等待成本；`
    + `另有长期存活进程 ${longLived.length} 个（存活 ${sum(longLived)} ms＝测试时长，不是开销）`);
  console.error("  最贵的短命进程：");
  for (const [k, ms] of [...shortLived].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.error(`  ${String(ms).padStart(6)} ms  ${k}`);
  for (const [k, ms] of longLived) console.error(`  ${String(ms).padStart(6)} ms  ${k}（长期存活）`);
});
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readStoredState } from "../apps/control-plane-ui/lib/state-store.mjs";
import { UNCOVERED_CEILINGS, sweepRecordsAgainstDeclaredSchemas } from "./lib/schema-validate.mjs";
import { assertNoUndefinedInPayload } from "./lib/no-undefined-payload.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const sandbox = mkdtempSync(join(tmpdir(), "aimac-agent-doctor-"));
const runtimeDir = join(sandbox, "server-runtime");
const agentWorkDir = join(sandbox, "agent-work");
const verifiedCommandWorkDir = join(sandbox, "verified-command-agent-work");
const remote = join(sandbox, "remote.git");
const source = join(sandbox, "source");
const executor = join(sandbox, "doctor-agent-executor.mjs");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

setupRepository();
writeFileSync(executor, `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const input = JSON.parse(readFileSync(0, "utf8"));
// 「跑完一个字都没改」这条路此前零覆盖：真实里它意味着模型空转（额度烧了、活没动），
// 而 agent 必须把它判成失败并如实报回控制面，而不是当成做完了去提交一个空 commit。
// 按工作项 id 里的标记切换：这一支【什么都不写】，只打一句摘要。
// 第三种情形（推送校验）要走【正常产出】那条路，所以这两个"其实没做"的探针要让开。
if (String(input.workId || "").includes("nochange")
  && !existsSync(${JSON.stringify(join(sandbox, "rewind-after-push.flag"))})) {
  // 两种"看着做了、其实没做"共用这一个工作项，按标记文件切换：
  // 编排是否会为一件【新活】排派发，取决于任务组当时的状态（上一条探针失败之后就不排了，
  // 实测第二个工作项根本没进编排回执）。让同一件活跑第二次，才是稳的造法。
  const onlyManifest = existsSync(${JSON.stringify(join(sandbox, "only-manifest.flag"))});
  if (onlyManifest) {
    const manifestPath = input.repositoryOutputTarget?.artifactManifestPath;
    if (manifestPath) {
      mkdirSync(join(input.repositoryRoot, dirname(manifestPath)), {recursive: true});
      writeFileSync(join(input.repositoryRoot, manifestPath), "{}");
    }
    console.log(JSON.stringify({summary: "探针：只写了产物清单", verificationRefs: []}));
  } else {
    console.log(JSON.stringify({summary: "探针：这一轮故意什么都不改", verificationRefs: []}));
  }
  process.exit(0);
}
const outputPath = \`docs/agent-runtime-output/\${input.taskGroupId}/\${input.workId}.md\`;
mkdirSync(join(input.repositoryRoot, dirname(outputPath)), {recursive: true});
writeFileSync(join(input.repositoryRoot, outputPath), [
  \`# \${input.workId}\`,
  "",
  \`Role skill: \${input.roleSkill.roleSkillRef}\`,
  \`Skill workset: \${input.skillWorksetDir}\`,
  \`Remote MCP: \${input.remoteMcp.url}\`,
  ""
].join("\\n"));
console.log(JSON.stringify({summary: "Remote Agent Runtime executed the assigned model task with a server-issued skill workset.", verificationRefs: ["doctor:executor-ok"]}));
`);

// 保留会话目录：下面要读回真实执行时写下的那份提示，确认人写的规则与人拍板的决策
// 确实到达了模型。派发结束后目录会被清理，不打开这个开关就无从验证。
process.env.AIMAC_AGENT_KEEP_SESSION_DIRS = "true";

const server = spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    AIMAC_HOST: "127.0.0.1",
    // 我要是被 SIGKILL 掉（或终端被关），finally 跑不了 —— 这个服务端就成了占着端口的孤儿。
    AIMAC_EXIT_WITH_PARENT: "1",
    // 关掉后台自治周期：端到端断言的是一段确定的状态序列，后台推进会把它打乱。
    AIMAC_ORCHESTRATOR_INTERVAL_MS: "0",
    AIMAC_PORT: String(port),
    AIMAC_PUBLIC_URL: baseUrl,
    AIMAC_RUNTIME_DIR: runtimeDir,
    AIMAC_REPOSITORY_ROOT: source,
    AIMAC_EXECUTION_PROFILE: "production",
    AIMAC_STATE_STORE: "runtime_json",
    AIMAC_BOOTSTRAP_TOKEN: "doctor-bootstrap-token",
    AIMAC_MCP_SERVICE_TOKEN: "doctor-mcp-service-token",
    DATABASE_URL: ""
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let stderr = "";
server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

try {
  await waitForHealth();
  const installer = await fetch(`${baseUrl}/install-agent.sh`);
  const installerChecksum = await fetch(`${baseUrl}/install-agent.sh.sha256`);
  const runtimeArtifact = await fetch(`${baseUrl}/agent-runtime.mjs`);
  if (!installer.ok || !installerChecksum.ok || !runtimeArtifact.ok) throw new Error("server did not publish Agent bootstrap artifacts");
  const installerText = await installer.text();
  if (!installerText.includes(baseUrl) || installerText.includes("__AIMAC_SERVER_URL__")) throw new Error("Agent installer was not bound to the public server URL");

  const login = await json("/api/auth/login", {method: "POST", body: {email: "system.admin@local", token: "doctor-bootstrap-token"}});

  // 运维接入一台机器走的是 agentctl，不是直接调 API。这三个子命令此前只有 doctor 被覆盖
  // （在 docker 那道门里），join-token create 与 nodes list 一个门都没有 ——
  // 而它们正是"把机器接进来"和"看看接进来没有"这两件事。CLI 坏了，界面上只会显示
  // "没有任何在线 agent"，而人照着 README 敲命令却接不进来，两头都不知道问题在哪。
  {
    const cliEnv = {...process.env, AIMAC_PUBLIC_URL: baseUrl, AIMAC_BOOTSTRAP_TOKEN: "doctor-bootstrap-token",
      AIMAC_SYSTEM_ADMIN_EMAIL: "system.admin@local"};
    const runCli = (argv) => spawnSync(process.execPath, [join(root, "scripts/agentctl.mjs"), ...argv, `--server=${baseUrl}`],
      {cwd: root, env: cliEnv, encoding: "utf8"});
    // 失败路径此前一条覆盖都没有 —— 而运维敲错命令、连错地址、忘了给令牌，这三件事比成功路径常见。
    // 原先每一条都是一段 Node 崩溃栈（at Object.<anonymous>…），人看不出自己错在哪。
    const badCommand = runCli(["nodes", "lst"]);
    if (badCommand.status !== 1 || /\bat \w+\.<anonymous>|at Object\./u.test(String(badCommand.stderr))) {
      throw new Error(`agentctl 子命令打错时应给人话（退出码 ${badCommand.status}）：`
        + String(badCommand.stderr || badCommand.stdout).slice(0, 200));
    }
    if (!String(badCommand.stderr).includes("join-token create")) {
      throw new Error("agentctl 认不出子命令时没有列出可用的子命令 —— 人只能去翻文档");
    }
    const badServer = spawnSync(process.execPath, [join(root, "scripts/agentctl.mjs"), "doctor", "--server=http://127.0.0.1:9"],
      {cwd: root, env: cliEnv, encoding: "utf8"});
    if (badServer.status !== 1 || !String(badServer.stderr).includes("连不上控制面")) {
      throw new Error(`agentctl 连不上控制面时没给人话（退出码 ${badServer.status}）：`
        + String(badServer.stderr || badServer.stdout).slice(0, 200));
    }
    if (!/npm start|--server/u.test(String(badServer.stderr))) {
      throw new Error("agentctl 连不上时没有告诉人下一步该做什么");
    }

    const listed = runCli(["nodes", "list"]);
    if (listed.status !== 0 || !String(listed.stdout).includes("agentRuntimeNodes")) {
      throw new Error(`agentctl nodes list 不可用（退出码 ${listed.status}）：${String(listed.stdout || listed.stderr).slice(0, 200)}`);
    }
    // 参数名打错必须当场拒绝，不能"当成没给"照跑。--verified 是最实的一条：
    // 它决定给出的是【下载 .sha256 校验安装脚本再执行】还是【curl | sh】，
    // 打错一个字母就静默降级成后者，而屏幕上没有任何相反的迹象。
    // （这道门自己就中过：下面那条 join-token create 原先写的是 --name=，
    //   而 agentctl 认的是 --node-name —— 它想钉住节点名，静默地什么也没钉。）
    const badFlag = runCli(["join-token", "create", "--project=prj_control_plane", "--verifed"]);
    if (badFlag.status !== 1 || !String(badFlag.stderr).includes("--verifed")) {
      throw new Error(`agentctl 参数名打错时应当场拒绝并点名（退出码 ${badFlag.status}）：`
        + String(badFlag.stderr || badFlag.stdout).slice(0, 200));
    }
    if (!String(badFlag.stderr).includes("--verified")) {
      throw new Error("agentctl 拒绝打错的参数时没有列出认得的参数 —— 人看不出自己少打了哪个字母");
    }
    // 参数【名】打错会被拒，参数【值】写错原先一声不吭，而默认值全都偏向"少做一点"：
    // --max-uses=abc 变 NaN、=0 静默变成 1、--roles= 静默退回默认。人以为自己要了某件事，
    // 屏幕上没有任何相反的迹象。而且这几条要在【联网之前】拒 —— 否则人先看到"连不上控制面"，
    // 会以为是网络问题，而真正的问题是他手上那条命令。
    for (const [why, argv, expect] of [
      ["--max-uses 不是数字", ["--max-uses=abc"], "--max-uses"],
      ["--max-uses 写成 0", ["--max-uses=0"], "--max-uses"],
      ["--roles 给了空值", ["--roles="], "--roles"]
    ]) {
      const badValue = spawnSync(process.execPath,
        [join(root, "scripts/agentctl.mjs"), "join-token", "create", "--project=prj_control_plane",
          ...argv, "--server=http://127.0.0.1:9"],
        {encoding: "utf8", env: {...process.env, AIMAC_BOOTSTRAP_TOKEN: "x"}});
      const said = String(badValue.stderr || badValue.stdout);
      // 先核"有没有跑去联网"：值写错却先撞一句「连不上控制面」，是这两条里更误导人的那种，
      // 也要让它成为这一情形下最先报出来的那句（否则下面那条会抢先，变异就对不上号了）。
      if (/连不上控制面/u.test(said)) {
        throw new Error(`agentctl ${why}时先去联网了 —— 人会以为是网络问题，而错的是他手上那条命令`);
      }
      if (badValue.status !== 1 || !said.includes(expect)) {
        throw new Error(`agentctl ${why}时应当场拒绝并点名（退出码 ${badValue.status}）：${said.slice(0, 200)}`);
      }
    }
    const verified = runCli(["join-token", "create", "--project=prj_control_plane", "--verified"]);
    if (verified.status !== 0 || !/sha256/u.test(String(verified.stdout))) {
      throw new Error("agentctl --verified 没有给出带校验的安装命令 —— 这个参数等于不存在："
        + String(verified.stdout || verified.stderr).slice(0, 200));
    }

    const issued = runCli(["join-token", "create", "--project=prj_control_plane", "--node-name=cli-probe-node"]);
    if (issued.status !== 0) {
      throw new Error(`agentctl join-token create 不可用（退出码 ${issued.status}）：${String(issued.stderr || issued.stdout).slice(0, 200)}`);
    }
    // 输出必须是能直接粘到目标机器上跑的那条命令，而且令牌【不能出现在命令行参数里】
    // （命令行在 ps 里对同机所有用户可见 —— 这正是 --join-token-file 存在的原因）。
    const command = String(issued.stdout);
    if (!command.includes("install-agent.sh") || !command.includes("--join-token-file")) {
      throw new Error(`agentctl 给出的接入命令不对：${command.slice(0, 200)}`);
    }
    // 上面给了 --node-name，接入命令里就必须带着它。不断言的话，这个参数写错了照样一片绿
    // —— 这道门原先正是这么放过 --name= 的。
    if (!command.includes("--node-name") || !command.includes("cli-probe-node")) {
      throw new Error(`agentctl 没有把 --node-name 传进接入命令：${command.slice(0, 200)}`);
    }
    if (/--join-token[ =][^-]/u.test(command)) {
      throw new Error("agentctl 把接入令牌放进了命令行参数 —— 同机任何用户 ps 一下就能拿走");
    }
  }
  const joinResult = await json("/api/agent-join-tokens", {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-join-token",
    body: {projectId: "prj_control_plane", nodeName: "doctor-node", allowedRoles: ["*"], ttlSeconds: 1800, maxUses: 1}
  });
  if (!joinResult.installCommand.includes(`${baseUrl}/install-agent.sh`)) throw new Error("join token did not produce a server-hosted install command");
  if (joinResult.installCommand.includes("--join-token ") || !joinResult.installCommand.includes("--join-token-file")) throw new Error("join token install command exposed token in argv");
  if (!joinResult.verifiedInstallCommand.includes("( if command -v sha256sum") || !joinResult.verifiedInstallCommand.includes("elif command -v shasum")) throw new Error("join token did not produce a portable checksum-verified install command");

  // 装 agent 的人是在自己的机器上跑一条命令：失败时不能只丢一段 Node 崩溃栈。
  // 实测入网票写错时，原先看到的就是 "status: 401" 加一串 at ... 的堆栈。
  {
    const badTokenScript = join(sandbox, "install-agent-badtoken.sh");
    writeFileSync(badTokenScript, await (await fetch(`${baseUrl}/install-agent.sh`)).text(), {mode: 0o755});
    const badTokenInstall = spawnSync("sh", [badTokenScript, "--server", baseUrl,
      "--join-token", "aimac_join_totally_bogus_token", "--work-dir", join(sandbox, "bad-token-agent")],
      {encoding: "utf8", env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true"}, timeout: 120000});
    const said = `${badTokenInstall.stdout || ""}${badTokenInstall.stderr || ""}`;
    if (badTokenInstall.status === 0) {
      throw new Error("用一张无效入网票也装成功了 —— 失败必须以非零退出码收场");
    }
    if (!/入网票不对|入网票已过期|入网票已经被用过/u.test(said)) {
      throw new Error(`入网票无效时没有给出人话（实得：${said.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 160)}）—— 装 agent 的人只看到一段崩溃栈`);
    }
    if (/ {4}at .*runtime\.mjs:/u.test(said)) {
      throw new Error("入网失败时把 Node 崩溃栈直接吐给了装机的人（堆栈应当留给 AIMAC_AGENT_DEBUG=1）");
    }

    // 装机脚本自己的失败路径。人是在一台新机器上 curl | sh，手上没有任何别的上下文：
    // 参数被截断（复制安装命令时最常见）原先是 "line 20: $2: unbound variable"，
    // 下载不到产物原先只有 curl 那句英文、不说脚本当时在做什么。
    for (const [why, argv, expected] of [
      ["参数被截断", ["--server"], "后面少了取值"],
      ["参数名打错", ["--serverr", baseUrl], "认不出这个参数"],
      ["下载不到产物", ["--server", "https://127.0.0.1:9", "--join-token", "x",
        "--work-dir", join(sandbox, "unreachable-agent")], "下载不到"]
    ]) {
      const broken = spawnSync("sh", [badTokenScript, ...argv],
        {encoding: "utf8", env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true"}, timeout: 120000});
      const output = `${broken.stdout || ""}${broken.stderr || ""}`;
      if (broken.status === 0) throw new Error(`install-agent.sh ${why}时居然退出 0`);
      if (/unbound variable|line \d+:/u.test(output)) {
        throw new Error(`install-agent.sh ${why}时吐的是 shell 报错而不是人话：${output.slice(0, 160)}`);
      }
      if (!output.includes(expected)) {
        throw new Error(`install-agent.sh ${why}时没说清是什么问题，期望提到「${expected}」：${output.slice(0, 160)}`);
      }
      if (!output.includes("·")) {
        throw new Error(`install-agent.sh ${why}时只报了结论、没给下一步 —— 装机的人不知道该改什么`);
      }
    }
  }

  // 角色越界被拒时，只回一个码等于让接入方去猜：它要了什么、这张票允许什么、被挡的是哪几个，
  // 都是它自己改请求所必需的。这条同时保证那份 details 真的能穿过 HTTP 出来（服务端要展开 error.details）。
  const scopedJoin = await json("/api/agent-join-tokens", {
    method: "POST", token: login.sessionToken, idempotencyKey: "doctor-agent-scoped-token",
    body: {projectId: "prj_control_plane", nodeName: "scoped-node", allowedRoles: ["reviewer"], ttlSeconds: 1800, maxUses: 1}
  });
  const overreach = await jsonRaw("/api/agent/v1/register", {
    method: "POST", token: scopedJoin.joinToken,
    body: {nodeName: "scoped-node", requestedRoles: ["implementer"], runtimeVersion: "doctor",
      profile: {tools: [], models: [{providerClass: "custom", adapter: "doctor", available: true}]}}
  });
  if (overreach.response.status !== 403 || overreach.payload.error !== "join_token_role_scope_mismatch") {
    throw new Error(`角色越界注册没有被拒（应 403 join_token_role_scope_mismatch，得到 ${overreach.response.status}:${overreach.payload.error}）`);
  }
  if (!(overreach.payload.allowedRoles || []).includes("reviewer") || !(overreach.payload.rejected || []).includes("implementer")) {
    throw new Error(`角色越界的报文没说清差在哪（allowedRoles=${JSON.stringify(overreach.payload.allowedRoles)} rejected=${JSON.stringify(overreach.payload.rejected)}）—— 接入方只能靠猜`);
  }

  const noExecutorJoin = await json("/api/agent-join-tokens", {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-no-executor-token",
    body: {projectId: "prj_control_plane", nodeName: "no-executor-node", allowedRoles: ["*"], ttlSeconds: 1800, maxUses: 1}
  });
  const noExecutorRegistration = await json("/api/agent/v1/register", {
    method: "POST",
    token: noExecutorJoin.joinToken,
    body: {nodeName: "no-executor-node", requestedRoles: ["*"], runtimeVersion: "doctor", profile: {tools: [], models: [{providerClass: "custom", adapter: "unconfigured", available: false}]}}
  });
  const noExecutorSelfCheck = await jsonRaw("/api/agent/v1/self-check", {
    method: "POST",
    token: noExecutorRegistration.nodeToken,
    body: {checks: okSelfChecks(baseUrl, {modelExecutor: false}), runtimeVersion: "doctor"}
  });
  if (noExecutorSelfCheck.response.status !== 409 || noExecutorSelfCheck.payload.admission !== "read_only" || !noExecutorSelfCheck.payload.missingChecks?.includes("model_executor")) {
    throw new Error(`agent without model executor was not rejected from full admission: ${noExecutorSelfCheck.response.status}`);
  }
  const noExecutorClaim = await json("/api/agent/v1/dispatches/next", {method: "POST", token: noExecutorRegistration.nodeToken, body: {claimTtlSeconds: 900}});
  if (noExecutorClaim.dispatch || noExecutorClaim.reason !== "node_not_admitted") throw new Error("agent without model executor was allowed to claim dispatch");

  const verifiedJoinResult = await json("/api/agent-join-tokens", {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-verified-install-token",
    body: {projectId: "prj_control_plane", nodeName: "verified-command-node", allowedRoles: ["*"], ttlSeconds: 1800, maxUses: 1}
  });
  const verifiedInstall = spawnSync("sh", ["-c", verifiedJoinResult.verifiedInstallCommand], {
    cwd: sandbox,
    env: {
      ...process.env,
      AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true",
      AIMAC_AGENT_CONFIGURE_CLIENTS: "false",
      AIMAC_AGENT_NODE_NAME: "verified-command-node",
      AIMAC_AGENT_WORK_DIR: verifiedCommandWorkDir,
      AIMAC_AGENT_EXECUTOR_COMMAND: `node ${JSON.stringify(executor)}`
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  stopAgentDaemon(verifiedCommandWorkDir);
  if (verifiedInstall.status !== 0 || !verifiedInstall.stdout.includes("AGENT_JOINED") || !verifiedInstall.stdout.includes("AGENT_RUNTIME_STARTED")) {
    throw new Error(`checksum-verified Agent install command failed: ${verifiedInstall.stderr || verifiedInstall.stdout}`);
  }
  assertAgentScopedMcpConfig(verifiedCommandWorkDir, baseUrl);

  const joinTokenFile = join(sandbox, "doctor.join");
  writeFileSync(joinTokenFile, joinResult.joinToken, {mode: 0o600});
  const install = spawnSync("sh", ["-s", "--", "--server", baseUrl, "--join-token-file", joinTokenFile, "--node-name", "doctor-node", "--work-dir", agentWorkDir, "--no-daemon", "--no-configure-clients", "--executor-command", `node ${JSON.stringify(executor)}`], {
    cwd: sandbox,
    input: installerText,
    env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false"},
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (install.status !== 0 || !install.stdout.includes("AGENT_JOINED") || !install.stdout.includes(`remoteMcp=${baseUrl}/mcp`)) throw new Error(`Agent one-command bootstrap failed: ${install.stderr || install.stdout}`);
  assertAgentScopedMcpConfig(agentWorkDir, baseUrl);

  const agentConfigPath = join(agentWorkDir, "agent-config.json");
  const agentConfig = JSON.parse(readFileSync(agentConfigPath, "utf8"));
  const runtimePath = join(agentWorkDir, "bin", "aimac-agent-runtime.mjs");
  if (!existsSync(runtimePath)) throw new Error("Agent Runtime artifact was not installed");

  // Gap 5 §3.2: the self-check profile ingested by the gateway must carry the permission and integrity probe blocks.
  const probedNode = await json("/api/agent/v1/nodes/me", {token: agentConfig.nodeToken});
  assertProbeProfileBlocks(probedNode.node.profile);
  forceNodeCredentialNearExpiry(agentConfig.nodeId);
  const rotationRun = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
    env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false"},
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (rotationRun.status !== 0) throw new Error(`Agent Runtime credential rotation run failed: ${rotationRun.stderr || rotationRun.stdout}`);
  const rotatedAgentConfig = JSON.parse(readFileSync(agentConfigPath, "utf8"));
  if (rotatedAgentConfig.nodeToken === agentConfig.nodeToken) throw new Error("Agent Runtime did not persist a rotated node credential");
  // 「不带令牌」和「带一个形状对但内容错的令牌」是两条路：前者在最外层就被挡下，
  // 后者要一路走到凭据摘要比对那一句。此前只有前者被测过 —— 实测把 nodeAcceptsToken 里
  // 那句 `node.credentialDigest === presentedDigest` 去掉（任何 aimac_node_ 开头的串都能
  // 冒充某个节点），三套 e2e 无一报红。
  const forgedNodeToken = await jsonRaw("/api/agent/v1/nodes/me", {token: "aimac_node_forged_but_well_formed"});
  if (forgedNodeToken.response.status !== 401) {
    throw new Error(`形状对、内容错的节点令牌被放行了（HTTP ${forgedNodeToken.response.status}）—— `
      + "凭据比对失效时，任何人拼一个 aimac_node_ 开头的串就能冒充节点");
  }
  // 生产 profile 下服务端不得自己把 agent 跑了 —— 那会一次性绕开认领、留痕和节点凭据。
  // 不带任何凭据打：必须是 409 profile 拒绝，【不是】401。拿到 401 就说明这道拒绝被挪到了鉴权/落写之后。
  const serverSideRun = await jsonRaw("/api/verification/agent-runtime/run", {method: "POST", body: {maxJobs: 1}});
  if (serverSideRun.response.status !== 409 || serverSideRun.payload?.error !== "server_side_agent_execution_forbidden") {
    throw new Error(`生产 profile 下 /api/verification/agent-runtime/run 没有按 profile 拒绝`
      + `（HTTP ${serverSideRun.response.status} ${serverSideRun.payload?.error}）—— `
      + "拿到 401 说明拒绝被挪到了鉴权之后；拿到 2xx 说明服务端可以直接代跑 agent，派发不经认领、不留痕");
  }
  const previousCredentialProbe = await jsonRaw("/api/agent/v1/nodes/me", {token: agentConfig.nodeToken});
  const currentCredentialProbe = await jsonRaw("/api/agent/v1/nodes/me", {token: rotatedAgentConfig.nodeToken});
  if (!previousCredentialProbe.response.ok || !currentCredentialProbe.response.ok) throw new Error("Agent Gateway did not accept both previous and current credentials during rotation overlap");
  const previousHeartbeat = await jsonRaw("/api/agent/v1/heartbeat", {method: "POST", token: agentConfig.nodeToken, body: {profile: {tools: [], models: [{providerClass: "custom", adapter: "doctor", available: true}]}}});
  const currentAfterPreviousHeartbeat = await jsonRaw("/api/agent/v1/nodes/me", {token: rotatedAgentConfig.nodeToken});
  if (!previousHeartbeat.response.ok || !currentAfterPreviousHeartbeat.response.ok) throw new Error("Agent heartbeat with previous credential invalidated the current credential");
  // 同一类的另外两处：节点名是人在表单里填的（还会被嵌进给人复制的安装命令），超长要【拒】；
  // 运行时版本是机器自报的，超长【截断】即可。两种处置对应两种来源，别用同一种。
  {
    const huge = "长".repeat(5000);
    // 幂等键要带上，否则请求在 428 就被挡住、根本走不到名字校验（第一版就是这样，
    // 报的是"5000 字的节点名被收下了（HTTP 428）"—— 拒了，但拒错了地方）。
    const longName = await jsonRaw("/api/agent-join-tokens", {method: "POST", token: login.sessionToken,
      idempotencyKey: "doctor-agent-long-node-name",
      body: {projectId: "prj_control_plane", nodeName: huge, allowedRoles: ["agent-runtime"],
        ttlSeconds: 1800, maxUses: 1}});
    if (longName.response.status !== 400 || longName.payload.error !== "agent_node_name_too_long") {
      throw new Error(`5000 字的节点名被收下了（HTTP ${longName.response.status}）——`
        + "它会被嵌进给人复制的安装命令里，而且常驻状态");
    }
    const longVersion = await jsonRaw("/api/agent/v1/heartbeat", {method: "POST", token: rotatedAgentConfig.nodeToken,
      body: {runtimeVersion: huge, profile: {tools: [], models: []}}});
    if (!longVersion.response.ok) {
      throw new Error(`超长 runtimeVersion 把心跳整条拒了（HTTP ${longVersion.response.status}）—— 机器自报的字段该截断，不该拒`);
    }
  }

  // 节点自报的 profile 会常驻中央状态，而每次写入的成本正比于状态大小。
  // 条数早就截到 100 了，条目【里面】的字符串原先一个都没截 —— 同一个函数里 region/dataRoot
  // 都截了，数组里的没截。100 个工具 × 20KB 名字 = 2MB 的 profile 挂在一个节点上。
  {
    const huge = "长".repeat(20000);
    const fatProfile = await jsonRaw("/api/agent/v1/heartbeat", {method: "POST", token: rotatedAgentConfig.nodeToken,
      body: {profile: {tools: [{name: huge, version: huge, available: true}],
        models: [{providerClass: huge, adapter: huge, available: true}], capabilityFlags: [huge]}}});
    if (!fatProfile.response.ok) throw new Error(`超长 profile 的心跳被整条拒了（HTTP ${fatProfile.response.status}）—— 上报不该因此失败`);
    const stored = await jsonRaw("/api/agent/v1/nodes/me", {token: rotatedAgentConfig.nodeToken});
    const profile = stored.payload?.node?.profile || stored.payload?.profile || {};
    const longest = Math.max(
      ...(profile.tools || []).flatMap((tool) => [String(tool.name || "").length, String(tool.version || "").length]),
      ...(profile.models || []).flatMap((model) => [String(model.providerClass || "").length, String(model.adapter || "").length]),
      ...(profile.capabilityFlags || []).map((flag) => String(flag).length), 0);
    if (longest > 200) {
      throw new Error(`节点自报的 profile 里存下了 ${longest} 字的字符串 —— 它常驻中央状态，`
        + "每次写入都替它买单；条数截了、条目里的字符串没截");
    }
    if (!(profile.tools || []).length || !(profile.models || []).length) {
      throw new Error("超长 profile 被整条丢掉了 —— 应该截断而不是丢弃（那会让节点看起来没有任何工具）");
    }
  }

  assertAgentScopedMcpConfig(agentWorkDir, baseUrl, rotatedAgentConfig.nodeToken);

  // 到期时间解析不了要当场拒。控制命令的 expiresAt 一旦落成 NaN，判它过没过期的比较
  // 两个方向都是 false —— 要么永不过期、一直挂在队列里，要么被当成早已过期而从不投递。
  {
    let refused = null;
    try {
      await json(`/api/agent-nodes/${agentConfig.nodeId}/control`, {
        method: "POST", token: login.sessionToken, idempotencyKey: "doctor-agent-control-bad-expiry",
        body: {commandType: "refresh_profile", expiresAt: "不是日期"}
      });
    } catch (error) { refused = String(error?.message || error); }
    if (!refused || !refused.includes("control_command_expires_at_invalid")) {
      throw new Error(`控制命令的到期时间解析不了必须当场拒：实际 ${refused || "居然成功了"}`);
    }
  }

  await json(`/api/agent-nodes/${agentConfig.nodeId}/control`, {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-control-refresh",
    body: {commandType: "refresh_profile"}
  });
  const controlRun = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
    env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false"},
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (controlRun.status !== 0) throw new Error(`Agent Runtime control-channel run failed: ${controlRun.stderr || controlRun.stdout}`);
  const controlState = await json("/api/state?view=runtime&limit=200", {token: login.sessionToken});
  const controlCommand = (controlState.agentControlCommands || []).find((command) => command.idempotencyKey === "doctor-agent-control-refresh");
  if (!controlCommand || controlCommand.status !== "completed" || !controlCommand.resultDigest) throw new Error("Agent control command was not delivered and ACKed");
  if (!controlCommand.deliveredAt || !controlCommand.acknowledgedAt) throw new Error("Agent control command did not persist delivered and ACK timestamps");

  const reuse = await jsonRaw("/api/agent/v1/register", {method: "POST", token: joinResult.joinToken, body: {nodeName: "doctor-node", profile: {}}});
  // 只判 409 不够：幂等键撞了也是 409。要的是"这张一次性令牌已经用掉了"这一条，
  // 否则换成别的守卫先拒，这条断言照样绿而一次性语义已经没了。
  // 2026-08-21：码从 join_token_not_active（"不处于可用状态"）改成照实说的 join_token_consumed
  // ——四种状态原先一律回那句最模糊的，而系统明明知道是用过了还是过期了还是被吊销了。
  if (reuse.response.status !== 409 || reuse.payload?.error !== "join_token_consumed") {
    throw new Error(`一次性加入令牌被复用（HTTP ${reuse.response.status}/${reuse.payload?.error}，`
      + "应为 409/join_token_consumed）—— 一张令牌能拉起多个节点");
  }
  if (reuse.payload?.tokenStatus !== "consumed") {
    throw new Error(`拒绝报文里没有说清令牌现在是什么状态（tokenStatus=${reuse.payload?.tokenStatus}）—— `
      + "人拿着一张不work的令牌，得知道是用过了、过期了还是被吊销了");
  }

  const orchestrated = await json("/api/orchestrator/run", {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-orchestrate",
    body: {mode: "single", taskGroupId: "tg_runtime_management", autoSyncSkills: false}
  });
  if (!orchestrated.changed.some((item) => item.dispatchId)) throw new Error("orchestrator did not enqueue a dispatch for the remote Agent Runtime");

  const run = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
    env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false", AIMAC_AGENT_VERIFICATION_DEFER_CHECKPOINT: "true"},
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (run.status !== 0 || !run.stdout.includes("checkpoint intentionally deferred")) {
    // 【报错路径自己不许崩】。这一段是为了把"远端上到底有什么"一并说出来，可它假设远端至少有两个提交：
    // agent 这一轮要是根本没推上去，远端就只有初始那一个，`HEAD^` 直接 fatal ——
    // 于是真正的失败原因（run.stderr）一个字都看不到，屏幕上只剩一句 git 的 unknown revision。
    // 本仓记过同一形状：记录错误的那行代码把现场毁掉。诊断信息一律尽力而为。
    const tryGit = (args) => {
      try { return execFileSync("git", ["--git-dir", remote, ...args], {encoding: "utf8"}).trim(); }
      catch (error) { return `（取不到：${String(error.message).split("\n")[0].slice(0, 80)}）`; }
    };
    const remoteHead = tryGit(["rev-parse", "refs/heads/main"]);
    const remoteDiff = tryGit(["show", "--name-only", "--pretty=format:", remoteHead]);
    const manifests = remoteDiff.split("\n").filter((path) => path.includes("artifact-manifests/"));
    const manifest = manifests[0] ? tryGit(["show", `${remoteHead}:${manifests[0]}`]) : "missing";
    throw new Error(`remote Agent dispatch execution failed: ${run.stderr || run.stdout}\nremoteDiff=${remoteDiff}\nmanifest=${manifest}`);
  }

  const replay = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
    env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false"},
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (replay.status !== 0 || !replay.stdout.includes("checkpoint replayed")) throw new Error(`Agent checkpoint outbox replay failed: ${replay.stderr || replay.stdout}`);

  // outbox 里一条【内容损坏】的条目承载的是提交已经推送成功的检查点。原先只往本机 stderr 写一行，
  // 控制面永远不知道那份证据没了：派发挂在 running 上直到认领过期，人看到的是"还在跑"，
  // 而分支上已经有了没人复核过的提交。文件名就是 safeName(dispatchId).json —— 内容坏了不代表
  // 身份没了，必须据此上报，让它出现在人的待处理面前。
  const corruptOutboxDir = join(agentWorkDir, "outbox");
  const corruptDispatchId = "d_corrupt_probe";
  mkdirSync(corruptOutboxDir, {recursive: true});
  writeFileSync(join(corruptOutboxDir, `${corruptDispatchId}.json`), "{ 这不是合法 JSON");
  const corruptRun = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
    env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false"},
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  const corruptOutput = `${corruptRun.stdout || ""}${corruptRun.stderr || ""}`;
  if (!corruptOutput.includes("quarantined")) {
    throw new Error(`corrupt outbox item was not quarantined: ${corruptOutput.slice(-800)}`);
  }
  if (!corruptOutput.includes(`corruption reported: ${corruptDispatchId}`)
    && !corruptOutput.includes(`corruption report failed: ${corruptDispatchId}`)) {
    throw new Error(`corrupt outbox item was quarantined without telling the control plane (${corruptDispatchId}) — 证据没了而控制面上一切如常: ${corruptOutput.slice(-800)}`);
  }
  if (corruptRun.status !== 0) {
    throw new Error(`一条损坏的 outbox 条目让整个持久化循环退出失败（${corruptRun.status}）—— 它只应被隔离: ${corruptOutput.slice(-800)}`);
  }

  // 隔离本身也会失败（目录只读、盘满、同名占用）。那一刻文件仍在原地，下一拍还会再读到它，
  // 而报文若照旧说"已隔离到 <corruptPath>"，人按那个路径去找只会扑空：真正该看的原路径没人提过。
  const blockedOutboxDir = join(agentWorkDir, "outbox");
  const blockedDispatchId = "d_corrupt_stuck";
  const blockedItemPath = join(blockedOutboxDir, `${blockedDispatchId}.json`);
  mkdirSync(blockedOutboxDir, {recursive: true});
  writeFileSync(blockedItemPath, "{ 同样不是合法 JSON");
  chmodSync(blockedOutboxDir, 0o555);
  let quarantineReallyBlocked = true;
  try {
    // root 无视目录权限位：先自证这一拍里 rename 确实做不到，否则下面断的是一个没发生的故障。
    const probeTarget = `${blockedItemPath}.rename-probe`;
    renameSync(blockedItemPath, probeTarget);
    renameSync(probeTarget, blockedItemPath);
    quarantineReallyBlocked = false;
  } catch {}
  if (!quarantineReallyBlocked) {
    chmodSync(blockedOutboxDir, 0o755);
    rmSync(blockedItemPath, {force: true});
    console.log("  --  跳过【隔离失败时的报文】：当前身份能无视只读目录改名（多半是 root），这一条本轮没被检验");
  } else {
    const stuckRun = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
      env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false"},
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    });
    const stuckOutput = `${stuckRun.stdout || ""}${stuckRun.stderr || ""}`;
    chmodSync(blockedOutboxDir, 0o755);
    if (!existsSync(blockedItemPath)) {
      throw new Error(`只读目录下这条损坏条目竟然被移走了，本条没验到真实故障: ${stuckOutput.slice(-600)}`);
    }
    if (!stuckOutput.includes(`still at ${blockedItemPath}`)) {
      throw new Error(`隔离失败了，报文却没说文件还在哪 —— 人按 .corrupt-<时间戳> 去找只会扑空: ${stuckOutput.slice(-800)}`);
    }
    if (/quarantined: d_corrupt_stuck/u.test(stuckOutput)) {
      throw new Error(`文件明明还在原地，报文却宣称已隔离: ${stuckOutput.slice(-800)}`);
    }
    if (stuckRun.status !== 0) {
      throw new Error(`隔离失败让整个持久化循环退出失败（${stuckRun.status}）—— 它只应如实上报: ${stuckOutput.slice(-800)}`);
    }
    rmSync(blockedItemPath, {force: true});
  }

  // library 超过容量上限时会按 LRU 淘汰。淘汰【全都失败】（目录只读、文件被占用）时原先静默返回，
  // 下一拍原样再来一遍：盘一直涨，而系统明明算出来自己超了，一个字都没对人说过。
  const libraryDir = join(agentWorkDir, "library");
  const capMb = 64; // 运行时对上限取 Math.max(64, …)，比这更小的配置不会生效
  mkdirSync(join(libraryDir, "entry-a"), {recursive: true});
  mkdirSync(join(libraryDir, "entry-b"), {recursive: true});
  for (const name of ["entry-a", "entry-b"]) {
    const blob = join(libraryDir, name, "blob.bin");
    writeFileSync(blob, "");
    truncateSync(blob, Math.ceil((capMb * 1024 * 1024) / 1.5)); // 稀疏文件：statSync 报得出大小，不真占盘
  }
  chmodSync(libraryDir, 0o555);
  let evictionReallyBlocked = true;
  try {
    renameSync(join(libraryDir, "entry-a"), join(libraryDir, "entry-a-probe"));
    renameSync(join(libraryDir, "entry-a-probe"), join(libraryDir, "entry-a"));
    evictionReallyBlocked = false;
  } catch {}
  if (!evictionReallyBlocked) {
    chmodSync(libraryDir, 0o755);
    console.log("  --  跳过【淘汰全失败时必须出声】：当前身份能无视只读目录改名（多半是 root），这一条本轮没被检验");
  } else {
    const overCapRun = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
      env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false", AIMAC_AGENT_LIBRARY_MAX_MB: String(capMb)},
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    });
    const overCapOutput = `${overCapRun.stdout || ""}${overCapRun.stderr || ""}`;
    // 恢复权限位必须在任何断言【之前】：否则一条真红会让临时目录删不掉，rm 的 EACCES 反过来
    // 把真正的失败信息盖掉（本轮实撞一次）。
    chmodSync(libraryDir, 0o755);
    if (!existsSync(join(libraryDir, "entry-a"))) {
      throw new Error(`只读 library 目录下条目竟然被清掉了，本条没验到真实故障: ${overCapOutput.slice(-600)}`);
    }
    if (!overCapOutput.includes("library still over capacity after sweep")) {
      throw new Error(`盘已超上限、淘汰又全失败，运行时一个字都没说 —— 人只会看到盘莫名其妙满了: ${overCapOutput.slice(-800)}`);
    }
    if (!overCapOutput.includes(`> ${capMb}MB`)) {
      throw new Error(`超容报文没说清上限是多少，人无从判断该清盘还是该调高上限: ${overCapOutput.slice(-800)}`);
    }
  }
  rmSync(libraryDir, {recursive: true, force: true});

  // 孪生分支：陈旧会话目录的清理同样会失败，同样只有"若干天后盘满"这一个症状。
  const sessionsDir = join(agentWorkDir, "orgs", "org_probe", "projects", "prj_probe", "task-groups", "tg_probe", "sessions");
  const staleSessionDir = join(sessionsDir, "s_stale");
  mkdirSync(staleSessionDir, {recursive: true});
  const longAgo = new Date("2020-01-01T00:00:00Z");
  utimesSync(staleSessionDir, longAgo, longAgo);
  chmodSync(sessionsDir, 0o555);
  let sweepReallyBlocked = true;
  try {
    renameSync(staleSessionDir, `${staleSessionDir}-probe`);
    renameSync(`${staleSessionDir}-probe`, staleSessionDir);
    sweepReallyBlocked = false;
  } catch {}
  if (!sweepReallyBlocked) {
    chmodSync(sessionsDir, 0o755);
    console.log("  --  跳过【陈旧会话清不掉时必须出声】：当前身份能无视只读目录改名（多半是 root），这一条本轮没被检验");
  } else {
    const sweepRun = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
      env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false", AIMAC_AGENT_SESSION_TTL_HOURS: "1"},
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    });
    const sweepOutput = `${sweepRun.stdout || ""}${sweepRun.stderr || ""}`;
    chmodSync(sessionsDir, 0o755); // 恢复必须在断言之前，否则真红会被临时目录的 rm EACCES 盖掉
    if (!existsSync(staleSessionDir)) {
      throw new Error(`只读目录下陈旧会话竟然被清掉了，本条没验到真实故障: ${sweepOutput.slice(-600)}`);
    }
    if (!sweepOutput.includes("stale session sweep could not remove")) {
      throw new Error(`陈旧会话一个都清不掉，运行时一个字都没说 —— 症状只会是若干天后盘满: ${sweepOutput.slice(-800)}`);
    }
  }
  rmSync(join(agentWorkDir, "orgs", "org_probe"), {recursive: true, force: true});

  // claim 代次此前只被【客户端自查】和【执行器凭据】读取，检查点这个真正的写入点从不比较它。
  // 认领被回收后重新分配给同一个节点时 assignedNodeId 照样匹配，于是上一次尝试的检查点
  // （尤其是 outbox 重放）会被当作本轮成果接受。fencing 必须在写入点拒绝过期写入。
  {
    const staleState = await json("/api/state", {token: login.sessionToken});
    const anyDispatch = (staleState.agentDispatches || []).find((item) => item.assignedNodeId);
    if (!anyDispatch) throw new Error("没有可用于代次探针的派发 —— 这条断言无从验证");
    // 跨节点围栏：甲节点的活，乙节点不得替它汇报。检查点路由是按 dispatchId + assignedNodeId
    // 一起找的，别的节点只会得到 404 —— 这是多节点部署的完整性底线，而它此前没有反面用例。
    // （用的是本轮已注册的另一个真实节点，不是编的令牌：编的会先被 401 挡住，
    // 那样测到的是认证、不是围栏。）
    const foreignSubmit = await fetch(`${baseUrl}/api/agent/v1/dispatches/${encodeURIComponent(anyDispatch.dispatchId)}/checkpoint`, {
      method: "POST",
      headers: {"content-type": "application/json", authorization: `Bearer ${noExecutorRegistration.nodeToken}`},
      body: JSON.stringify({runId: anyDispatch.runId, sessionId: anyDispatch.sessionId,
        claimEpoch: anyDispatch.claimEpoch, summary: "别人的活"})
    });
    if (foreignSubmit.ok) {
      throw new Error("另一个节点替别人的派发交了检查点 —— 多节点部署里谁都能替谁汇报");
    }
    const foreignPayload = await foreignSubmit.json().catch(() => ({}));
    if (foreignSubmit.status !== 404 || foreignPayload.error !== "dispatch_not_found") {
      throw new Error(`跨节点提交被拒了，但不是因为围栏（${foreignSubmit.status}:${foreignPayload.error}）—— 要确认拦住它的是节点绑定，不是别的偶然原因`);
    }

    const staleEpoch = Number(anyDispatch.claimEpoch || 0) - 1;
    const staleSubmit = await fetch(`${baseUrl}/api/agent/v1/dispatches/${encodeURIComponent(anyDispatch.dispatchId)}/checkpoint`, {
      method: "POST",
      headers: {"content-type": "application/json", authorization: `Bearer ${JSON.parse(readFileSync(agentConfigPath, "utf8")).nodeToken}`},
      body: JSON.stringify({claimEpoch: staleEpoch, runId: anyDispatch.runId, sessionId: anyDispatch.sessionId})
    });
    if (staleSubmit.status !== 409) {
      throw new Error(`带着过期 claim 代次的检查点没有被拒（HTTP ${staleSubmit.status}）—— 上一次认领遗留的提交会被当作本轮成果`);
    }
    const stalePayload = await staleSubmit.json().catch(() => ({}));
    if (stalePayload.error !== "checkpoint_claim_epoch_stale") {
      throw new Error(`过期代次被拒但错误码不对（${stalePayload.error}）—— 说明拦下它的是别的守卫，这条断言没有覆盖 fencing`);
    }
    // /fail 是同一批写入点里危害更直接的一个：旧执行器超时后调 /fail(blocked)，会把当前这一轮
    // 正在跑的活标记为阻塞。发现一处漏了 fence，修复范围是"还有谁也该有"。
    const staleFail = await fetch(`${baseUrl}/api/agent/v1/dispatches/${encodeURIComponent(anyDispatch.dispatchId)}/fail`, {
      method: "POST",
      headers: {"content-type": "application/json", authorization: `Bearer ${JSON.parse(readFileSync(agentConfigPath, "utf8")).nodeToken}`},
      body: JSON.stringify({status: "blocked", claimEpoch: staleEpoch, reason: "stale-epoch probe"})
    });
    const staleFailPayload = await staleFail.json().catch(() => ({}));
    // 缺字段即可绕过的 fence 不算 fence，所以 /checkpoint 在"该派发被重新认领过"时强制要求代次。
    // 但在役的旧版运行时不发送它，一旦其派发被重认领就会卡住 —— 拒绝信息必须直接给出该怎么办，
    // 否则运维面对的是一个只说"必须带上"的错误码。
    const reclaimed = (staleState.agentDispatches || []).find((item) => Number(item.attempts || 0) > 1);
    // 这一整段（检查点与失败上报"缺代次必须被拒"）只在存在【被重认领过】的派发时才跑。
    // 没有就整段跳过 —— 而"跳过"与"验过了"在输出上一模一样。实测就出现过：改坏 /fail 的强制，
    // e2e 照样绿，因为这一轮压根没有 attempts>1 的派发。所以把它说出来。
    console.log("  ..  派发的 attempts 分布：" + JSON.stringify((staleState.agentDispatches || [])
      .reduce((acc, item) => { const k = String(item.attempts ?? "无"); acc[k] = (acc[k] || 0) + 1; return acc; }, {})));
    console.log(reclaimed
      ? `  ok  缺代次拒绝（检查点 + 失败上报）：用 attempts=${reclaimed.attempts} 的派发验过`
      : "  --  这一轮没有被重认领过的派发，'缺代次必须被拒'（检查点与失败上报两条）未被检验");
    // 【缺 runId / runId 对不上都必须被拒】。这两条边界此前只在 REST 的 /api/checkpoints 上
    // 被走到过，而那扇门 2026-08-27 关掉了（它少了节点鉴权与认领围栏）—— 判据跟着搬到
    // 它们真正该被走到的地方：带节点凭据的网关这一条。
    {
      const anyClaimed = (await json("/api/state", {token: login.sessionToken})).agentDispatches
        ?.find((item) => item.sessionId && item.runId);
      if (!anyClaimed) {
        throw new Error("本轮没有任何带会话与运行号的派发 —— 「缺 runId 必须被拒」这条会空转");
      }
      const missingRun = await jsonRaw(`/api/agent/v1/dispatches/${encodeURIComponent(anyClaimed.dispatchId)}/checkpoint`,
        {method: "POST", token: JSON.parse(readFileSync(agentConfigPath, "utf8")).nodeToken,
          body: {sessionId: anyClaimed.sessionId}});
      // 对不上的 runId：派发是按 (会话, 任务组, 工作项, runId) 找的，找不到就说明这份检查点
      // 不属于任何一次在跑的运行。这条边界原先也只在那扇已关闭的 REST 门上被走到过。
      const wrongRun = await jsonRaw(`/api/agent/v1/dispatches/${encodeURIComponent(anyClaimed.dispatchId)}/checkpoint`,
        {method: "POST", token: JSON.parse(readFileSync(agentConfigPath, "utf8")).nodeToken,
          body: {sessionId: anyClaimed.sessionId, runId: "run_does_not_exist"}});
      // 拒了不等于拒对了：真正先响的是网关【自己】那道绑定校验（URL 上的派发与报文里的
      // runId 对不上），core 里那两条边界排在它后面、走不到 —— 如实点名先响的那一道，
      // 并把 core 那两条登记进第二道门册（这里不写出它们的码：拒绝码棘轮按"码在门里出现过"
      // 统计，写出来就会被当成"已有判据"，而登记不是判据）。
      if (wrongRun.payload?.error !== "checkpoint_replay_binding_mismatch") {
        throw new Error(`runId 对不上的检查点没被拒（${wrongRun.response.status}/${wrongRun.payload?.error}）—— `
          + "这份检查点不属于任何一次在跑的运行");
      }
      if (missingRun.payload?.error !== "checkpoint_replay_binding_mismatch") {
        throw new Error(`缺 runId 的检查点没被拒（${missingRun.response.status}/${missingRun.payload?.error}）—— `
          + "runId 是「这份检查点属于哪次运行」的绑定强制点");
      }
    }
    if (reclaimed) {
      const noEpoch = await fetch(`${baseUrl}/api/agent/v1/dispatches/${encodeURIComponent(reclaimed.dispatchId)}/checkpoint`, {
        method: "POST",
        headers: {"content-type": "application/json", authorization: `Bearer ${JSON.parse(readFileSync(agentConfigPath, "utf8")).nodeToken}`},
        body: JSON.stringify({runId: reclaimed.runId, sessionId: reclaimed.sessionId})
      });
      const noEpochPayload = await noEpoch.json().catch(() => ({}));
      if (noEpoch.status === 409 && noEpochPayload.error === "checkpoint_claim_epoch_required"
        && !String(noEpochPayload.message || "").includes("重新执行入网安装命令")) {
        throw new Error("被重认领的派发拒绝了缺代次的提交，但没有告诉运维该怎么办 —— 旧版运行时会卡在这里而看不出原因");
      }
      // /fail 此前只比对过期代次，缺字段照样放行 —— 而这条路径的危害更直接：
      // 旧执行器超时后 /fail(blocked) 会把当前这一轮正在跑的活标成阻塞。
      // "发现一处漏了 fence，修复范围是还有谁也该有"——这里就是那个"还有谁"。
      const failNoEpoch = await fetch(`${baseUrl}/api/agent/v1/dispatches/${encodeURIComponent(reclaimed.dispatchId)}/fail`, {
        method: "POST",
        headers: {"content-type": "application/json", authorization: `Bearer ${JSON.parse(readFileSync(agentConfigPath, "utf8")).nodeToken}`},
        body: JSON.stringify({status: "blocked", reason: "no-epoch probe"})
      });
      const failNoEpochPayload = await failNoEpoch.json().catch(() => ({}));
      if (failNoEpoch.status !== 409 || failNoEpochPayload.error !== "dispatch_fail_claim_epoch_required") {
        throw new Error(`被重认领的派发接受了缺代次的失败上报（HTTP ${failNoEpoch.status} / ${failNoEpochPayload.error}）——`
          + " 上一轮的执行器可以把这一轮正在跑的活标记为阻塞");
      }
      if (!String(failNoEpochPayload.message || "").includes("重新执行入网安装命令")) {
        throw new Error("失败上报拒绝了缺代次，但没告诉运维该怎么办 —— 与检查点那条同规，旧版运行时会卡在这里");
      }
    }
    if (staleFail.status !== 409 || staleFailPayload.error !== "dispatch_fail_claim_epoch_stale") {
      throw new Error(`带着过期 claim 代次的失败上报没有被拒（HTTP ${staleFail.status} / ${staleFailPayload.error}）—— 上一次认领的执行器能把当前这一轮标记为阻塞`);
    }

  }

  const state = await json("/api/state", {token: login.sessionToken});
  const completed = state.agentDispatches.find((dispatch) => dispatch.status === "completed" && dispatch.assignedNodeId);
  const node = state.agentRuntimeNodes.find((item) => item.nodeId === completed?.assignedNodeId);
  if (!completed || !node || node.status !== "online" || node.completedDispatchCount < 1) throw new Error("remote Agent completion was not persisted");
  const contract = state.agentTaskContracts.find((item) => item.sessionId === completed.sessionId);
  if (contract.roleSkill.synchronizationMode !== "server_managed_on_demand" || !contract.roleSkill.usageDirective.includes("child role")) throw new Error("dispatch did not bind the server-issued skill workset and child-role skill directive");
  const eventLog = await json(`/api/agent-dispatches/${completed.dispatchId}/events?limit=80`, {token: login.sessionToken});
  const eventTypes = new Set((eventLog.events || []).map((event) => event.eventType));
  for (const requiredEvent of ["dispatch_received", "skill_synced", "executor_started", "executor_output", "repository_changed", "git_committed", "git_pushed", "checkpoint_prepared", "checkpoint_submitted"]) {
    if (!eventTypes.has(requiredEvent)) throw new Error(`Agent execution event stream missing ${requiredEvent}`);
  }
  // 【故意跳过检查点这件事，控制面必须知道】。前面那一轮是带着
  // AIMAC_AGENT_VERIFICATION_DEFER_CHECKPOINT=true 跑的：活干完了（提交、推送都做了），检查点却不交。
  // 这个开关没有档位围栏 —— 留在生产节点上，派发会一直停在「进行中」、任务组永远关不掉，
  // 而人无从判断。原先它只往本机 stdout 打一行，控制面一无所知。
  {
    const deferNotice = (eventLog.events || [])
      .find((event) => String(event.summary || "").includes("AIMAC_AGENT_VERIFICATION_DEFER_CHECKPOINT"));
    if (!deferNotice) {
      throw new Error("检查点被故意跳过，控制面却一条事件都没收到 —— "
        + "派发会一直停在「进行中」，而屏幕上看不出是那个环境变量干的");
    }
    if (deferNotice.status !== "attention") {
      throw new Error(`跳过检查点的那条事件状态是 ${deferNotice.status}，不是 attention —— `
        + "它不会出现在人的待处理面前，等于没说");
    }
  }
  if (eventLog.storage?.storageKind !== "project-jsonl" || !eventLog.storage?.storageRef?.includes("project-db/")) throw new Error("Agent execution events were not read from the project-level event store");
  const sessionEventLog = await json(`/api/work-sessions/${completed.sessionId}/execution-events?limit=80`, {token: login.sessionToken});
  assertProjectShardAndEventFilesShareOneName();
  // 人在控制台写下的三类规则、以及人已经拍板的定稿决策，都随内容包下载到磁盘 ——
  // 但它们此前【一次都没有出现在交给模型的提示里】。技能集有一句显式的 "load skill workset"，
  // 规则一句都没有。也就是说整套规则体系与人工定稿闸门，在执行这一端是装饰性的。
  // 执行事件现在带上"这份提示实际包含了哪些规则文件"，这里据此验证它们确实到达了模型。
  const promptEvidence = (sessionEventLog.events || [])
    .filter((event) => event.eventType === "executor_started")
    .flatMap((event) => event.evidenceRefs || []);
  if (!promptEvidence.some((ref) => ref.startsWith("prompt-includes:system/rules.md"))) {
    throw new Error("交给模型的提示里没有系统规则：人在控制台写的规则不会被模型读到");
  }
  // task/confirmations.json 只在【确实有已答复的确认单】时才进包（空内容不入包），
  // 本次端到端里没有，所以这里只能验证到"任务上下文"这一项 —— 它同样承载人工补充要求。
  // 定稿决策必须到达模型这条，由 contract-check 用真实内容包直接验证。
  if (!promptEvidence.some((ref) => ref.startsWith("prompt-includes:task/context.md"))) {
    throw new Error("交给模型的提示里没有任务上下文与人工补充要求");
  }

  if (!(sessionEventLog.events || []).some((event) => event.dispatchId === completed.dispatchId)) throw new Error("WorkSession execution event stream did not return dispatch events");
  const remoteTree = execFileSync("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "refs/heads/main"], {encoding: "utf8"});
  if (!remoteTree.includes("docs/agent-runtime-output/") || !remoteTree.includes("docs/artifact-manifests/")) throw new Error("Agent outputs were not committed and pushed to the project Git repository");

  // Gap 5 §7: the two-step evidence/artifact registration performed during dispatch execution must produce
  // a registered evidence artifact bound to the dispatch's task group with a computed sha256 digest.
  const artifactState = await json("/api/state", {token: login.sessionToken});
  const evidenceArtifact = (artifactState.artifacts || []).find((item) =>
    item.taskGroupId === completed.taskGroupId &&
    ["registered", "verified"].includes(item.status) &&
    /^sha256:[0-9a-f]{64}$/u.test(String(item.contentDigest || "")) && item.contentDigestAttested === true &&
    // 关键：摘要必须与运行时在本地对【证据内容】算出的哈希一致（定位符里带着它的前 40 位）。
    // 此前这里比对的是 digestOf(args) —— 请求参数的哈希，它必然长得像个 sha256，于是这条
    // 断言恒真，从来没有验证过任何内容。摘要与定位符互相印证才说明它确实来自内容本身。
    (item.outputRefs || []).some((ref) => String(ref).startsWith("artifact://")
      && String(ref).includes(String(item.contentDigest).slice("sha256:".length, "sha256:".length + 40))));
  if (!evidenceArtifact) throw new Error("two-step evidence artifact registration did not produce a registered artifact whose contentDigest matches the evidence locator");

  // Gap 5 §8: simulate a permission block, observe the structured PermissionRequest, resolve it, and verify the
  // runtime resumes from the safe retry point per the §8 resolution table and completes the dispatch.
  const permissionJoin = await json("/api/agent-join-tokens", {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-permission-token",
    body: {projectId: "prj_control_plane", nodeName: "permission-node", allowedRoles: ["*"], ttlSeconds: 1800, maxUses: 1}
  });
  const permissionWorkDir = join(sandbox, "permission-agent-work");
  const permissionTokenFile = join(sandbox, "permission.join");
  writeFileSync(permissionTokenFile, permissionJoin.joinToken, {mode: 0o600});
  const permissionInstall = spawnSync("sh", ["-s", "--", "--server", baseUrl, "--join-token-file", permissionTokenFile, "--node-name", "permission-node", "--work-dir", permissionWorkDir, "--no-daemon", "--no-configure-clients", "--executor-command", `node ${JSON.stringify(executor)}`], {
    cwd: sandbox,
    input: installerText,
    env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false"},
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (permissionInstall.status !== 0 || !permissionInstall.stdout.includes("AGENT_JOINED")) throw new Error(`permission-report Agent bootstrap failed: ${permissionInstall.stderr || permissionInstall.stdout}`);
  const permissionConfig = JSON.parse(readFileSync(join(permissionWorkDir, "agent-config.json"), "utf8"));
  const permissionRuntime = join(permissionWorkDir, "bin", "aimac-agent-runtime.mjs");
  await json("/api/orchestrator/run", {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-permission-orchestrate",
    body: {mode: "single", taskGroupId: "tg_runtime_management", autoSyncSkills: false}
  });
  const permissionChild = spawn(process.execPath, [permissionRuntime, "run", "--work-dir", permissionWorkDir, "--once"], {
    env: {
      ...process.env,
      AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true",
      AIMAC_AGENT_CONFIGURE_CLIENTS: "false",
      AIMAC_AGENT_SIMULATE_PERMISSION_BLOCK: "github_push@repo:agent-gateway-doctor",
      AIMAC_AGENT_SIMULATE_PERMISSION_PROMPT_TYPE: "oauth_login_required",
      AIMAC_AGENT_PERMISSION_POLL_INTERVAL_MS: "300",
      AIMAC_AGENT_PERMISSION_POLL_ATTEMPTS: "200"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let permissionOut = "";
  let permissionErr = "";
  permissionChild.stdout.on("data", (chunk) => { permissionOut += chunk.toString(); });
  permissionChild.stderr.on("data", (chunk) => { permissionErr += chunk.toString(); });
  const pendingRequest = await waitForPendingPermissionRequest(login.sessionToken, "github_push");
  if (pendingRequest.status !== "pending_approval" || pendingRequest.permission !== "github_push" || !pendingRequest.reason) {
    throw new Error("permission report was not observed and classified as a pending permission request");
  }
  // 【批准人看到的第一句必须是人话】。控制台那张卡把 reason 原样显示出来，
  // 而它原先塞的是 900 字 JSON —— 要批准的人得先自己解析一遍才知道在批什么。
  if (!/执行到「.+」这一步被权限挡住/u.test(pendingRequest.reason)) {
    throw new Error(`权限单的原因不是人话，批准人看到的是：${String(pendingRequest.reason).slice(0, 120)}`
      + " —— 卡片上「原因」这一栏直接显示它，要先说清在哪一步、要什么权限、对哪个对象");
  }
  // 【仿真开关造出来的必须自己承认】。这个开关没有档位围栏：留在生产节点上，
  // 每次派发都会凭空冒出一条没有真实原因的审批请求，而人无从判断。
  // 这一轮正是用 AIMAC_AGENT_SIMULATE_PERMISSION_BLOCK 触发的，所以这里必须看得见那句话。
  if (!pendingRequest.reason.includes("AIMAC_AGENT_SIMULATE_PERMISSION_BLOCK")) {
    throw new Error("仿真开关造出来的权限单没有自报身份 —— 人会把它当成真实的权限阻塞去处理，"
      + `而它其实只要清掉那台节点的环境变量。实际原因：${String(pendingRequest.reason).slice(0, 160)}`);
  }
  await json(`/api/permission-requests/${pendingRequest.requestId}/resolve`, {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-permission-resolve",
    body: {status: "approved"}
  });
  // 等 agent 跑完不能无上限：它一旦卡住（等锁、等网络、等子进程），整个 e2e 就挂在这里，
  // 最后死于一句 "Detected unsettled top-level await" —— 看不出是谁没退出。
  // 同形状在控制面 e2e 里实测撞到过一次（后台自治周期的子进程不理 SIGTERM）。
  const permissionRace = await waitForChildExitCode(permissionChild, 120000);
  if (permissionRace.timedOut) {
    permissionChild.kill("SIGKILL");
    throw new Error(`permission-report Agent 跑了 120 秒还没结束，已强制结束 —— `
      + `它多半卡在等待上（stderr 末尾：${String(permissionErr).slice(-200)}）`);
  }
  const permissionExit = permissionRace.code;
  if (permissionExit !== 0) throw new Error(`permission-report Agent run failed: ${permissionErr || permissionOut}`);
  if (!permissionOut.includes("permission report submitted")) throw new Error("Agent did not emit a structured permission report");
  const resolvedState = await json("/api/state", {token: login.sessionToken});
  const resolvedRequest = (resolvedState.permissionRequests || []).find((item) => item.requestId === pendingRequest.requestId);
  if (!resolvedRequest || resolvedRequest.status !== "approved" || !resolvedRequest.policyDecisionRef) {
    throw new Error("permission request was not resolved and classified with a policy decision");
  }
  const permissionCompleted = (resolvedState.agentDispatches || []).some((dispatch) => dispatch.assignedNodeId === permissionConfig.nodeId && dispatch.status === "completed");
  if (!permissionCompleted) throw new Error("permission-report dispatch did not complete after resolution from the safe retry point");

  const revokeJoinResult = await json("/api/agent-join-tokens", {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-revoke-token",
    body: {projectId: "prj_control_plane", nodeName: "revoke-node", allowedRoles: ["*"], ttlSeconds: 1800, maxUses: 1}
  });
  const revokeRegistration = await json("/api/agent/v1/register", {
    method: "POST",
    token: revokeJoinResult.joinToken,
    body: {nodeName: "revoke-node", requestedRoles: ["*"], runtimeVersion: "doctor", profile: {tools: [], models: [{providerClass: "custom", adapter: "doctor", available: true}]}}
  });
  await json("/api/agent/v1/self-check", {
    method: "POST",
    token: revokeRegistration.nodeToken,
    body: {checks: okSelfChecks(baseUrl), runtimeVersion: "doctor"}
  });
  const requeueOrchestrated = await json("/api/orchestrator/run", {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-revoke-orchestrate",
    body: {mode: "single", taskGroupId: "tg_runtime_management", autoSyncSkills: false}
  });
  // 【领活那一道也要守角色范围】。上面（注册处）验的是 join_token_role_scope_mismatch，
  // 而真正决定"这个节点能不能把这件活拿走"的是认领时的 roleAllowed(contract.roleId, node.allowedRoles)。
  // 把它改成恒真，三道门全绿 —— 令牌上的角色范围在【领活】这一步没有任何判据守着：
  // 一个只被允许 reviewer 的节点可以领走要求别的角色的派发。
  // 位置要紧：必须放在【确知有一件排队中的派发】的这一刻（紧接着的 revokeClaim 就要领走它），
  // 否则"没领到"是因为压根没活可领，断言恒绿。而且这台节点也要过自检，
  // 不然它会先撞上 node_not_admitted，角色那道门根本轮不到被问。
  {
    const reviewerJoin = await json("/api/agent-join-tokens", {
      method: "POST", token: login.sessionToken, idempotencyKey: "doctor-agent-reviewer-scope-token",
      body: {projectId: "prj_control_plane", nodeName: "reviewer-only-node", allowedRoles: ["reviewer"],
        ttlSeconds: 1800, maxUses: 1}
    });
    const reviewerNode = await json("/api/agent/v1/register", {
      method: "POST", token: reviewerJoin.joinToken,
      body: {nodeName: "reviewer-only-node", requestedRoles: ["reviewer"], runtimeVersion: "doctor",
        profile: {tools: [], models: [{providerClass: "custom", adapter: "doctor", available: true}]}}
    });
    await json("/api/agent/v1/self-check", {
      method: "POST", token: reviewerNode.nodeToken,
      body: {checks: okSelfChecks(baseUrl), runtimeVersion: "doctor"}
    });
    const scopedClaim = await json("/api/agent/v1/dispatches/next", {
      method: "POST", token: reviewerNode.nodeToken, body: {claimTtlSeconds: 300}});
    if (scopedClaim.dispatch) {
      const taken = JSON.stringify(scopedClaim.dispatch);
      const takenRole = (taken.match(/"roleId":"([^"]+)"/) || [])[1] || `报文：${taken.slice(0, 160)}`;
      throw new Error(`只被允许 reviewer 的节点领走了一件派发（角色 ${takenRole}）—— `
        + "入网令牌上的角色范围在【领活】这一步没有守住");
    }
    // 拒了不等于拒对了：得说得出是【角色】不匹配。控制台上"节点在线、派发排队、就是不动"
    // 这件事，原先三种原因（没准入 / 角色不符 / 跑不了这个模型）长得一模一样。
    // 诊断不在回执里（agent 拿到的只有 no_compatible_dispatch），它落在节点记录上给【人】看。
    const scopedNodeList = await json("/api/agent-nodes", {token: login.sessionToken});
    const scopedNodes = scopedNodeList.agentRuntimeNodes || [];
    const scopedNodeRecord = scopedNodes.find((item) => item.nodeId === reviewerNode.node.nodeId);
    if (!scopedNodeRecord) {
      throw new Error(`受限角色的那台节点在 /api/agent-nodes 里找不到（有 ${scopedNodes.length} 条：`
        + `${scopedNodes.map((item) => item.nodeName).join(",")}）—— 下面这条会空转`);
    }
    const scopedReasons = (scopedNodeRecord.lastClaimMiss?.reasons || []).map((item) => item.reason);
    if (!scopedReasons.includes("role_not_allowed_on_node")) {
      throw new Error(`受限角色的节点领不到活，但节点上留的诊断没说是角色不匹配：`
        + `${JSON.stringify(scopedNodeRecord?.lastClaimMiss || null)} —— `
        + "控制台上看到的还是「在线的节点 + 排队中的派发」，和模型跑不了长得一模一样");
    }
  }

  const revokeClaim = await json("/api/agent/v1/dispatches/next", {method: "POST", token: revokeRegistration.nodeToken, body: {claimTtlSeconds: 900}});
  if (!revokeClaim.dispatch) throw new Error(`revoke test could not claim a dispatch: ${requeueOrchestrated.changed?.map((item) => item.workItemId || item.dispatchId).join(",") || "none"}`);
  // git push 之前那道 claim 复核（GET /dispatches/:id/claim）是【另一扇门】：checkpoint 路由自己
  // 也有一道陈旧代次检查，而把 validateDispatchClaim 里那句代次比对整个删掉，三套 e2e 无一报红。
  // 它失效的后果更直接：失联后恢复的节点会先把提交 push 上去，等检查点被拒时东西已经在远端分支上。
  // 必须在【刚认领、派发还在 running】的这一刻验：完成之后走的是 dispatch_completed 那一支。
  {
    const claimed = revokeClaim.dispatch.dispatch || revokeClaim.dispatch;
    const claimUrl = `${baseUrl}/api/agent/v1/dispatches/${encodeURIComponent(claimed.dispatchId)}/claim`;
    const fresh = await fetch(`${claimUrl}?claimEpoch=${Number(claimed.claimEpoch || 0)}`,
      {headers: {authorization: `Bearer ${revokeRegistration.nodeToken}`}});
    if (fresh.status !== 200) {
      const why = await fresh.json().catch(() => ({}));
      throw new Error(`刚认领的派发做 claim 复核却没通过（${fresh.status} ${why.reason || ""}）—— 下面那条陈旧代次断言会在空转`);
    }
    const stale = await fetch(`${claimUrl}?claimEpoch=${Number(claimed.claimEpoch || 0) - 1}`,
      {headers: {authorization: `Bearer ${revokeRegistration.nodeToken}`}});
    const stalePayload = await stale.json().catch(() => ({}));
    if (stale.status !== 409 || stalePayload.reason !== "claim_epoch_stale") {
      throw new Error("push 前的 claim 复核放过了陈旧代次"
        + `（期望 409 claim_epoch_stale，得到 ${stale.status} ${stalePayload.reason || ""}）—— `
        + "失联后恢复的节点会先把提交推上去，等检查点被拒时东西已经在远端分支上了");
    }
  }
  // （放在 claim 复核之后：提一张阻塞型确认单会把派发变成 blocked，
  //   放在前面会吃掉那条断言的前提 —— 实测撞了一次。）
  // agent 提确认单这条路【三套 e2e 从来没走过】。它守着一个已复现的绕过：agent 自选
  // decisionType/subjectRef，伪造一张文案无害的"方案确认"卡片，而锁落在它想跑的另一个对象上。
  // 路由里是逐字段白名单，但契约门测的是【白名单之后】的 core 调用（注释自己写着"模拟"）——
  // 把路由改回 {...body} 透传，148 条契约检查全绿。只有从这条真通道打进去才看得见。
  {
    const claimedForCard = revokeClaim.dispatch.dispatch || revokeClaim.dispatch;
    const forged = await json("/api/agent/v1/confirmations", {
      method: "POST", token: revokeRegistration.nodeToken,
      body: {
        dispatchId: claimedForCard.dispatchId,
        workItemId: claimedForCard.workItemId,
        sessionId: claimedForCard.sessionId,
        summary: "看起来无害的一个问题：要不要继续这一步？",
        options: [{optionId: "go", label: "继续"}],
        // 以下三样是 agent 想自己塞的：类别、被锁定的对象、决策等级。一个都不该被采纳。
        decisionType: "plan_topology",
        subjectRef: "ExecutionTopology:topo_agent_wants_this",
        decisionClass: "major"
      }
    });
    const card = forged.request;
    if (!card) throw new Error(`agent 通道提不出运行时确认单：${JSON.stringify(forged).slice(0, 160)}`);
    if (card.decisionType !== "runtime_execution") {
      throw new Error(`agent 自选的 decisionType 被采纳了（${card.decisionType}）—— `
        + "它能伪造一张文案无害的核心决策卡片，人一点确认，定稿锁就落到没人真正看过的那个对象上");
    }
    if (card.subjectRef) {
      throw new Error(`agent 自选的 subjectRef 被采纳了（${card.subjectRef}）—— 锁会落到它指定的对象上`);
    }
    if (card.decisionClass === "major") {
      throw new Error("agent 提的单被记成了核心决策 —— 核心决策一律由控制面按真实对象生成，不走这条通道");
    }
    // agent 回头【查】自己那张单的通道，此前三套 e2e 也从没走过（路由记账量出来的最后一条）。
    // 它守着两件事：只能查自己节点的单；`?consume=true` 只在人已答复时才销单。
    const own = await json(`/api/agent/v1/confirmations/${encodeURIComponent(card.requestId)}`,
      {token: revokeRegistration.nodeToken});
    if (own.request?.requestId !== card.requestId) {
      throw new Error(`agent 查不到自己刚提的确认单：${JSON.stringify(own).slice(0, 160)}`);
    }
    const foreign = await jsonRaw(`/api/agent/v1/confirmations/${encodeURIComponent(card.requestId)}`,
      {token: rotatedAgentConfig.nodeToken});
    if (foreign.response.status !== 404 || foreign.payload?.error !== "human_confirmation_not_found") {
      throw new Error(`别的节点查得到这张确认单（${foreign.response.status}/${foreign.payload?.error}）—— `
        + "确认单里写着这台机器在做什么、要不要继续，跨节点必须查不到");
    }
    // 人还没答复时销单：必须不销。销掉的话，那张卡片会从人工审核页上消失，而没有人回答过它。
    const earlyConsume = await json(`/api/agent/v1/confirmations/${encodeURIComponent(card.requestId)}?consume=true`,
      {token: revokeRegistration.nodeToken});
    if (earlyConsume.request?.status === "consumed") {
      throw new Error("人还没答复，agent 一句 consume=true 就把确认单销掉了 —— 那张卡片会从人工审核页上消失，而没人回答过它");
    }
  }

  const revokeResult = await json(`/api/agent-nodes/${revokeRegistration.node.nodeId}/revoke`, {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-node-revoke"
  });
	  const revokedDispatchId = revokeClaim.dispatch.dispatch.dispatchId;
	  const postRevokeState = await json("/api/state", {token: login.sessionToken});
	  const pendingDispatch = postRevokeState.agentDispatches.find((dispatch) => dispatch.dispatchId === revokedDispatchId);
		  if (!revokeResult.pendingDispatchIds.includes(revokedDispatchId) || pendingDispatch?.status !== "blocked" || pendingDispatch.assignedNodeId !== revokeRegistration.node.nodeId) {
		    throw new Error("Agent node revocation did not fence the running dispatch before ACK");
		  }
      if ((postRevokeState.mcpGrants || []).some((grant) => grant.agentNodeId === revokeRegistration.node.nodeId && grant.dispatchId === revokedDispatchId && grant.grantStatus === "issued")) {
        throw new Error("Agent node revocation did not revoke dispatch MCP grants before ACK");
      }
	  if (revokeResult.status !== "draining" || revokeResult.command?.commandType !== "revoke") {
	    throw new Error("Agent node revocation did not queue a draining revoke command");
	  }
	  const revokeControls = await json("/api/agent/v1/control?afterSequence=0&waitMs=1000", {token: revokeRegistration.nodeToken});
	  if (!revokeControls.commands.some((command) => command.commandId === revokeResult.command.commandId && command.commandType === "revoke")) {
	    throw new Error("Agent node control channel did not deliver revoke command");
	  }
	  // 失败上报里认不出的状态同样必须拒：拼错 "blocked" 会被降级成 failed（终态），
	  // 本来一恢复就能接着跑的活从此回不来，而上报方拿到的是 200。
	  {
	    const bogusFail = await jsonRaw(`/api/agent/v1/dispatches/${encodeURIComponent(revokedDispatchId)}/fail`, {
	      method: "POST", token: revokeRegistration.nodeToken, body: {status: "blockd", reason: "拼错了"}});
	    if (bogusFail.response.status !== 400 || bogusFail.payload?.error !== "dispatch_fail_status_unknown") {
	      throw new Error(`认不出的失败上报状态没有被拒（HTTP ${bogusFail.response.status} / ${bogusFail.payload?.error}）`
	        + " —— 拼错一个字母就把可恢复的活变成了终态");
	    }
	  }
	  // 认不出的回执状态必须拒绝，不能静默当成 "acked"：节点想【拒绝】一条命令时拼错一个字母，
	  // 原先会被记成"已接受" —— 人从屏幕上看到 agent 收下了这条命令，而它其实什么都没做。
	  const bogusAck = await jsonRaw(`/api/agent/v1/control/${revokeResult.command.commandId}/ack`, {
	    method: "POST", token: revokeRegistration.nodeToken, body: {status: "acknowledgd"}});
	  if (bogusAck.response.status !== 400 || bogusAck.payload?.error !== "agent_control_command_ack_status_unknown") {
	    throw new Error(`认不出的控制命令回执状态没有被拒（HTTP ${bogusAck.response.status} / ${bogusAck.payload?.error}）`
	      + " —— 它会被静默记成已接受，人以为 agent 收下了这条命令");
	  }
	  if (!(bogusAck.payload?.supported || []).includes("rejected")) {
	    throw new Error("拒绝报文里没给出合法的回执状态清单 —— 调用方只能猜自己该写什么");
	  }
	  await json(`/api/agent/v1/control/${revokeResult.command.commandId}/ack`, {
	    method: "POST",
	    token: revokeRegistration.nodeToken,
	    body: {status: "completed", result: {stopped: true}}
	  });
	  const postAckState = await json("/api/state", {token: login.sessionToken});
	  // 被吊销的节点必须【离开舰队分母】。原先 fleet.total 数的是所有行，于是三台全吊销时
	  // 界面会说"已注册 3 个，此刻都不在线或已降级，把降级的那台修好或重启" —— 让人去修
	  // 一台不存在的机器；正确的话是"一个都还没注册，按安装指引接一台"。
	  // fleet 只在项目视角的视图里下发（full 视图提前返回，不带它）—— 要按控制台真用的那个取。
	  const fleetView = await json("/api/state?view=projects&projectId=prj_control_plane", {token: login.sessionToken});
	  if (!fleetView.fleet) {
	    throw new Error("projects 视图没有下发 fleet 计数 —— 舰队分母这条断言在空转");
	  }
	  const revokedNodes = (fleetView.agentRuntimeNodes || []).filter((node) => node.status === "revoked").length;
	  if (!revokedNodes) {
	    throw new Error("这一轮没有任何已吊销的节点 —— 舰队分母这条断言在空转（吊销流程可能没走到）");
	  }
	  const liveNodes = (fleetView.agentRuntimeNodes || []).filter((node) => node.status !== "revoked").length;
	  if (fleetView.fleet.total !== liveNodes) {
	    throw new Error(`舰队分母把已吊销的节点也算了进去（fleet.total=${fleetView.fleet.total}，`
	      + `未吊销的只有 ${liveNodes}，已吊销 ${revokedNodes}）—— 界面会据此说"把降级的那台修好或重启"，`
	      + "而那台机器已经不在了");
	  }
	  const requeuedDispatch = postAckState.agentDispatches.find((dispatch) => dispatch.dispatchId === revokedDispatchId);
	  if (requeuedDispatch?.status !== "queued" || requeuedDispatch.assignedNodeId) {
	    throw new Error("Agent node revocation ACK did not requeue the fenced dispatch");
	  }
	  // 让这个被重排的派发【再被认领一次】，attempts 变成 2 —— 只有这时"缺代次必须被拒"
	  // 才有意义（首次认领不存在更早的持有者）。此前 e2e 里从来没有 attempts>1 的派发，
	  // 于是那两条断言（检查点、失败上报）整段被跳过，而跳过与验过在输出上一模一样：
	  // 我把 /fail 的强制改坏，e2e 照样绿，才发现这件事。
	  const secondJoin = await json("/api/agent-join-tokens", {
	    method: "POST",
	    token: login.sessionToken,
	    idempotencyKey: "doctor-agent-reclaim-token",
	    body: {projectId: "prj_control_plane", nodeName: "reclaim-node", allowedRoles: ["*"], ttlSeconds: 900}
	  });
	  const secondRegistration = await json("/api/agent/v1/register", {
	    method: "POST",
	    token: secondJoin.joinToken,
	    body: {nodeName: "reclaim-node", requestedRoles: ["*"], runtimeVersion: "doctor", profile: {tools: [], models: [{providerClass: "custom", adapter: "doctor", available: true}]}}
	  });
	  await json("/api/agent/v1/self-check", {
	    method: "POST",
	    token: secondRegistration.nodeToken,
	    body: {checks: okSelfChecks(baseUrl), runtimeVersion: "doctor"}
	  });
	  const reclaim = await json("/api/agent/v1/dispatches/next", {method: "POST", token: secondRegistration.nodeToken, body: {}});
	  const reclaimedId = reclaim.dispatch?.dispatch?.dispatchId;
	  if (!reclaimedId) throw new Error("重排后的派发没能被新节点认领 —— '缺代次必须被拒'这两条又会整段跳过");
	  const reclaimedAttempts = Number(reclaim.dispatch.dispatch.attempts || 0);
	  if (reclaimedAttempts < 2) throw new Error(`重认领后的 attempts=${reclaimedAttempts}，不足以触发"缺代次必须被拒"`);
	  const postNoEpoch = await fetch(`${baseUrl}/api/agent/v1/dispatches/${encodeURIComponent(reclaimedId)}/checkpoint`, {
	    method: "POST",
	    headers: {"content-type": "application/json", authorization: `Bearer ${secondRegistration.nodeToken}`},
	    body: JSON.stringify({runId: reclaim.dispatch.dispatch.runId, sessionId: reclaim.dispatch.dispatch.sessionId})
	  });
	  const postNoEpochPayload = await postNoEpoch.json().catch(() => ({}));
	  if (postNoEpoch.status !== 409 || postNoEpochPayload.error !== "checkpoint_claim_epoch_required") {
	    throw new Error(`被重认领的派发接受了缺代次的检查点（HTTP ${postNoEpoch.status} / ${postNoEpochPayload.error}）——`
	      + " 上一轮执行器的提交会被当成这一轮的成果");
	  }
	  const failNoEpoch = await fetch(`${baseUrl}/api/agent/v1/dispatches/${encodeURIComponent(reclaimedId)}/fail`, {
	    method: "POST",
	    headers: {"content-type": "application/json", authorization: `Bearer ${secondRegistration.nodeToken}`},
	    body: JSON.stringify({status: "blocked", reason: "no-epoch probe"})
	  });
	  const failNoEpochPayload = await failNoEpoch.json().catch(() => ({}));
	  if (failNoEpoch.status !== 409 || failNoEpochPayload.error !== "dispatch_fail_claim_epoch_required") {
	    throw new Error(`被重认领的派发接受了缺代次的失败上报（HTTP ${failNoEpoch.status} / ${failNoEpochPayload.error}）——`
	      + " 上一轮的执行器可以把这一轮正在跑的活标记为阻塞");
	  }
	  for (const [label, payload] of [["检查点", postNoEpochPayload], ["失败上报", failNoEpochPayload]]) {
	    if (!String(payload.message || "").includes("重新执行入网安装命令")) {
	      throw new Error(`${label}拒绝了缺代次，但没告诉运维该怎么办 —— 旧版运行时会卡在这里而看不出原因`);
	    }
	  }
	  console.log(`  ok  缺代次必须被拒（检查点 + 失败上报）：用 attempts=${reclaimedAttempts} 的重认领派发验过`);

	  // §8 的权限回路上面已经验过一遍，但那次是靠 AIMAC_AGENT_SIMULATE_PERMISSION_BLOCK 触发的。
	  // 真实部署里【没有任何东西会触发它】—— 检测那一半此前只有一个模拟开关（代码注释里写着
	  // "real deployments wire concrete detectors here"）。于是凭据不足的推送只会变成一条普通失败：
	  // 活白干，人也拿不到"发凭据 / 改派 / 中止"这几个选项。这里造一次【真的被远端拒掉的推送】。
	  {
	    const denyHook = join(remote, "hooks", "pre-receive");
	    const denyFlag = join(sandbox, "flag-deny-push");
	    writeFileSync(denyHook, ["#!/bin/sh",
	      `[ -f ${JSON.stringify(denyFlag)} ] || exit 0`,
	      // 服务端拒绝写入时的原话形状（GitHub / Gerrit / 分支保护都是这一类）。
	      'echo "remote: Permission to prj_control_plane.git denied to permission-node." 1>&2',
	      "exit 1"].join("\n"));
	    chmodSync(denyHook, 0o755);
	    let deniedRun = null;
	    try {
	      // 先编排、后开拒 —— 编排自己也会推一次。第一版把开关先打开了，结果连编排那一步一起拒掉，
	      // 整个请求卡住不返回（查了才发现：拒的不是我想拒的那次推送）。
	      // 先造一件新活：到这一步任务组里的机器可执行工作项已经做完了，直接编排拿不到新派发，
	      // 这一条就会整条空转（第一版正是这样，自报里写着「没领到新派发」）。
	      await json("/api/task-groups/tg_runtime_management/work-items", {
	        method: "POST", token: login.sessionToken, idempotencyKey: "doctor-agent-denied-push-work",
	        body: {title: "推送被远端拒掉时要走 §8", ownerRole: "agent-runtime",
	          requirements: ["commit to project git", "return checkpoint"]}
	      });
	      await json("/api/orchestrator/run", {
	        method: "POST", token: login.sessionToken, idempotencyKey: "doctor-agent-denied-push-orchestrate",
	        body: {mode: "single", taskGroupId: "tg_runtime_management", autoSyncSkills: false}
	      });
	      writeFileSync(denyFlag, "on\n");
	      const deniedChild = spawn(process.execPath, [permissionRuntime, "run", "--work-dir", permissionWorkDir, "--once"], {
	        env: {
	          ...process.env,
	          AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true",
	          AIMAC_AGENT_CONFIGURE_CLIENTS: "false",
	          // 这一次【不给】模拟开关：要么是真的检测到了，要么这条什么也没验。
	          AIMAC_AGENT_PERMISSION_POLL_INTERVAL_MS: "300",
	          AIMAC_AGENT_PERMISSION_POLL_ATTEMPTS: "200"
	        },
	        stdio: ["ignore", "pipe", "pipe"]
	      });
	      let deniedOut = "";
	      let deniedErr = "";
	      deniedChild.stdout.on("data", (chunk) => { deniedOut += chunk.toString(); });
	      deniedChild.stderr.on("data", (chunk) => { deniedErr += chunk.toString(); });
	      // 拿不到派发（工作项都做完了）时这一条就没造出情形 —— 必须自报，不能等成超时。
	      const denied = await waitForPendingPermissionRequest(login.sessionToken, "git_push").catch((error) => ({error}));
	      if (denied.error) {
	        // 它多半【早就退了】（没领到派发就直接结束）。对一个已经退出的子进程再
	        // await once(child,"exit") 会永远等下去 —— 那个事件在我们挂监听之前就发过了。
	        // 第一版正是这么写的，整套 e2e 卡死在这一行，查了三轮才落到它头上。
	        if (deniedChild.exitCode === null && deniedChild.signalCode === null) {
	          deniedChild.kill("SIGKILL");
	          await waitForChildExit(deniedChild, 3000);
	        }
	        // 「没造出情形」和「造出了但没检测出来」必须分开：混成一类的话，
	        // 把检测器改坏之后这一条照样绿（实测 —— 两条变异都骗过了它）。
	        // agent 明明领到了派发还失败了，那就是缺陷，不是这一轮没赶上。
	        const agentText = String(deniedOut + deniedErr);
	        if (/dispatch failed/u.test(agentText)) {
	          throw new Error("推送被远端拒掉，agent 直接把派发判失败了，没有走 §8 上报权限单 —— "
	            + `活白干，人也拿不到「发凭据 / 改派 / 中止」这几个选项：${agentText.slice(-200)}`);
	        }
	        console.log("  --  这一轮没造出「推送被远端拒掉」的情形（没领到新派发），"
	          + `「真实的推送被拒要走 §8」未被检验：${agentText.slice(-160)}`);
	      } else {
	        if (denied.promptType && !["permission_denied", "credential_required"].includes(denied.promptType)) {
	          throw new Error(`推送被拒上报成了 ${denied.promptType} —— 它该被认成权限问题`);
	        }
	        // 人处置：先真的把拒绝解除（相当于运维去补了写权限），再批这张单。
	        rmSync(denyFlag, {force: true});
	        await json(`/api/permission-requests/${denied.requestId}/resolve`, {
	          method: "POST", token: login.sessionToken, idempotencyKey: "doctor-agent-denied-push-resolve",
	          body: {status: "approved"}
	        });
	        const deniedRace = await waitForChildExitCode(deniedChild, 120000);
	        if (deniedRace.timedOut) {
	          deniedChild.kill("SIGKILL");
	          throw new Error(`推送被拒后的 agent 跑了 120 秒还没结束（stderr 末尾：${deniedErr.slice(-200)}）`);
	        }
	        if (deniedRace.code !== 0) {
	          throw new Error(`推送被拒 → 人授权 → 重推 这一趟没跑通：${deniedErr || deniedOut}`);
	        }
	        if (!deniedOut.includes("permission report submitted")) {
	          throw new Error("推送被远端拒掉了，agent 却没有上报权限单 —— 活白干，人也拿不到可处置的选项");
	        }
	        deniedRun = denied;
	      }
	    } finally {
	      rmSync(denyFlag, {force: true});
	      rmSync(denyHook, {force: true});
	    }
	    if (deniedRun) {
	      console.log("  ok  真实的推送被拒 → 权限单 → 人授权 → 从安全重试点重推：整条跑通（没有用模拟开关）");
	    }
	  }

	  // 到这里，这一轮 e2e 已经真的派发、真的 commit、真的 push、真的提交过 checkpoint。
	  // 契约门那一侧只能校验它自己造的记录，够不到这些 —— 而 checkpoint 的 commitRefs/pushRefs
	  // 正是关闭门赖以判定的证据面，此前没有任何实例被按规范校验过。
	  // 读磁盘上的完整水合状态而不是 /api/state：后者按 limit 截断，拿截断结果做全量核对
	  // 等于把截断当全文，漏掉的记录不会有任何提示。
	  const producedState = readStoredState({
	    root,
	    runtimeDir,
	    statePath: join(runtimeDir, "control-plane-state.json"),
	    seedPath: join(root, "data/seed-state.json"),
	    // 状态此刻必定已存在。若真走到"新建初始状态"，说明读的根本不是这一轮跑出来的东西 ——
	    // 那时校验一份崭新的种子会得到一个毫无意义的绿，必须当场炸掉。
	    buildInitialState: () => { throw new Error("agent remote doctor: 期望读到本轮跑出的状态，却触发了初始状态创建"); }
	  });
	  const sweep = sweepRecordsAgainstDeclaredSchemas(producedState, {
	    specDir: join(root, "spec"), label: "远程 agent e2e 产出", minValidated: 30
	  , maxUncovered: UNCOVERED_CEILINGS["远程 agent e2e 产出"]});
	  if (!(producedState.checkpoints || []).some((item) => item.schemaVersion)) {
	    throw new Error("agent remote doctor: 本轮没有产出任何带 schemaVersion 的 checkpoint —— 这道规范核对在空转，commit/push 证据面依旧无人校验");
	  }
	  if (sweep.errors.length) {
	    throw new Error(`agent remote doctor: e2e 真实产出的记录不符合它们自己声明的规范：\n- ${sweep.errors.slice(0, 200).join("\n- ")}`);
	  }
	  console.log(`e2e 产出规范核对 ok: ${sweep.validated} 条记录符合各自声明的 schema（含 checkpoint 的 commit/push 证据）；${sweep.uncoveredNote}`);

  // 【执行器跑完一个字都没改】。真实里这意味着模型空转：额度烧了、活没动。
  // agent 必须把它判成失败并如实报回控制面 —— 不能当成做完了去提交一个空 commit，
  // 也不能悄悄退出（那样派发会挂在"运行中"直到租约过期，人看到的是"还在跑"）。
  // 这条失败码此前零覆盖（36 个码里剩下的 6 个之一），而它守的是最容易被当成"没事发生"的一种失败。
  {
    await json("/api/task-groups/tg_runtime_management/work-items", {
      method: "POST", token: login.sessionToken, idempotencyKey: "doctor-agent-nochange-work",
      body: {workItemId: "work_nochange_probe", title: "执行器什么都不改时要判失败",
        ownerRole: "agent-runtime", requirements: ["commit to project git", "return checkpoint"]}
    });
    await json("/api/orchestrator/run", {
      method: "POST", token: login.sessionToken, idempotencyKey: "doctor-agent-nochange-orchestrate",
      body: {mode: "single", taskGroupId: "tg_runtime_management", autoSyncSkills: false}
    });
    const nochangeRun = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
      env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false"},
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024
    });
    const nochangeText = `${nochangeRun.stdout || ""}${nochangeRun.stderr || ""}`;
    const state = await json("/api/state?view=full&limit=200", {token: login.sessionToken});
    const nochangeDispatch = (state.agentDispatches || [])
      .find((item) => item.workItemId === "work_nochange_probe");
    // 夹具没造出想测的情形也要能自报：派发没造出来 / 没被这台节点领走时，下面两条恒绿。
    if (!nochangeDispatch) {
      throw new Error("「什么都不改」这条没造出想测的情形：没有为它造出派发 —— 下面两条断言什么也没验");
    }
    if (!/executor_produced_no_changes/u.test(nochangeText)) {
      throw new Error("执行器一个字都没改，agent 侧没有报出 executor_produced_no_changes —— "
        + `它要么当成做完了、要么悄悄退了（agent 输出：${nochangeText.slice(-300)}）`);
    }
    if (!String(nochangeDispatch.failureReason || "").includes("executor_produced_no_changes")) {
      throw new Error("agent 判了失败，而控制面上这条派发的失败原因不是它（"
        + `${nochangeDispatch.status}/${nochangeDispatch.failureReason || "空"}）—— `
        + "人在控制台上看不出这一轮为什么没产出");
    }
    console.log("  ok  执行器一个字都没改时判失败，并如实报回控制面（executor_produced_no_changes）");
  }

  // 【只写了产物清单、没有任何任务输出】。比"一个字都没改"更隐蔽：git 看得到改动、提交也能成，
  // 而提交里除了 agent 自己要写的那份清单什么都没有 —— 验收的人翻开一看是空的。
  // 复用上面那件活跑第二次（编排不会为一件新活再排派发：上一条探针失败之后任务组的状态就变了，
  // 实测新工作项根本没进编排回执 —— 那样这一条会永远"没造出情形"）。
  {
    writeFileSync(join(sandbox, "only-manifest.flag"), "on\n");
    const manifestOrchestrated = await json("/api/orchestrator/run", {
      method: "POST", token: login.sessionToken, idempotencyKey: "doctor-agent-onlymanifest-orchestrate",
      body: {mode: "single", taskGroupId: "tg_runtime_management", autoSyncSkills: false}
    });
    const manifestRun = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
      env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false"},
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024
    });
    const manifestText = `${manifestRun.stdout || ""}${manifestRun.stderr || ""}`;
    if (!/adp_/u.test(manifestText)) {
      throw new Error("「只写清单」这条没造出想测的情形：这一轮 agent 没领到任何派发 —— 下面的断言什么也没验"
        + `（编排回执：${JSON.stringify(manifestOrchestrated.changed || []).slice(0, 300)}）`);
    }
    if (!/executor_produced_no_output/u.test(manifestText)) {
      throw new Error("执行器只写了产物清单，agent 侧没有报出 executor_produced_no_output —— "
        + `等于拿一份空清单冒充产出（agent 输出：${manifestText.slice(-300)}）`);
    }
    const afterState = await json("/api/state?view=full&limit=200", {token: login.sessionToken});
    const failedByOutput = (afterState.agentDispatches || [])
      .some((item) => String(item.failureReason || "").includes("executor_produced_no_output"));
    if (!failedByOutput) {
      throw new Error("agent 判了失败，而控制面上没有任何一条派发的失败原因是 executor_produced_no_output —— "
        + "人在控制台上看不出这一轮为什么没产出");
    }
    console.log("  ok  执行器只写了产物清单、没有任务输出时判失败（executor_produced_no_output）");
  }
  // 【推上去之后远端不是我推的那个】。真实成因：并发的强推、镜像同步把分支拨回去、
  // 或者服务端的钩子改写了引用。agent 必须发现并判失败 —— 否则它会带着"已推送"的检查点回去，
  // 而那份产出实际上不在远端，验收的人按 commit 去看会扑空。
  // 造法：post-receive 钩子在推入之后把分支回退到上一版（推送本身是成功的，只是结果被改了）。
  {
    const rewindFlag = join(sandbox, "rewind-after-push.flag");
    const rewindHook = join(remote, "hooks", "post-receive");
    writeFileSync(rewindHook, ["#!/bin/sh",
      `[ -f ${JSON.stringify(rewindFlag)} ] || exit 0`,
      "while read old new ref; do",
      '  case "$old" in 0000000000000000000000000000000000000000) continue;; esac',
      '  git update-ref "$ref" "$old"',
      "done",
      "exit 0"].join("\n"));
    chmodSync(rewindHook, 0o755);
    writeFileSync(rewindFlag, "on\n");
    const rewindOrchestrated = await json("/api/orchestrator/run", {
      method: "POST", token: login.sessionToken, idempotencyKey: "doctor-agent-rewind-orchestrate",
      body: {mode: "single", taskGroupId: "tg_runtime_management", autoSyncSkills: false}
    });
    // 【顺带：技能集缓存清单坏了】。skill-worksets/<id>/skill-workset.json 是 agent 自己写在本机的缓存，
    // 每次领活都会读回来 —— 这份文件此前从没被任何门碰过。它坏掉（截断、手改、磁盘错）不该让这个
    // 节点之后的每一件活都崩在同一行：缓存读不出来就重新同步，摘要会把内容重新钉住。
    // 搭在这一轮上（同一件活只剩这一次可派发）：这一轮要能推上去、被回退、被发现，
    // 本身就证明领活时缓存那一步没崩；下面先验缓存、再验回退，免得归错因。
    const cacheRoot = join(agentWorkDir, "skill-worksets");
    const manifests = existsSync(cacheRoot)
      ? readdirSync(cacheRoot).map((name) => join(cacheRoot, name, "skill-workset.json")).filter((path) => existsSync(path))
      : [];
    if (!manifests.length) {
      throw new Error("「缓存清单坏了」这条没造出想测的情形：前两轮派发之后本机没有任何技能集缓存清单"
        + `（${cacheRoot}）—— 下面的断言什么也没验`);
    }
    for (const path of manifests) writeFileSync(path, "{\"worksetDigest\": \"sha256:trunc");
    const rewindRun = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
      env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false"},
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024
    });
    const rewindText = `${rewindRun.stdout || ""}${rewindRun.stderr || ""}`;
    if (!/adp_/u.test(rewindText)) {
      throw new Error("「推完被回退」这条没造出想测的情形：这一轮 agent 没领到任何派发"
        + `（编排回执：${JSON.stringify(rewindOrchestrated.changed || []).slice(0, 300)}）`);
    }
    if (/Unterminated string in JSON|Unexpected token|Unexpected end of JSON|SyntaxError/u.test(rewindText)) {
      throw new Error("技能集缓存清单坏了一份，agent 领活没有走到执行器 —— 这是缓存，读不出来该重新同步，"
        + `而不是让这个节点之后每一件活都死在同一行（agent 输出尾：${rewindText.slice(-300)}）`);
    }
    const healed = manifests.filter((path) => {
      try { return Boolean(JSON.parse(readFileSync(path, "utf8")).worksetDigest); } catch { return false; }
    });
    // 只会修这一轮真用到的那份；没被读到的坏清单留着，下次用到它时同样走重新同步。
    if (!healed.length) {
      throw new Error(`坏掉的缓存清单一份都没被重新同步回来（0/${manifests.length} 份可读）—— `
        + "下一次领活还会撞上同一份坏文件");
    }
    console.log(`  ok  技能集缓存清单坏了时 agent 重新同步而不是崩掉（${healed.length}/${manifests.length} 份清单被这一轮用到并修复）`);
    if (!/push_verification_failed/u.test(rewindText)) {
      throw new Error("推上去之后远端被回退，agent 没有发现 —— 它会带着「已推送」的检查点回去，"
        + `而那份产出并不在远端（agent 输出：${rewindText.slice(-300)}）`);
    }
    writeFileSync(rewindFlag, "");
    rmSync(rewindHook, {force: true});
    console.log("  ok  推上去之后远端被回退时，agent 发现并判失败（push_verification_failed）");
  }
  // 【发件箱里那份检查点，声称推上去的提交在远端已经找不到了】。真实成因：别人强推、
  // 分支被重置、镜像回滚 —— 而这份检查点承载的是"提交已经推送成功"。agent 必须把它挪进恢复区
  // 并告诉控制面，不能一直重放（那会把这个节点卡在这一条上，新活一件都领不了）。
  {
    const outboxDir = join(agentWorkDir, "outbox");
    mkdirSync(outboxDir, {recursive: true});
    const ghostDispatchId = "adp_replay_recover_probe";
    // 仓库检出目录必须真的在（前面的派发已经克隆过）：不在的话走的是另一条恢复分支，
    // 验的就不是"提交在远端找不到了"这一支。
    const clonedRepo = join(agentWorkDir, "repositories", "repo_control_plane");
    if (!existsSync(join(clonedRepo, ".git"))) {
      throw new Error(`「重放找不到提交」这条没造出想测的情形：agent 侧没有克隆好的仓库（${clonedRepo}）`);
    }
    writeFileSync(join(outboxDir, `${ghostDispatchId}.json`), JSON.stringify({
      dispatchId: ghostDispatchId,
      claimEpoch: 1,
      checkpointPath: `/api/agent/v1/dispatches/${ghostDispatchId}/checkpoint`,
      repositoryOutputTarget: {repositoryId: "repo_control_plane", remote: "origin", branch: "main"},
      checkpoint: {runId: "run_replay_recover_probe", status: "completed",
        // 这个 sha 在远端根本不存在（造一个合法长度的假值）——「已推送的提交找不到了」正是这样。
        pushRefs: [{remote: "origin", ref: "refs/heads/main", remoteSha: "0123456789abcdef0123456789abcdef01234567"}]},
      createdAt: new Date().toISOString()
    }, null, 2));
    const replayRecover = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
      env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false"},
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024
    });
    const replayText = `${replayRecover.stdout || ""}${replayRecover.stderr || ""}`;
    // 光判那个码是【不够】的：拆掉"远端找不到这个提交"那道守卫之后，重放会继续往下走，
    // 控制面回 404 —— 而 404 同样算终局错误，同一个码照样出现，断言就绿了（实测如此）。
    // 所以要点到【具体是哪一句原因】：这一条守的是"推上去的东西没了"，不是"这个派发不存在"。
    if (!/checkpoint_replay_recover_required[^\n]*上找不到了/u.test(replayText)) {
      throw new Error("发件箱里那份检查点声称的提交在远端找不到了，agent 没有在【重放之前】认出来"
        + `（要人工恢复）—— 它会带着一份指向不存在提交的证据继续往下走（agent 输出：${replayText.slice(-400)}）`);
    }
    const recovered = readdirSync(outboxDir).filter((name) => name.includes(".recover-"));
    if (!recovered.length) {
      throw new Error("agent 说了要恢复，却没有把那份证据挪到 .recover- 文件里 —— "
        + "证据既没交上去、也没留在能找到的地方");
    }
    if (readdirSync(outboxDir).some((name) => name === `${ghostDispatchId}.json`)) {
      throw new Error("那份重放不了的检查点还留在发件箱里 —— 下一拍还会再试一遍，节点会一直被它卡住");
    }
    console.log("  ok  发件箱里「提交在远端找不到了」的检查点：挪进恢复区、报回控制面、不再重放"
      + "（checkpoint_replay_recover_required）");
  }





		  console.log("agent remote doctor ok: one-command join, checksum install, credential rotation, initialization, self-check (permission+integrity probe), remote MCP, control command ACK, project/session-level execution event stream, on-demand skill workset, dispatch, commit, push and checkpoint outbox replay, two-step evidence artifact registration, permission_report loop with safe-retry-point recovery, revoke pending+ACK requeue verified");
} finally {
  server.kill("SIGTERM");
  await waitForChildExit(server, 3000);
  rmSync(sandbox, {recursive: true, force: true});
  if (server.exitCode && server.exitCode !== 0 && stderr) process.stderr.write(stderr);
}

// 状态分片（state-store）与事件段（project-event-store）说的是【同一个项目的同一批数据】，
// 两边各自把 projectId 算成磁盘上的名字。这套算法此前在两个模块里各有一份逐字相同的实现，
// 只改一处就会让两边指向不同目录 —— 而这件事不报错：一边照常写，另一边把对方的文件
// 当野文件（「索引说有、存储给不出」那一族）。现在算法收在 lib/project-paths.mjs 一份，
// 这条断言看的是【真实落盘的名字】：同一个项目的状态分片与事件文件，前缀必须逐字相同。
function assertProjectShardAndEventFilesShareOneName() {
  const dir = join(runtimeDir, "project-db");
  if (!existsSync(dir)) throw new Error("project-db 目录不存在：状态分片与事件段都没落盘");
  const names = readdirSync(dir);
  const central = JSON.parse(readFileSync(join(runtimeDir, "control-plane-state.json"), "utf8"));
  const shardPrefixes = new Map();
  for (const entry of central.projectStateShards?.projects || []) {
    const file = String(entry.storageRef || "").split("/").pop() || "";
    if (file) shardPrefixes.set(entry.projectId, file.split(".")[0]);
  }
  const eventPrefixes = new Map();
  for (const name of names) {
    if (!name.includes(".execution-events")) continue;
    const prefix = name.split(".")[0];
    const indexPath = join(dir, `${prefix}.execution-events.index.json`);
    if (!existsSync(indexPath)) continue;
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    if (index.projectId) eventPrefixes.set(index.projectId, {prefix, fileId: index.fileId});
  }
  const compared = [];
  for (const [projectId, seen] of eventPrefixes) {
    const shardPrefix = shardPrefixes.get(projectId);
    if (!shardPrefix) continue;
    compared.push(projectId);
    if (shardPrefix !== seen.prefix) {
      throw new Error(`项目 ${projectId} 的状态分片与事件文件落在两个名字下：分片 ${shardPrefix} / 事件 ${seen.prefix}`);
    }
    if (seen.fileId !== seen.prefix) {
      throw new Error(`项目 ${projectId} 的事件索引自称 fileId=${seen.fileId}，而文件实际叫 ${seen.prefix}`);
    }
  }
  if (!compared.length) {
    throw new Error(`没有任何项目同时有状态分片和事件文件，这条断言什么都没核到（分片 ${shardPrefixes.size} 个、事件 ${eventPrefixes.size} 个）`);
  }
  console.log(`  ok  状态分片与事件文件同名：${compared.length} 个项目逐字比过（${compared.join("、")}）`);
}

function setupRepository() {
  mkdirSync(source, {recursive: true});
  execFileSync("git", ["init", "--bare", remote], {stdio: "pipe"});
  execFileSync("git", ["init", "-b", "main", source], {stdio: "pipe"});
  execFileSync("git", ["-C", source, "config", "user.email", "doctor@local"], {stdio: "pipe"});
  execFileSync("git", ["-C", source, "config", "user.name", "Doctor"], {stdio: "pipe"});
  writeFileSync(join(source, "README.md"), "# Agent Gateway Doctor\n");
  execFileSync("git", ["-C", source, "add", "README.md"], {stdio: "pipe"});
  execFileSync("git", ["-C", source, "commit", "-m", "Initialize Agent Gateway doctor repository"], {stdio: "pipe"});
  execFileSync("git", ["-C", source, "remote", "add", "origin", remote], {stdio: "pipe"});
  execFileSync("git", ["-C", source, "push", "origin", "HEAD:refs/heads/main"], {stdio: "pipe"});
}

function forceNodeCredentialNearExpiry(nodeId) {
  const path = join(runtimeDir, "control-plane-state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  const node = state.agentRuntimeNodes.find((item) => item.nodeId === nodeId);
  if (!node) throw new Error(`node not found for credential rotation test: ${nodeId}`);
  node.credentialExpiresAt = new Date(Date.now() + 60 * 1000).toISOString();
  node.updatedAt = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function stopAgentDaemon(workDir) {
  const pidFile = join(workDir, "run", "agent.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (pid > 0) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
}

function assertProbeProfileBlocks(profile) {
  const permission = profile?.permission;
  if (!permission || typeof permission !== "object") throw new Error("agent self-check profile is missing the §3.2 permission probe block");
  for (const field of ["os", "browser", "credentialHelper", "oauth", "network", "git", "db", "keychainSudo"]) {
    if (!permission[field] || typeof permission[field].status !== "string") throw new Error(`permission probe block missing field: ${field}`);
    if (typeof permission[field].toolDriven !== "boolean") throw new Error(`permission probe field ${field} did not annotate tool-driven detection`);
  }
  const integrity = profile?.integrity;
  if (!integrity || typeof integrity !== "object") throw new Error("agent self-check profile is missing the §3.2 integrity probe block");
  for (const field of ["runtimeDigest", "installerDigest", "configDigest", "sandboxMode"]) {
    if (typeof integrity[field] !== "string" || !integrity[field]) throw new Error(`integrity probe block missing field: ${field}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(String(integrity.runtimeDigest || ""))) throw new Error("integrity probe did not compute a runtime digest");
}

async function waitForPendingPermissionRequest(sessionToken, permission) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await json("/api/state", {token: sessionToken}).catch(() => null);
    const request = (state?.permissionRequests || []).find((item) => item.permission === permission && item.status === "pending_approval");
    if (request) return request;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error("pending permission request from the Agent Runtime did not appear");
}

function okSelfChecks(baseUrl, options = {}) {
  const checks = [
    {checkId: "runtime", status: "ok", detail: "doctor"},
    {checkId: "gateway", status: "ok", detail: baseUrl},
    {checkId: "filesystem", status: "ok", detail: "doctor"},
    {checkId: "git", status: "ok", detail: "doctor"},
    {checkId: "remote_mcp", status: "ok", detail: `${baseUrl}/mcp`}
  ];
  checks.push(options.modelExecutor === false
    ? {checkId: "model_executor", status: "failed", detail: "no model executor configured"}
    : {checkId: "model_executor", status: "ok", detail: "custom:doctor:available"});
  return checks;
}

function assertAgentScopedMcpConfig(workDir, baseUrl, expectedToken) {
  const configDir = join(workDir, "mcp-client-configs");
  const mcpConfigPath = join(configDir, "mcp-server.json");
  if (!existsSync(mcpConfigPath)) throw new Error(`Agent scoped MCP config was not generated: ${mcpConfigPath}`);
  const config = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
  const server = config.mcpServers?.ai_multi_agent_ctrl;
  if (config.transport !== "streamable-http" || config.hostedBy !== baseUrl || server?.url !== `${baseUrl}/mcp`) throw new Error("Agent scoped MCP config does not point at the centralized remote MCP endpoint");
  if (Object.prototype.hasOwnProperty.call(server, "command")) throw new Error("Agent scoped MCP config must not contain a local command");
  if (expectedToken && server.headers?.Authorization !== `Bearer ${expectedToken}`) throw new Error("Agent scoped MCP config was not refreshed after node credential rotation");
  for (const filename of ["codex_config.toml", "claude_desktop_config.json", "cursor_mcp.json"]) {
    if (!existsSync(join(configDir, filename))) throw new Error(`Agent scoped MCP client snippet missing: ${filename}`);
  }
}

async function json(path, options = {}) {
  const result = await jsonRaw(path, options);
  if (!result.response.ok) throw new Error(`${result.payload.error || "request_failed"}: ${result.payload.message || result.response.status}`);
  return result.payload;
}

async function jsonRaw(path, options = {}) {
  assertNoUndefinedInPayload(`${options.method || "GET"} ${path}`, options.body, options.allowUndefinedInPayload);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || (options.body ? "POST" : "GET"),
    headers: {accept: "application/json", ...(options.body ? {"content-type": "application/json"} : {}), ...(options.token ? {authorization: `Bearer ${options.token}`} : {}), ...(options.idempotencyKey ? {"idempotency-key": options.idempotencyKey} : {})},
    ...(options.body ? {body: JSON.stringify(options.body)} : {})
  });
  return {response, payload: await response.json()};
}

async function waitForHealth() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Agent Gateway health timeout: ${stderr}`);
}

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const selected = listener.address().port;
  listener.close();
  await once(listener, "close");
  return selected;
}
