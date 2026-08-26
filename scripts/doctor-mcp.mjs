import { spawn, spawnSync } from "node:child_process";
import { KNOWN_SECOND_DOORS, HUMAN_ONLY_MCP_TOOL_REFUSALS } from "./lib/known-second-doors.mjs";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertNoUndefinedInPayload } from "./lib/no-undefined-payload.mjs";
import { checkRecordStatusesAreDeclaredStates } from "./lib/state-machine-states.mjs";
import { readStoredState } from "../apps/control-plane-ui/lib/state-store.mjs";
import { projectRepositories } from "../apps/control-plane-ui/lib/control-plane-core.mjs";
import {waitForChildExit} from "./lib/child-tracking.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const port = await freePort();
const runtimeDir = mkdtempSync(join(tmpdir(), "aimac-mcp-doctor-runtime-"));
const configDir = mkdtempSync(join(tmpdir(), "aimac-mcp-doctor-config-"));
const token = "doctor-remote-mcp-service-token";
const baseUrl = `http://127.0.0.1:${port}`;
let requestId = 0;
const child = spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {
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
    AIMAC_STATE_STORE: "runtime_json",
    AIMAC_EXECUTION_PROFILE: "production",
    AIMAC_MCP_SERVICE_TOKEN: token,
    AIMAC_BOOTSTRAP_TOKEN: "doctor-bootstrap-token",
    DATABASE_URL: ""
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

try {
  await waitForHealth();
  const unauthenticated = await fetch(`${baseUrl}/mcp`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "initialize", params: {}})});
  if (unauthenticated.status !== 401) throw new Error(`remote MCP did not reject unauthenticated request: ${unauthenticated.status}`);
  // 「不带令牌」和「带一个错的令牌」是两条不同的路：前者在最外层就被挡下，后者要一路走到
  // 服务令牌摘要比对那一句。此前只测了前者 —— 实测把那句比对改成 `if (true)`（任何令牌都算
  // 服务主体，等于整个 MCP 面免鉴权），三套 e2e 无一报红。
  const bogusToken = await fetch(`${baseUrl}/mcp`, {method: "POST",
    headers: {"content-type": "application/json", authorization: "Bearer not-a-real-service-token"},
    body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/list", params: {}})});
  if (bogusToken.status !== 401) {
    throw new Error(`带一个错的令牌也被放行了（HTTP ${bogusToken.status}）—— `
      + "服务令牌比对失效时，任何人都能以服务主体身份调 MCP");
  }

  const initialized = await mcp("initialize", {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "doctor", version: "1"}});
  if (initialized.serverInfo?.name !== "ai-multi-agent-ctrl") throw new Error("remote MCP initialize failed");
  const listed = await mcp("tools/list", {});
  if (!Array.isArray(listed.tools) || listed.tools.length < 35) throw new Error("remote MCP service allowlist returned an incomplete integration surface");
  if (listed.tools.some((tool) => tool.name === "agent-control-mcp.runtime_run")) throw new Error("remote MCP still exposes server-side Agent execution");
  if (listed.tools.some((tool) => tool.name === "identity-mcp.grant_create" || tool.name === "governance-mcp.approval_request_create" || tool.name === "evidence-mcp.checkpoint_submit")) {
    throw new Error("remote MCP service token exposed high-risk admin or Agent checkpoint tools");
  }
  // 上面点名的是三个工具，而真实规则是【整族禁用】（forbiddenMcpServiceTool 里
  // identity-mcp.* 与 governance-mcp.* 是按前缀挡的）。抽样式断言在"规则被收窄成几个名字"时
  // 不会红 —— 而那正是这层防护最可能的塌法。这里按规则本身全量核对。
  // 这一族背后还有第二道门（决策点上按 principal.kind 拒机器主体），
  // 但那道门只有在工具能拿到时才起作用；这一条守的是第一道。
  // 【这一条没有登记变异】：治理面由两道独立过滤挡着（默认放行清单本来就不含它们，
  // 禁用清单再按前缀挡一次），单点改坏任一道，另一道都接住，工具表照样不漏 ——
  // 实测把前缀规则收窄成一个名字，这道门仍然绿。断言本身不空：它按【规则】枚举，
  // 而不是抽样三个名字，所以两道一起塌时它会红，规则被收窄时它也不会给出虚假的安全感。
  const leaked = listed.tools.map((tool) => tool.name)
    .filter((name) => name.startsWith("identity-mcp.") || name.startsWith("governance-mcp."));
  if (leaked.length) {
    throw new Error(`服务令牌的工具表里出现了整族禁用的工具：${leaked.join("、")} —— `
      + "identity/governance 这两族对机器主体是按前缀挡掉的，漏出来就等于把治理面交给了机器");
  }

  const health = await mcp("tools/call", {name: "ui-console-mcp.runtime_health_get", arguments: {}});
  if (health.isError || health.structuredContent?.result?.runtime?.mcp?.protocol !== "mcp/streamable-http") throw new Error("remote MCP health did not report centralized streamable HTTP");

  const unknownInput = await mcp("tools/call", {name: "ui-console-mcp.runtime_health_get", arguments: {unknownProperty: true}});
  if (unknownInput.structuredContent?.result?.error !== "mcp_input_unknown_property") throw new Error("MCP input schema did not reject unknown properties");

  // 入参校验的另外两支此前没有任何断言：类型不对、以及整个 arguments 根本不是对象。
  // 塌了的话，一个数组或一个字符串会被当成参数对象往下传，工具拿到的是 undefined ——
  // 而"缺省不得等于有利结果"这条在本仓已经撞过很多次。
  const wrongType = await mcp("tools/call", {name: "ui-console-mcp.runtime_health_get", arguments: {projectId: 12345}});
  if (wrongType.structuredContent?.result?.error !== "mcp_input_type_mismatch") {
    throw new Error("入参类型不对没有被拒："
      + `${JSON.stringify(wrongType.structuredContent?.result || null).slice(0, 140)}`
      + " —— 类型不符的值会被当成合法参数往下传");
  }
  const notAnObject = await mcp("tools/call", {name: "ui-console-mcp.runtime_health_get", arguments: ["不是对象"]});
  if (notAnObject.structuredContent?.result?.error !== "mcp_input_must_be_object") {
    throw new Error("arguments 传成数组没有被拒："
      + `${JSON.stringify(notAnObject.structuredContent?.result || null).slice(0, 140)}`
      + " —— 工具会拿到一堆 undefined，而不是被明确告知参数不对");
  }

  const missingIdempotency = await mcp("tools/call", {name: "room-mcp.room_send", arguments: {roomId: "room_doctor", payload: {text: "must fail"}}});
  if (missingIdempotency.structuredContent?.result?.error !== "idempotency_key_required") throw new Error("write MCP call without idempotencyKey was not rejected");

  // 建共享定义在 REST 与 MCP 上是【两份实现】，闭集守卫也就要各有各的判据。
  // core 这一份原先：definitionType 原样收、conflictPolicy 静默降级成默认策略 ——
  // 后者更隐蔽，调用方打错一个字拿到的是 201，而落下来的是另一个真实生效的策略。
  // 拒绝回执有两种落点：入口层的拒（idempotency_key_required 那种）落在 structuredContent.result，
  // 而 core 抛出来的拒走 isError 那条路、落在 content[0].text 里的一段 JSON。
  // 只读前者的话，抛错型守卫全都会被读成「回执是空的」—— 第一版就是这么误判的。
  const toolResult = (response) => {
    const structured = response?.structuredContent?.result;
    if (structured && Object.keys(structured).length) return structured;
    try { return JSON.parse(response?.content?.[0]?.text || "{}"); } catch { return {}; }
  };
  const bogusDefinitionType = await mcp("tools/call", {name: "definition-mcp.shared_definition_create",
    arguments: {idempotencyKey: "doctor-mcp-sdc-bogus-type", taskGroupId: "tg_runtime_management",
      definitionType: "termnology"}});
  const bogusTypeResult = toolResult(bogusDefinitionType);
  if (bogusTypeResult.error !== "shared_definition_type_not_recognized") {
    throw new Error("MCP 建共享定义：认不出的 definitionType 没有被拒（"
      + `${JSON.stringify(bogusTypeResult).slice(0, 160)}）—— 落下来的记录违反它自己声明的规范`);
  }
  if (!(bogusTypeResult.details?.supported || []).includes("terminology")) {
    throw new Error(`拒了却没说合法取值有哪些（${JSON.stringify(bogusTypeResult.details)}）—— agent 只能穷举重试`);
  }
  const bogusConflictPolicy = await mcp("tools/call", {name: "definition-mcp.shared_definition_create",
    arguments: {idempotencyKey: "doctor-mcp-sdc-bogus-policy", taskGroupId: "tg_runtime_management",
      conflictPolicy: "just_do_it"}});
  if (toolResult(bogusConflictPolicy).error !== "shared_definition_conflict_policy_not_recognized") {
    throw new Error("MCP 建共享定义：认不出的 conflictPolicy 没有被拒（"
      + `${JSON.stringify(toolResult(bogusConflictPolicy)).slice(0, 160)}）——`
      + " 静默降级成默认策略的话，打错一个字就是另一个真实生效的策略，而回执是成功");
  }
  // 正面对照走同一条路：合法取值必须建得出来，否则上面两条只是「这条路永远拒」。
  const legitDefinition = await mcp("tools/call", {name: "definition-mcp.shared_definition_create",
    arguments: {idempotencyKey: "doctor-mcp-sdc-legit", taskGroupId: "tg_runtime_management",
      definitionType: "api_contract", conflictPolicy: "owner_reconciles_then_republish"}});
  if (!toolResult(legitDefinition).sharedDefinition?.contractId) {
    throw new Error("合法取值也建不出共享定义（"
      + `${JSON.stringify(toolResult(legitDefinition)).slice(0, 200)}）—— 上面两条测不出那道门`);
  }

  const fullState = await mcp("tools/call", {name: "orchestration-mcp.state_get", arguments: {scope: "full"}});
  if (fullState.structuredContent?.result?.error !== "full_state_scope_not_allowed") throw new Error("state_get full scope was not denied");

  const stateBeforeDryRun = await mcp("tools/call", {name: "orchestration-mcp.state_get", arguments: {scope: "summary"}});
  const scopedProgressSnapshots = stateBeforeDryRun.structuredContent?.result?.progressSnapshots || [];
  if (!scopedProgressSnapshots.some((snapshot) => snapshot.scopeType === "project" && snapshot.scopeRef === "prj_control_plane") ||
      !scopedProgressSnapshots.some((snapshot) => snapshot.scopeType === "task_group" && snapshot.scopeRef === "tg_runtime_management")) {
    throw new Error("project-scoped MCP state_get dropped project/task-group progress snapshots");
  }
  const dryRun = await mcp("tools/call", {name: "room-mcp.room_send", arguments: {idempotencyKey: "doctor-room-dry-run", dryRun: true, roomId: "room_doctor", payload: {text: "dry run"}}});
  const stateAfterDryRun = await mcp("tools/call", {name: "orchestration-mcp.state_get", arguments: {scope: "summary"}});
  if (!dryRun.structuredContent?.result?.dryRun || stateBeforeDryRun.structuredContent?.stateVersion !== stateAfterDryRun.structuredContent?.stateVersion) throw new Error("write MCP dryRun changed stateVersion");

  const roomSend = await mcp("tools/call", {name: "room-mcp.room_send", arguments: {idempotencyKey: "doctor-room-send", roomId: "room_doctor", payload: {text: "remote MCP"}}});
  if (!roomSend.structuredContent?.result?.message?.messageId) throw new Error("remote MCP room_send failed");
  const idempotencyConflict = await mcp("tools/call", {name: "room-mcp.room_send", arguments: {idempotencyKey: "doctor-room-send", roomId: "room_doctor", payload: {text: "different"}}});
  if (idempotencyConflict.structuredContent?.result?.error !== "idempotency_key_reuse_conflict") throw new Error("MCP idempotency key reuse was not rejected");

  const badRepositoryTarget = await mcp("tools/call", {name: "repository-mcp.repository_output_target_select", arguments: {idempotencyKey: "doctor-bad-path", taskGroupId: "tg_runtime_management", workItemId: "work_bootstrap", artifactManifestPath: "/tmp/bad.json"}});
  if (badRepositoryTarget.structuredContent?.result?.error !== "repository_output_target_must_use_git_trackable_paths") throw new Error("MCP repository target selection accepted a non-git-trackable path");
  const invalidTaskGroupTarget = await mcp("tools/call", {name: "repository-mcp.repository_output_target_select", arguments: {idempotencyKey: "doctor-invalid-task-scope", taskGroupId: "tg_missing_scope", workItemId: "work_bootstrap", artifactManifestPath: "docs/artifact-manifests/doctor-invalid-task.json"}});
  if (invalidTaskGroupTarget.structuredContent?.result?.error !== "task_group_not_found") throw new Error("MCP repository target selection did not fail closed on an invalid taskGroupId");
  const invalidWorkItemTarget = await mcp("tools/call", {name: "repository-mcp.repository_output_target_select", arguments: {idempotencyKey: "doctor-invalid-work-scope", taskGroupId: "tg_runtime_management", workItemId: "work_missing_scope", artifactManifestPath: "docs/artifact-manifests/doctor-invalid-work.json"}});
  if (invalidWorkItemTarget.structuredContent?.result?.error !== "work_item_not_found") throw new Error("MCP repository target selection did not fail closed on an invalid workItemId");

  const selected = await mcp("tools/call", {name: "model-mcp.model_select", arguments: {idempotencyKey: "doctor-model-select", taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", roleId: "orchestrator"}});
  if (!selected.structuredContent?.result?.selectedModel) throw new Error("remote MCP write call did not execute");

  const targetResult = await mcp("tools/call", {name: "repository-mcp.repository_output_target_select", arguments: {idempotencyKey: "doctor-repository-target", targetId: "rot_doctor_remote_mcp", taskGroupId: "tg_runtime_management", workItemId: "work_bootstrap", artifactManifestPath: "docs/artifact-manifests/doctor-mcp.json"}});
  const targetId = targetResult.structuredContent?.result?.repositoryOutputTarget?.targetId;
  if (!targetId) throw new Error("remote MCP repository target was not created");
  const firstLease = await mcp("tools/call", {name: "resource-mcp.lease_claim", arguments: {idempotencyKey: "doctor-lease-1", repositoryOutputTargetRef: targetId, holderRef: "session:doctor-a"}});
  const lease = firstLease.structuredContent?.result?.lease;
  if (!lease?.fencingToken) throw new Error("remote MCP lease did not issue fencing token");
  const secondLease = await mcp("tools/call", {name: "resource-mcp.lease_claim", arguments: {idempotencyKey: "doctor-lease-2", repositoryOutputTargetRef: targetId, holderRef: "session:doctor-b"}});
  if (secondLease.structuredContent?.result?.error !== "lease_already_active") throw new Error("lease_claim allowed a second active holder");
  const wrongRelease = await mcp("tools/call", {name: "resource-mcp.lease_release", arguments: {idempotencyKey: "doctor-lease-release", leaseId: lease.leaseId, holderRef: "session:doctor-a", fencingToken: "wrong"}});
  // 精确相等而不是 includes：`lease_fencing_token_mismatch`（core 那道）是
  // `mcp_lease_fencing_token_mismatch`（MCP 那道）的**真子串** —— 原先用 includes，
  // 两道不同的门共用了一条判据，而实际拒它的一直是 MCP 那道，core 那道从没被这条验过。
  // 按实际落点写：这条守的是 MCP 侧的围栏令牌校验；core 那道由契约门里的 releaseLease 用例守。
  if (wrongRelease.structuredContent?.result?.error !== "mcp_lease_fencing_token_mismatch") {
    throw new Error(`换一个围栏令牌就把别人的租约释放掉了（${JSON.stringify(wrongRelease.structuredContent?.result || "").slice(0, 140)}）`);
  }
  // 围栏令牌对了，但报的持有者不是自己 —— 这道门此前没有任何断言。它守的是
  // "两个 agent 抢同一个产出目标"里最后一层：令牌可能被抄走（写在派发记录里、日志里），
  // 抄到令牌的人还得是登记的那个持有者才放行。
  const wrongHolder = await mcp("tools/call", {name: "resource-mcp.lease_release",
    arguments: {idempotencyKey: "doctor-lease-holder", leaseId: lease.leaseId,
      holderRef: "session:somebody-else", fencingToken: lease.fencingToken}});
  if (wrongHolder.structuredContent?.result?.error !== "mcp_lease_holder_mismatch") {
    throw new Error(`拿着正确的围栏令牌、报了别人的持有者，却把租约释放掉了`
      + `（${JSON.stringify(wrongHolder.structuredContent?.result || "").slice(0, 140)}）`
      + " —— 令牌一旦泄漏就没有第二道拦阻");
  }
  const wrongSession = await mcp("tools/call", {name: "resource-mcp.lease_release",
    arguments: {idempotencyKey: "doctor-lease-session", leaseId: lease.leaseId,
      holderRef: "session:doctor-a", sessionId: "sess-not-the-holder", fencingToken: lease.fencingToken}});
  if (wrongSession.structuredContent?.result?.error !== "mcp_lease_session_mismatch") {
    throw new Error(`用别的会话 id 就把租约释放掉了`
      + `（${JSON.stringify(wrongSession.structuredContent?.result || "").slice(0, 140)}）`);
  }
  // 正面对照：正确的持有者 + 正确的令牌必须能释放，否则上面两条可以靠"一律拒绝"蒙混过去。
  const rightRelease = await mcp("tools/call", {name: "resource-mcp.lease_release",
    arguments: {idempotencyKey: "doctor-lease-ok", leaseId: lease.leaseId,
      holderRef: "session:doctor-a", fencingToken: lease.fencingToken}});
  if (rightRelease.structuredContent?.result?.error) {
    throw new Error(`正确的持有者也释放不了租约（${JSON.stringify(rightRelease.structuredContent?.result).slice(0, 140)}）`
      + " —— 互斥把正常路径一起堵死了，产出目标会永远卡在被占用状态");
  }

  const admin = await api("/api/auth/login", {method: "POST", body: {email: "system.admin@local", token: "doctor-bootstrap-token"}});
  const missingProjectTaskGroup = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.task_group_create", arguments: {idempotencyKey: "doctor-mcp-task-create-missing-project", taskGroupId: "tg_doctor_missing_project", name: "Missing Project Scope"}});
  if (missingProjectTaskGroup.structuredContent?.result?.error !== "mcp_required_argument_missing" || missingProjectTaskGroup.structuredContent?.result?.argument !== "projectId") {
    throw new Error("MCP task_group_create without projectId was not rejected by input policy");
  }
  const normalizedTaskGroup = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.task_group_create", arguments: {idempotencyKey: "doctor-mcp-task-create", projectId: "prj_control_plane", taskGroupId: "tg_doctor_mcp_norm", name: "Doctor MCP normalized task group", languageTag: "en", roles: ["orchestrator", "agent-runtime"]}});
  const normalizedTask = normalizedTaskGroup.structuredContent?.result?.taskGroup;
  if (!normalizedTask?.roles?.every((role) => role.roleId && role.status === "ready" && role.skillBinding === "server_resolved_on_dispatch") || normalizedTask.languagePolicy?.languageTag !== "en") {
    throw new Error("MCP task_group_create did not normalize role bindings and language policy");
  }
  const normalizedWorkItem = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.work_item_create", arguments: {idempotencyKey: "doctor-mcp-work-create", taskGroupId: "tg_doctor_mcp_norm", workItemId: "work_doctor_mcp_norm", title: "Doctor MCP normalized work", ownerRole: "agent-runtime", requirements: ["return realtime event"]}});
  const normalizedWork = normalizedWorkItem.structuredContent?.result;
  if (normalizedWork?.workItem?.status !== "ready" || normalizedWork.workItem.ownerRole !== "agent-runtime" || !normalizedWork.taskGroup?.roles?.some((role) => role.roleId === "agent-runtime")) {
    throw new Error("MCP work_item_create did not normalize work item status and task group role binding");
  }
  // 未登记的角色必须在【创建这一刻】被拒。收下之后派发会静默绑上 orchestrator 的技能，
  // agent 按别人的角色规则干活，而人以为自己指定了角色 —— REST 侧早就这么做了，
  // 这一侧原先一点校验都没有（孪生分支只补一半）。
  {
    const bogusRole = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.work_item_create",
      arguments: {idempotencyKey: "doctor-mcp-bogus-role", taskGroupId: "tg_runtime_management",
        title: "角色写错的单元", ownerRole: "front-end-wizard"}});
    const said = JSON.stringify(bogusRole.structuredContent?.result || bogusRole);
    if (!said.includes("work_item_owner_role_not_registered")) {
      throw new Error(`MCP 侧收下了未登记的角色（派发时会静默绑上 orchestrator 的技能）：${said.slice(0, 200)}`);
    }
    if (!said.includes("registeredRoles")) {
      throw new Error(`拒绝时没有回登记过的角色清单 —— 调用方只能猜自己该填什么：${said.slice(0, 200)}`);
    }
  }
  // 与 REST 侧同规：自由文本有上限。少补这一侧，agent 一样能把状态撑大 ——
  // 这类洞最常见的样子就是孪生分支只补一半（REST 侧改完，MCP 侧照旧）。
  {
    const huge = "长".repeat(300000);
    const bigObjective = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.task_group_create",
      arguments: {idempotencyKey: "doctor-mcp-huge-objective", projectId: "prj_control_plane",
        title: "超长目标探针", objective: huge}});
    const said = JSON.stringify(bigObjective.structuredContent?.result || bigObjective);
    if (!said.includes("task_group_objective_too_long")) {
      throw new Error(`MCP 侧收下了 30 万字的任务组目标 —— 状态会被它永久撑大：${said.slice(0, 200)}`);
    }
    if (!said.includes("limit") || !said.includes("actual")) {
      throw new Error(`拒绝时没把上限与实际长度回给调用方：${said.slice(0, 200)}`);
    }
  }

  // 数组那扇门同理，MCP 侧也要有上限。
  {
    const tooMany = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.work_item_create",
      arguments: {idempotencyKey: "doctor-mcp-too-many-reqs", taskGroupId: "tg_runtime_management",
        title: "条数探针", requirements: Array.from({length: 50000}, (unused, index) => `要求 ${index}`)}});
    const said = JSON.stringify(tooMany.structuredContent?.result || tooMany);
    if (!said.includes("work_item_requirements_too_many_items")) {
      throw new Error(`MCP 侧收下了 5 万条机器可执行要求：${said.slice(0, 180)}`);
    }
  }

  // agent 问"我这个角色的规则是什么"。这个视图原先自己实现了一遍匹配：子串命中、
  // 都找不到就落到 roleSkills[0]（数组顺序由技能源同步决定，实质任意），而且回退不留痕 ——
  // 拿到别人的规则却毫不知情。改成走 core 的 resolveRoleSkill，三支都验。
  {
    // ① 未登记的角色：当场拒，而不是把别人的技能给它。
    const unknownRole = await mcpAs(admin.sessionToken, "tools/call", {name: "skill-mcp.role_skill_resolve",
      arguments: {roleId: "front-end-wizard"}});
    const unknownSaid = JSON.stringify(unknownRole.structuredContent?.result || unknownRole);
    if (!unknownSaid.includes("role_skill_role_not_registered")) {
      throw new Error(`未登记的角色被解析出了技能 —— agent 会按别人的规则干活：${unknownSaid.slice(0, 200)}`);
    }
    // ② 已登记但没有专属技能文件的角色：回退到通用技能，但必须留痕。
    const noOwnSkill = await mcpAs(admin.sessionToken, "tools/call", {name: "skill-mcp.role_skill_resolve",
      arguments: {roleId: "repository-router"}});
    const fellBack = noOwnSkill.structuredContent?.result;
    if (!fellBack?.roleSkill?.roleSkillId) {
      throw new Error(`已登记的角色解析不出技能（应回退到通用技能）：${JSON.stringify(fellBack).slice(0, 200)}`);
    }
    if (fellBack.roleSkillFallback?.reason !== "role_has_no_dedicated_skill") {
      throw new Error("回退到别人的技能却不留痕 —— agent 会以为这就是自己角色的规则："
        + JSON.stringify(fellBack).slice(0, 200));
    }
    // ③ 有专属技能的角色不能被误标成回退，否则这个标记就成了没人看的噪音。
    const ownRole = await mcpAs(admin.sessionToken, "tools/call", {name: "skill-mcp.role_skill_resolve",
      arguments: {roleId: "orchestrator"}});
    if (ownRole.structuredContent?.result?.roleSkillFallback) {
      throw new Error("有专属技能的角色被误标成了回退 —— 这个标记会变成没人看的噪音");
    }
  }

  // 同一条通道上的老毛病：拒绝报文里的 details 此前被整层丢掉，只剩一个错误码。
  // work_item_status_unknown 特意写了 supported 清单，从加上到现在一次都没送出去过。
  {
    const bogusStatus = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.work_item_create",
      arguments: {idempotencyKey: "doctor-mcp-bogus-status", taskGroupId: "tg_runtime_management",
        title: "状态写错的单元", status: "in_progress"}});
    const said = JSON.stringify(bogusStatus.structuredContent?.result || bogusStatus);
    if (!said.includes("work_item_status_unknown") || !said.includes("supported")) {
      throw new Error(`状态填错时没把合法取值回给调用方：${said.slice(0, 200)}`);
    }
  }

  // 「不显式说 false 就当允许」这一族：这个工具原先是 `args.allowed !== false`，
  // 不给就是允许，而且想拒绝时传字符串 "false" 也会变成允许（!== false 只认布尔）。
  // 允许那一支会跑完整个命令生命周期、落一条 accepted 命令并给出 policyDecisionRef。
  // 用管理员会话打：服务令牌没被授予这个工具（mcp_tool_not_granted_to_principal 会先拒），
  // 拿它验的话，验到的是工具白名单那道门，不是这一条。
  // 两种形态由【两道不同的门】接住，各自点名，别混成一句：
  //   · 不给 → 本条新加的 guarded_action_verdict_required；
  //   · 传字符串 "false" → 更靠前的入参类型校验（入参字典把 allowed 声明成 boolean）。
  // 后者正是 REST 那侧【没有】的一层，所以同一族在 /api/policy-decisions/evaluate 上要单独验。
  for (const [label, extra, code] of [["不给判决", {}, "guarded_action_verdict_required"],
    ["判决传成字符串", {allowed: "false"}, "mcp_input_type_mismatch"]]) {
    const verdict = await mcpAs(admin.sessionToken, "tools/call", {name: "ui-console-mcp.guarded_action_dispatch",
      arguments: {action: "probe_action", idempotencyKey: `mcp-verdict-${encodeURIComponent(label)}`, ...extra}});
    if (verdict.structuredContent?.result?.error !== code) {
      throw new Error(`记受守卫动作时「${label}」必须被拒：`
        + `${JSON.stringify(verdict.structuredContent?.result || null).slice(0, 160)}`
        + `（应为 ${code}）—— 缺省或非布尔都不该被当成允许`);
    }
  }


  const foreignProject = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.project_create", arguments: {idempotencyKey: "doctor-foreign-project", projectId: "prj_foreign_scope", name: "Doctor Foreign Scope", repositoryRefs: ["https://git.example.com/foreign/scope.git"]}});
  const foreignProjectResult = foreignProject.structuredContent?.result;
  if (!foreignProjectResult?.project?.id || foreignProjectResult.ownerGrant?.subjectRef?.subjectId !== "acct_workspace_owner" || !foreignProjectResult.ownerGrant?.permissions?.includes("task_group:control")) {
    throw new Error("system admin MCP could not create a foreign project with owner grant");
  }
  // 登记的仓库必须被【真正的读者】看见。断言不查字段名，直接调准入判定/提交目标共用的
  // projectRepositories()：此前 MCP 把它写在 repositoryRefs 上，那个字段全仓一个读者都没有，
  // 于是"登记了仓库"等于没登记 —— 单元照样被 project_repository_not_registered 挡住。
  if (!projectRepositories(foreignProjectResult.project)
        .some((repo) => repo?.url === "https://git.example.com/foreign/scope.git")) {
    throw new Error("MCP 建项目时登记的仓库，准入判定读不到（projectRepositories 返回："
      + `${JSON.stringify(projectRepositories(foreignProjectResult.project)).slice(0, 200)}）`);
  }
  const foreignTask = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.task_group_create", arguments: {idempotencyKey: "doctor-foreign-task", projectId: "prj_foreign_scope", taskGroupId: "tg_foreign_scope", name: "Doctor Foreign Task", roles: ["orchestrator"]}});
  if (!foreignTask.structuredContent?.result?.taskGroup?.id) throw new Error("system admin MCP could not create a foreign task group");
  const foreignWork = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.work_item_create", arguments: {idempotencyKey: "doctor-foreign-work", taskGroupId: "tg_foreign_scope", workItemId: "work_foreign_scope", title: "Doctor Foreign Work", ownerRole: "orchestrator"}});
  if (!foreignWork.structuredContent?.result?.workItem?.id) throw new Error("system admin MCP could not create a foreign work item");

  // 跨参数一致性守卫（validateExplicitMcpScopeExists）：调用方同时给作用域 id 和对象 id 时，
  // 那个对象必须真属于该作用域 —— 防的是"拿自己有权的项目，配上别人的任务组/工作项/派发 id"。
  // 这一族此前【一条判据都没有】：它失效时所有正常调用照旧成功，只有跨租户那一次会悄悄通过。
  // 复用上面那个 foreignWork：自己再建一个会跟它撞同一个幂等键，把【既有】那条断言打红
  //（第一版就是这样）—— 探针不要跟既有夹具抢资源。
  {
    const foreignTaskGroupId = foreignTask.structuredContent.result.taskGroup.id;
    const foreignWorkId = foreignWork.structuredContent.result.workItem.id;
    // 本项目的 projectId 配隔壁项目的 taskGroupId：必须被拒。
    // （第一版只给 workItemId，被更早的"缺 taskGroupId"挡住 —— 工作项那条检查只在
    //   没给 taskGroupId 时才生效，而 model_select 必须带它。报文里印出错误码才看出来。）
    const mixed = await mcpAs(admin.sessionToken, "tools/call", {name: "model-mcp.model_select",
      arguments: {idempotencyKey: "doctor-mixed-scope", projectId: "prj_control_plane",
        taskGroupId: foreignTaskGroupId, workItemId: foreignWorkId, roleId: "orchestrator"}});
    const mixedSaid = JSON.stringify(mixed.structuredContent?.result || mixed);
    if (!mixedSaid.includes("task_group_project_scope_mismatch")) {
      throw new Error(`把隔壁项目的任务组配上本项目的 projectId，居然通过了：${mixedSaid.slice(0, 200)}`);
    }
    // 反向：任务组配它【自己】的项目必须照常通过 —— 守卫不能把正当调用一起挡掉。
    const consistent = await mcpAs(admin.sessionToken, "tools/call", {name: "model-mcp.model_select",
      arguments: {idempotencyKey: "doctor-consistent-scope", projectId: foreignProjectResult.project.id,
        taskGroupId: foreignTaskGroupId, workItemId: foreignWorkId, roleId: "orchestrator"}});
    const consistentSaid = JSON.stringify(consistent.structuredContent?.result || consistent);
    if (consistentSaid.includes("scope_mismatch")) {
      throw new Error(`任务组与它自己的项目配在一起也被拒了 —— 守卫过头：${consistentSaid.slice(0, 200)}`);
    }
  }
  const foreignPermissionRequest = await mcp("tools/call", {name: "permission-mcp.permission_request_submit", arguments: {idempotencyKey: "doctor-foreign-permission-resource", resource: {resourceType: "task_group", resourceId: "tg_foreign_scope"}, permission: "task_group:control", reason: "must fail closed on nested resource scope"}});
  if (foreignPermissionRequest.structuredContent?.result?.error !== "mcp_principal_project_scope_mismatch") {
    throw new Error("MCP service token accepted nested permission resource outside its project scope");
  }
  const foreignTarget = await mcpAs(admin.sessionToken, "tools/call", {name: "repository-mcp.repository_output_target_select", arguments: {idempotencyKey: "doctor-foreign-target", targetId: "rot_doctor_foreign_scope", projectId: "prj_foreign_scope", taskGroupId: "tg_foreign_scope", workItemId: "work_foreign_scope", artifactManifestPath: "docs/artifact-manifests/doctor-foreign-scope.json"}});
  const foreignTargetId = foreignTarget.structuredContent?.result?.repositoryOutputTarget?.targetId;
  if (!foreignTargetId) throw new Error("system admin MCP could not create a foreign-scope repository target");
  const foreignLeaseClaim = await mcpAs(admin.sessionToken, "tools/call", {name: "resource-mcp.lease_claim", arguments: {idempotencyKey: "doctor-foreign-lease", repositoryOutputTargetRef: foreignTargetId, holderRef: "session:doctor-foreign"}});
  const foreignLease = foreignLeaseClaim.structuredContent?.result?.lease;
  if (!foreignLease?.leaseId) throw new Error("system admin MCP could not create a foreign-scope lease");
  const foreignRelease = await mcp("tools/call", {name: "resource-mcp.lease_release", arguments: {idempotencyKey: "doctor-foreign-release-service-token", leaseId: foreignLease.leaseId, holderRef: "session:doctor-foreign", fencingToken: foreignLease.fencingToken}});
  if (foreignRelease.structuredContent?.result?.error !== "mcp_principal_project_scope_mismatch") {
    throw new Error("MCP service token released a lease outside its project scope when only leaseId was supplied");
  }

  const registration = spawnSync(process.execPath, ["scripts/register-mcp-client.mjs", `--server-url=${baseUrl}`, `--output-dir=${configDir}`], {
    cwd: root,
    env: {...process.env, AIMAC_MCP_BEARER_TOKEN: token},
    encoding: "utf8"
  });
  if (registration.status !== 0) throw new Error(`remote MCP registration failed: ${registration.stderr}`);
  const generated = JSON.parse(readFileSync(join(configDir, "mcp-server.json"), "utf8"));
  const entry = generated.mcpServers.ai_multi_agent_ctrl;
  if (generated.mcpServers["ai-multi-agent-ctrl"] || entry?.url !== `${baseUrl}/mcp` || entry.command || generated.transport !== "streamable-http") throw new Error("MCP client registration did not generate a remote-only endpoint");

  // 只跑成功路径的门看不见这个脚本对人说的话 —— 而它此前每一条失败路径都是一段 Node 崩溃栈
  // （源码行 + 尖角 + 堆栈，全英文）。这里真的把它跑失败，读它对运维说了什么。
  const runRegister = (argv) => spawnSync(process.execPath, ["scripts/register-mcp-client.mjs", ...argv],
    {cwd: root, env: {...process.env, AIMAC_MCP_BEARER_TOKEN: token}, encoding: "utf8"});
  for (const [why, argv, expected] of [
    ["参数名打错", ["--aply"], "认不出这些参数"],
    // 这条原先炸在 node:internal/url 里，连"是哪个参数"都不说。
    ["地址不是 URL", ["--server-url=notaurl"], "不是一个合法的 URL"],
    ["明文远程地址", ["--server-url=http://example.com"], "必须走 HTTPS"]
  ]) {
    const failed = runRegister(argv);
    if (failed.status !== 1 || /\bat \w+\.<anonymous>|at Object\.|node:internal/u.test(String(failed.stderr))) {
      throw new Error(`register-mcp-client ${why}时应给人话而不是崩溃栈（退出码 ${failed.status}）：`
        + String(failed.stderr || failed.stdout).slice(0, 200));
    }
    if (!String(failed.stderr).includes(expected)) {
      throw new Error(`register-mcp-client ${why}时没说清是什么问题，期望提到「${expected}」：`
        + String(failed.stderr).slice(0, 200));
    }
    if (!/·/u.test(String(failed.stderr))) {
      throw new Error(`register-mcp-client ${why}时只报了结论、没给下一步 —— 人不知道该改什么`);
    }
  }

  // 只读工具的跨租户扫描：不逐个工具想"它会不会漏"，而是拿一个【绑定在项目 A 的节点】身份，
  // 把每个只读工具都用【项目 B 的 id】调一遍，再在响应里全文搜 B 的 id。
  // 现有排查法是"过一遍所有 read-only MCP 工具"——逐条，靠人记得；这一条对将来新增的工具自动生效。
  const scanProject = await api("/api/projects", {method: "POST", idempotencyKey: "mcp-scan-project", token: admin.sessionToken,
    body: {name: "隔壁项目", key: "mcp-scan-foreign"}});
  const scanProjectId = scanProject.id || scanProject.project?.id;
  const scanGroup = await api("/api/task-groups", {method: "POST", idempotencyKey: "mcp-scan-tg", token: admin.sessionToken,
    body: {projectId: scanProjectId, title: "隔壁任务组"}});
  const scanGroupId = scanGroup.taskGroup?.id || scanGroup.id;
  if (!scanProjectId || !scanGroupId) throw new Error("跨租户扫描造不出隔壁项目 —— 本条在空转");
  // 隔壁项目里也要有一个工作项：下面"按工作项反查归属"那一维，需要一个【存在、但属于别的项目】的
  // 工作项 id，而且调用时【不能】带 taskGroupId（带了就走上一层的判据，走不到反查那一支）。
  const scanWorkItem = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.work_item_create",
    arguments: {idempotencyKey: "mcp-scan-wi", taskGroupId: scanGroupId, workItemId: "work_scan_foreign",
      title: "隔壁工作项", ownerRole: "agent-runtime"}});
  const scanWorkItemId = scanWorkItem.structuredContent?.result?.workItem?.id;
  if (!scanWorkItemId) throw new Error("隔壁项目里造不出工作项 —— '按工作项反查归属'那一维会在空转");
  const joined = await api("/api/agent-join-tokens", {method: "POST", idempotencyKey: "mcp-scan-jt", token: admin.sessionToken,
    body: {projectId: "prj_control_plane", nodeName: "mcp-scan-node", allowedRoles: ["*"], ttlSeconds: 1800, maxUses: 1}});
  const registered = await api("/api/agent/v1/register", {method: "POST", idempotencyKey: "mcp-scan-reg", token: joined.joinToken,
    body: {nodeName: "mcp-scan-node", requestedRoles: ["*"], runtimeVersion: "doctor",
      profile: {tools: [], models: [{providerClass: "custom", adapter: "doctor", available: true}]}}});
  const nodeToken = registered.nodeToken;
  if (!nodeToken) throw new Error("跨租户扫描拿不到节点令牌 —— 本条在空转");
  await api("/api/agent/v1/self-check", {method: "POST", token: nodeToken,
    body: {runtimeVersion: "doctor", checks: [
      {checkId: "runtime", status: "ok", detail: "doctor"}, {checkId: "gateway", status: "ok", detail: baseUrl},
      {checkId: "filesystem", status: "ok", detail: "doctor"}, {checkId: "git", status: "ok", detail: "doctor"},
      {checkId: "remote_mcp", status: "ok", detail: `${baseUrl}/mcp`},
      {checkId: "model_executor", status: "ok", detail: "custom:doctor:available"}]}});
  await api("/api/orchestrator/run", {method: "POST", idempotencyKey: "mcp-scan-cycle", token: admin.sessionToken,
    body: {mode: "all", autoSyncSkills: false}});
  const claimed = await api("/api/agent/v1/dispatches/next", {method: "POST", token: nodeToken, body: {}});
  // 没领到活就没有授权，只读工具全都会以 ok:false 收场 —— 那样这段扫描什么都没验到。
  if (!claimed.dispatch) throw new Error(`跨租户扫描的节点没领到派发（${claimed.reason || "无原因"}）—— 没有授权，所有只读工具都会直接报错，本条在空转`);
  // 认领返回的是一整个派发包，派发本身在 .dispatch.dispatch 下。原先取 claimed.dispatch.taskGroupId
  // 恒为 undefined，于是下面"三种入参"里的第三种 {taskGroupId: undefined} 序列化后等同于空参 ——
  // 这段扫描的自述说验了三种，实际只验过两种。取错一层不会报错，只会静静少验一种形态。
  const grantedTaskGroupId = claimed.dispatch.dispatch?.taskGroupId;
  if (!grantedTaskGroupId) throw new Error("跨租户扫描拿不到本节点被授权的任务组 id —— 第三种入参会退化成空参，本条少验一种形态");
  // 跨参数的作用域一致性：报文里同时出现 dispatchId / targetId / resource 与 projectId / taskGroupId /
  // workItemId 时，后者必须与前者【真实的归属】对得上。对不上却放行，等于调用方可以拿一个自己有权的
  // 上层 id 去操作别人的下层资源 —— 这一族九个码原先只有一个被点过名。
  // 九条按同一形状表驱动：换一个字段就必须换一个码，报文分不清是哪一维时人只能逐个试。
  {
    const d = claimed.dispatch.dispatch;
    const scopeCases = [
      ["派发的项目对不上", "agent-control-mcp.dispatch_status",
        {dispatchId: d.dispatchId, projectId: scanProjectId}, "dispatch_project_scope_mismatch"],
      ["派发的任务组对不上", "agent-control-mcp.dispatch_status",
        {dispatchId: d.dispatchId, taskGroupId: scanGroupId}, "dispatch_task_group_scope_mismatch"],
      ["派发的工作项对不上", "agent-control-mcp.dispatch_status",
        {dispatchId: d.dispatchId, workItemId: "work_bootstrap"}, "dispatch_work_item_scope_mismatch"],
      ["产出目标的项目对不上", "repository-mcp.repository_target_lease_bind",
        {idempotencyKey: "scope-tgt-p", targetId, holderRef: "session:x", projectId: scanProjectId},
        "repository_target_project_scope_mismatch"],
      ["产出目标的任务组对不上", "repository-mcp.repository_target_lease_bind",
        {idempotencyKey: "scope-tgt-g", targetId, holderRef: "session:x", taskGroupId: scanGroupId},
        "repository_target_task_group_scope_mismatch"],
      ["产出目标的工作项对不上", "repository-mcp.repository_target_lease_bind",
        {idempotencyKey: "scope-tgt-w", targetId, holderRef: "session:x", workItemId: "work_permissions"},
        "repository_target_work_item_scope_mismatch"],
      ["资源是项目、而 projectId 指向别处", "resource-mcp.lease_claim",
        {idempotencyKey: "scope-res-p", targetId, resourceType: "project", resourceId: scanProjectId, projectId: "prj_control_plane"},
        "resource_project_scope_mismatch"],
      ["资源是任务组、而 taskGroupId 指向别处", "resource-mcp.lease_claim",
        {idempotencyKey: "scope-res-g", targetId, resourceType: "task_group", resourceId: scanGroupId, taskGroupId: "tg_runtime_management"},
        "resource_task_group_scope_mismatch"],
      // 这一维只有在【不给 taskGroupId】时才走得到（给了就走上一层判据）。所以要挑一个
      // 必填里没有 taskGroupId 的工具 —— work_assign 强制要求它，用它永远到不了这一支。
      ["工作项的项目对不上（不给任务组时按工作项反查归属）", "agent-control-mcp.dispatch_status",
        {dispatchId: d.dispatchId, workItemId: scanWorkItemId, projectId: "prj_control_plane"},
        "work_item_project_scope_mismatch"],
      ["资源是项目、而随附的任务组属于别的项目", "resource-mcp.lease_claim",
        {idempotencyKey: "scope-res-gp", targetId, resourceType: "project", resourceId: scanProjectId, taskGroupId: "tg_runtime_management"},
        "resource_task_group_project_scope_mismatch"]
    ];
    for (const [label, name, args, expected] of scopeCases) {
      const result = await mcp("tools/call", {name, arguments: args});
      const actual = result.structuredContent?.result?.error;
      if (actual !== expected) {
        throw new Error(`跨参数作用域：${label} 没有被拒成 ${expected}（实际：${actual || JSON.stringify(result.structuredContent?.result || "").slice(0, 120)}）`
          + " —— 拿一个自己有权的上层 id 就能操作别人的下层资源，或者报文分不清是哪一维对不上");
      }
    }
    console.log(`MCP 跨参数作用域一致性 ok: ${scopeCases.length} 种错配各自被拒成它自己的码（派发/产出目标/资源 × 项目/任务组/工作项）`);

  }

  // 建组有两份实现（REST 的 createTaskGroupRecord 与这里的 createTaskGroup）。归档判据只补一份，
  // 就是本仓最常见的那种洞 —— 这一条守 MCP 那一份。
  {
    const archProject = await api("/api/projects", {method: "POST", idempotencyKey: "mcp-arch-project",
      token: admin.sessionToken, body: {name: "MCP 归档探针项目", key: "mcp-archive-probe"}});
    const archProjectId = archProject.id || archProject.project?.id;
    if (!archProjectId) throw new Error("MCP 归档探针造不出项目 —— 本条在空转");
    await api(`/api/projects/${archProjectId}/archive`, {method: "POST", idempotencyKey: "mcp-arch",
      token: admin.sessionToken, body: {}});
    const afterArchive = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.task_group_create",
      arguments: {idempotencyKey: "mcp-arch-tg", projectId: archProjectId, title: "归档后新建"}});
    if (afterArchive.structuredContent?.result?.error !== "project_archived") {
      throw new Error(`MCP 侧在已归档的项目里还能新建任务组（${JSON.stringify(afterArchive.structuredContent?.result || "").slice(0, 150)}）`
        + " —— 两份建组实现只补了 REST 那一份");
    }
  }

  // 跨租户存在性探针：受限节点问一个 id，"查无此物"与"存在但属于别的租户"必须给【同一个答案】。
  // 两者可分辨的话，拿一批 id 试一遍就知道这套部署里别的租户有没有它们 ——
  // REST 侧早把这条写成了口径（"别的组织有没有这个账号会从 403 与 404 的差别里漏出去"），
  // 这里守的是同一条不变式在 MCP 侧的那一半。
  for (const [tool, key, foreignId] of [
    ["ui-console-mcp.task_group_progress_get", "taskGroupId", scanGroupId],
    ["ui-console-mcp.project_progress_get", "projectId", scanProjectId]
  ]) {
    const answers = [];
    for (const id of [`${key}_never_existed`, foreignId]) {
      const r = await mcpAs(nodeToken, "tools/call", {name: tool, arguments: {[key]: id}});
      answers.push(r.structuredContent?.result?.error || JSON.stringify(r.structuredContent?.result || "").slice(0, 80));
    }
    if (answers[0] !== answers[1]) {
      throw new Error(`${tool}：受限节点问"不存在的 id"得到 ${answers[0]}、问"别的租户里真有的 id"得到 ${answers[1]}`
        + " —— 两者可分辨，这个报文就是一台跨租户存在性探针");
    }
    // 正面对照：这两条不能靠"一律回同一个码"蒙混 —— 系统管理员本就有权知道什么存在，必须仍分得清。
    // 实测：把上面那个"受限主体"条件改成恒真时，先响的是本文件更早那条服务令牌断言
    // （它要求无效 taskGroupId 仍回 task_group_not_found）。所以这条正面对照的判别力是【叠在它上面】的，
    // 不是独立证明的 —— 记在这里，免得以后误以为它自己验过了。
    const adminMissing = await mcpAs(admin.sessionToken, "tools/call", {name: tool, arguments: {[key]: `${key}_never_existed`}});
    const adminForeign = await mcpAs(admin.sessionToken, "tools/call", {name: tool, arguments: {[key]: foreignId}});
    if (adminMissing.structuredContent?.result?.error === adminForeign.structuredContent?.result?.error) {
      throw new Error(`${tool}：系统管理员问"不存在"和"别处真有"拿到了同一个答案 —— 越权与不存在被一锅端，`
        + "运维再也分不清是打错了 id 还是权限不对");
    }
  }
  console.log("MCP 跨租户存在性 ok: 受限节点分辨不出别的租户有没有某个任务组/项目，而系统管理员仍分得清");

  // 受限节点的授权边界：工具在白名单里，但入参指向【别的任务组】的房间 —— 必须按作用域拒掉。
  // （这条此前没有任何门点过名。上面那三种入参的扫描只验"不许带出隔壁内容"，验的是读；这条验写。）
  const crossRoom = await mcpAs(nodeToken, "tools/call", {name: "room-mcp.room_send",
    arguments: {roomId: `room_${scanGroupId}`, payload: {text: "越界"}, idempotencyKey: "mcp-cross-room"}});
  if (crossRoom.structuredContent?.result?.error !== "mcp_grant_scope_mismatch") {
    throw new Error(`受限节点往隔壁任务组的房间里发言没有被按作用域拒掉（实际：${JSON.stringify(crossRoom.structuredContent?.result || "").slice(0, 200)}）`
      + " —— 派发绑定的授权形同虚设，一个节点可以对任何任务组说话");
  }
  // 正面对照：往【自己被授权的】任务组房间里发言必须成功，否则上面那条可以靠"一律拒绝"蒙混过去。
  const ownRoom = await mcpAs(nodeToken, "tools/call", {name: "room-mcp.room_send",
    arguments: {roomId: `room_${grantedTaskGroupId}`, payload: {text: "本组"}, idempotencyKey: "mcp-own-room"}});
  if (!ownRoom.structuredContent?.result?.message?.messageId) {
    throw new Error(`受限节点在自己被授权的房间里也发不了言（${JSON.stringify(ownRoom.structuredContent?.result || "").slice(0, 200)}）—— 作用域把正常路径一起堵死了`);
  }
  // 【人工定稿闸门在 MCP 这一侧的牙齿】。这五道守卫此前只有 validate-specs 里的源码字面断言 ——
  // 也就是说，把 `if (principal.kind === "agent_node")` 整段删掉，只要注释里的那行字还在，
  // 门就照绿。它们挡的是：机器主体自己改规则层、自己批权限申请、自己发布契约、自己拉人进来。
  //
  // 实测发现其中四条对【唯一够得着的机器主体】是第二道门：工具白名单先回
  // mcp_tool_not_granted_to_principal，走不到守卫。allowedMcpTools:["*"] 的 system_service
  // 只存在于本地 stdio 通道，而本部署把 stdio 启动整个禁掉了（下面另有断言钉住这一点）。
  // 所以这里分两支：够得着的必须逐字对上拒绝码；够不着的登记为"白名单先拒"，
  // 并且【一旦将来白名单放开就会自动落进上一支】——那正是这张表存在的理由。
  {
    // 入参只求能通过校验（校验排在守卫之前）；期望的拒绝码按工具名从登记册里查，
    // 不在本文件里写码的字面量。
    const HUMAN_ONLY_ARGS = {
      "skill-mcp.skill_source_sync": {sourceId: "agency-agents-zh", idempotencyKey: "mcp-human-only-1"},
      "skill-mcp.role_skill_overlay_validate": {roleSkillRef: "ui-console-engineer", idempotencyKey: "mcp-human-only-2"},
      "permission-mcp.permission_resolve": {requestId: "prq_probe", idempotencyKey: "mcp-human-only-3"},
      "governance-mcp.contract_publish": {contractId: "ctr_probe", idempotencyKey: "mcp-human-only-4"},
      "identity-mcp.account_invite": {email: "probe@local", idempotencyKey: "mcp-human-only-5"},
      // 实测：受限节点根本调不到它（工具白名单先回 mcp_tool_not_granted_to_principal），
      // 所以它落进下面的"第二道门"那一支，拒绝码登记在 KNOWN_SECOND_DOORS 里。
      "human-review-mcp.confirmation_decide": {requestId: "hcr_probe", selectedOptionId: "accept",
        action: "finalize", idempotencyKey: "mcp-human-only-6"},
      // 2026-08-26 人定收归真人的授权面。入参要给【够得着的合法值】：给 undefined 的话
      // 会先被入参校验拒掉，看起来像验过了，其实验的是另一道门。
      "identity-mcp.grant_create": {subjectId: "acct_agent_runtime",
        resource: {resourceType: "task_group", resourceId: "tg_runtime_management"},
        idempotencyKey: "mcp-human-only-7"},
      "identity-mcp.grant_revoke": {grantId: "grant_probe", idempotencyKey: "mcp-human-only-8"}
    };
    const HUMAN_ONLY_TOOLS = Object.entries(HUMAN_ONLY_MCP_TOOL_REFUSALS)
      .map(([name, code]) => ({name, code, args: HUMAN_ONLY_ARGS[name]}));
    if (HUMAN_ONLY_TOOLS.some((tool) => !tool.args)) {
      throw new Error("人工专属工具登记册里多了一个工具，但这里没给它入参 —— 那一条会用 undefined 调过去，"
        + "被入参校验拒掉，看起来像验过了");
    }
    const slipped = [];
    const behindWhitelist = [];
    for (const tool of HUMAN_ONLY_TOOLS) {
      let result;
      try {
        const call = await mcpAs(nodeToken, "tools/call", {name: tool.name, arguments: tool.args});
        result = call.structuredContent?.result;
      } catch (error) {
        behindWhitelist.push(`${tool.name}（传输层拒：${String(error?.message || error).slice(0, 40)}）`);
        continue;
      }
      if (result?.error === "mcp_tool_not_granted_to_principal") {
        behindWhitelist.push(tool.name);
        continue;
      }
      if (result?.error !== tool.code) {
        slipped.push(`${tool.name} → ${JSON.stringify(result || null).slice(0, 120)}（应为 ${tool.code}）`);
      }
    }
    if (slipped.length) {
      throw new Error("机器主体调人工专属工具没有被挡住：\n    " + slipped.join("\n    ")
        + "\n  —— 定稿权那三层防线里，真正每天起作用的就是这一层");
    }
    // 够不着的那些，其拒绝码必须【已经登记在第二道门册里】。这一条同时校验了登记册本身：
    // 此前没有任何东西核对过那份登记还成不成立 —— 白名单一放开、或者某条守卫被删掉，
    // 登记就成了一句过期的话，而拒绝码棘轮正是靠它把这些码排除在扫描面之外的。
    // 够不着的那些，要么登记在第二道门册里，要么已经有别的门在点名核对它
    // （2026-08-22：这五道守卫的【形状】现在由 verifyMachinePrincipalGuardsAreAllowlists
    //  逐条核 —— 那条判据的源码里带着这些码，于是拒绝码棘轮不再把它们算成零覆盖，
    //  契约门当场要求把它们从第二道门册删掉。两张表说的是两件事：
    //  "为什么没有行为断言"（登记册）和"有没有任何门提到过它"（棘轮）。
    //  这里改成认第二种：有判据点名就不必再登记，否则登记就成了永远删不掉的一句空话。）
    const guardShapeCheck = readFileSync(new URL("./contract-check.mjs", import.meta.url), "utf8");
    const unregistered = HUMAN_ONLY_TOOLS
      .filter((tool) => behindWhitelist.some((entry) => entry.startsWith(tool.name)))
      .filter((tool) => !KNOWN_SECOND_DOORS[tool.code] && !guardShapeCheck.includes(tool.code));
    if (unregistered.length) {
      throw new Error(`这些人工专属工具被白名单先拒，而它们的拒绝码既没登记进第二道门册、`
        + `也没有任何门点名核对过：${unregistered.map((tool) => `${tool.name}/${tool.code}`).join("、")}`
        + " —— 那就是一道谁也没验过的守卫");
    }
    console.log(`人工专属工具：${HUMAN_ONLY_TOOLS.length} 个逐个用受限节点令牌调过，`
      + `${HUMAN_ONLY_TOOLS.length - behindWhitelist.length} 个走到了守卫并逐字对上拒绝码，`
      + `${behindWhitelist.length} 个被工具白名单先拒（与第二道门册一致）`
      + "；白名单一旦放开，它们会自动落进前一支");
  }

  // 【派发绑定的授权会自动补全作用域】。受限节点省掉 roomId/taskGroupId 时，服务端会拿
  // 这条派发自己的作用域把它补上（applyAgentGrantScopeArgs）——所以它【补不出一个越界的值】，
  // 而不是"缺省被当成放行"。这跟本仓那条"缺省不得等于有利结果"是同一件事的两种解法：
  // 一种是拒绝，一种是把正确答案填进去。这里实测确认走的是后者，别再有人当成漏洞去追。
  //
  // 顺带把越界那一支压住：点名【隔壁项目】的房间时必须被拒（工具白名单先拒也算拒住了，
  // 但要逐字对上码，否则"拒了"与"拒对了"分不开）。
  {
    const omitted = await mcpAs(nodeToken, "tools/call",
      {name: "room-mcp.room_wait", arguments: {idempotencyKey: "mcp-bounded-room"}});
    const omittedRoom = omitted.structuredContent?.result?.roomId;
    if (!omittedRoom || !omittedRoom.includes(grantedTaskGroupId)) {
      throw new Error(`受限节点省掉 roomId 时，服务端没有把它补成这条派发自己的房间`
        + `（拿到 ${JSON.stringify(omittedRoom)}，应含 ${grantedTaskGroupId}）`
        + " —— 补错了就等于让它读到别处");
    }
    const crossRoomWait = await mcpAs(nodeToken, "tools/call",
      {name: "room-mcp.room_wait", arguments: {roomId: `room_${scanGroupId}`, idempotencyKey: "mcp-bounded-out"}});
    const crossError = crossRoomWait.structuredContent?.result?.error;
    if (!["out_of_scope", "mcp_grant_scope_mismatch"].includes(crossError)) {
      throw new Error(`受限节点点名隔壁项目的房间却没有被拒（${JSON.stringify(crossError)}）`
        + " —— 它能读到别的租户的协作记录");
    }
  }

  // 【同一个 id 建两次必须撞】。这三条守卫此前没有任何断言 —— 删掉它们，第二次创建会
  // 静默覆盖掉第一条（同一个 id 两份记录，或者后者顶掉前者），而调用方拿到的是 201。
  {
    const dupProject = `prj_dup_${Date.now()}`;
    const mk = (name, args, key) => mcpAs(admin.sessionToken, "tools/call",
      {name, arguments: {...args, idempotencyKey: key}});
    const first = await mk("orchestration-mcp.project_create",
      {projectId: dupProject, name: "重复 id 探针"}, "mcp-dup-prj-1");
    if (first.structuredContent?.result?.error) {
      throw new Error(`造不出用于重复 id 检验的项目：${JSON.stringify(first.structuredContent?.result).slice(0, 140)}`);
    }
    const cases = [
      {name: "orchestration-mcp.project_create", args: {projectId: dupProject, name: "又一个"},
        key: "mcp-dup-prj-2", code: "project_id_conflict"},
      {name: "orchestration-mcp.task_group_create",
        args: {projectId: dupProject, taskGroupId: "tg_runtime_management", title: "撞已有任务组"},
        key: "mcp-dup-tg", code: "task_group_id_conflict"},
      // 项目的属主必须是一个真实存在的账号：不校验的话，项目会挂在一个不存在的人名下 ——
      // 组织归属、配额、可见性全都从属主推出来，属主是空的等于这些全落空。
      {name: "orchestration-mcp.project_create",
        args: {projectId: `${dupProject}_owner`, name: "属主不存在", ownerAccountId: "acct_not_a_real_person"},
        key: "mcp-bad-owner", code: "owner_account_not_found"},
      {name: "orchestration-mcp.work_item_create",
        args: {taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", title: "撞已有工作项"},
        key: "mcp-dup-wi", code: "work_item_id_conflict"}
    ];
    const missed = [];
    for (const item of cases) {
      const again = await mk(item.name, item.args, item.key);
      const error = again.structuredContent?.result?.error;
      if (error !== item.code) {
        missed.push(`${item.name} → ${JSON.stringify(error)}（应为 ${item.code}）`);
      }
    }
    if (missed.length) {
      throw new Error("同一个 id 建两次没有被拒：\n    " + missed.join("\n    ")
        + "\n  —— 第二次会静默覆盖掉第一条，而调用方拿到的是成功");
    }
  }

  // 【MCP 侧「查无此物」也要逐个点名】。这些码此前没有任何门/e2e 提到过 ——
  // 也就是说把 `if (!x) return {error: "..."}` 整行删掉，没有任何东西会变红，
  // 而后面的代码会拿着 undefined 往下跑（本仓在 REST 侧已经因为这个漏过真事实）。
  // 用系统管理员令牌打：它不受工具白名单限制，够得到每一个工具。
  {
    const NOT_FOUND_TOOLS = [
      {name: "governance-mcp.approval_resolve",
        args: {approvalId: "apr_bogus", idempotencyKey: "mcp-nf-1"},
        code: "approval_request_not_found"},
      {name: "governance-mcp.finding_resolve",
        args: {findingId: "fnd_bogus", status: "resolved", idempotencyKey: "mcp-nf-2"},
        code: "finding_not_found"},
      {name: "permission-mcp.permission_status", args: {requestId: "prq_bogus"},
        code: "permission_request_not_found"},
      {name: "human-review-mcp.confirmation_status", args: {requestId: "hcr_bogus"},
        code: "human_confirmation_not_found"},
      // 产出目标是"这份成果往哪个仓库写"。指一个不存在的目标必须当场拒 ——
      // 不拒的话后面的代码会拿着 undefined 往下走（本仓在 REST 侧已经因为这个漏过真事实）。
      {name: "repository-mcp.repository_target_lease_bind",
        args: {repositoryOutputTargetRef: "tgt_bogus", holderRef: "session:probe", idempotencyKey: "mcp-nf-target"},
        code: "repository_output_target_not_found"},
      {name: "governance-mcp.role_drift_guard_bind",
        args: {taskGroupId: "tg_runtime_management", sessionId: "sess_bogus", runId: "run_bogus",
          idempotencyKey: "mcp-nf-4"},
        code: "task_contract_not_found"}
    ];
    const wrong = [];
    for (const tool of NOT_FOUND_TOOLS) {
      let result;
      try {
        const call = await mcpAs(admin.sessionToken, "tools/call", {name: tool.name, arguments: tool.args});
        result = call.structuredContent?.result;
      } catch (error) { result = {error: `传输层拒：${String(error?.message || error).slice(0, 50)}`}; }
      if (result?.error !== tool.code) {
        wrong.push(`${tool.name} → ${JSON.stringify(result || null).slice(0, 110)}（应为 ${tool.code}）`);
      }
    }
    if (wrong.length) {
      throw new Error("MCP 工具拿到不存在的 id 时没有给出该给的拒绝码：\n    " + wrong.join("\n    ")
        + "\n  —— 删掉那道判据不会有任何东西变红，而后面的代码会拿着 undefined 往下跑");
    }
  }

  const readOnlyTools = listed.tools.filter((tool) => tool.annotations?.readOnlyHint || tool.readOnlyHint);
  if (readOnlyTools.length < 10) throw new Error(`跨租户扫描只认出 ${readOnlyTools.length} 个只读工具 —— 提取逻辑与代码脱节，本条在空转`);
  const scanLeaks = [];
  let probedExecuted = 0;
  const reachableTools = new Set();
  for (const tool of readOnlyTools) {
    // 两种都要调，而且【不带参数】那一次才是关键：带 addressing 参数的调用会被 principal
    // 作用域校验在到达过滤之前就拒掉（第一版只调了这一种，把守卫改坏也照样绿）；
    // 不带参数的只读工具绕过那道校验，靠工具自己按 principal 过滤 —— 漏就漏在这里。
    for (const args of [{projectId: scanProjectId, taskGroupId: scanGroupId}, {}, {taskGroupId: grantedTaskGroupId}]) {
      let result;
      try {
        result = await mcpAs(nodeToken, "tools/call", {name: tool.name, arguments: args});
      } catch {
        continue; // 被拒就是对的：拒绝不会泄露任何东西
      }
      // 错误被包在成功的 JSON-RPC 信封里，ok:false 说明这个工具【根本没执行】——
      // 只数真的执行了的那些，否则这段扫描会拿一堆错误信封冒充"验过了"。
      const executed = !/"ok":\s*false/u.test(JSON.stringify(result));
      if (executed) { probedExecuted += 1; reachableTools.add(tool.name); }
      const text = JSON.stringify(result);
      // 判据用【隔壁项目的内容】而不是它的 id：调用方自己传进去的 id 被回显不算泄露。
      if (text.includes("隔壁项目") || text.includes("隔壁任务组")) {
        scanLeaks.push(`${tool.name}(${Object.keys(args).length ? "带隔壁 id" : "不带参数"}): ${text.slice(0, 140)}`);
      }
    }
  }
  console.error(`[探针] 这个受限节点调得到的工具：${[...reachableTools].join("、")}`);
  if (probedExecuted < 5) throw new Error(`跨租户扫描里只有 ${probedExecuted} 次调用真的执行了（其余都是 ok:false 的错误信封）—— 本条在空转`);
  if (scanLeaks.length) {
    throw new Error(`绑定在别的项目上的节点，从这些只读工具里拿到了隔壁项目的内容：\n  ${scanLeaks.join("\n  ")}`);
  }
  // 自证行要说清【实际验到了什么】：受限节点真正的边界是每次派发的工具白名单
  // （其余工具直接 mcp_tool_not_granted_to_principal，连处理器都进不去），
  // 状态过滤只是它后面的纵深防御。这段扫描守的是"凡是这个身份调得到的工具，都不许带出隔壁内容"。
  console.log(`MCP 只读工具跨租户扫描 ok: ${readOnlyTools.length} 个只读工具各用三种入参调过`
    + `（隔壁项目的 id / 无参 / 自己被授权的任务组），其中 ${reachableTools.size} 个这个受限节点真的调得到`
    + `（${probedExecuted} 次执行），其余被工具白名单挡在门外；调得到的都没有带出隔壁项目的内容`);

  // 状态对表：MCP 这条写路径造出来的记录，status 也必须是状态机登记过的状态。
  // 不接这道门的话，"MCP 建的组落在机器里没有的 planned" 这种漂移在任何门下都看不见
  // （控制面 e2e 走的是 REST 那条路，两条路各写各的）。放在主流程里、清理运行目录之前。
  const mcpProducedState = readStoredState({
    root, runtimeDir,
    statePath: join(runtimeDir, "control-plane-state.json"),
    seedPath: join(root, "data/seed-state.json"),
    buildInitialState: () => { throw new Error("mcp doctor: 期望读到本轮跑出的状态，却触发了初始状态创建"); }
  });
  // 「这张授权覆不覆盖你问的这个资源」由 core 的 resourceMatches 一个函数决定，
  // 它管着两件事：权限探询给出的答案、以及建授权时的去重。把它改成【永远为真】之后，
  // 契约门 + 三套 e2e 全绿 —— 整条门链上一个行为断言都没有。两个方向各验一次：
  //  · 探询：在项目 A 上有授权的人，问项目 B 必须答"不允许"（答错＝系统告诉人一句假话）；
  //  · 去重：为项目 B 建授权时，不许把项目 A 的那张当成"已经有了"返回
  //    （那时调用方以为授权成功，而 B 上根本没有授权，拿到的 grantId 指着另一个资源）。
  // 用的权限是这条路的缺省 task_group:read —— grant_create 的 permissions/role 两个参数
  // 在共用入参词表里没有对应键，MCP 上传不进来（这件事另行报给人定，这里只用够得着的参数）。
  {
    const probeEmail = "resource-scope-probe@local";
    const invited = await mcpAs(admin.sessionToken, "tools/call", {name: "identity-mcp.account_invite",
      arguments: {idempotencyKey: "doctor-mcp-resource-scope", email: probeEmail,
        displayName: "授权作用域探针", projectId: "prj_control_plane"}});
    const subjectId = invited.structuredContent?.result?.account?.accountId;
    if (!subjectId) throw new Error(`授权作用域探针建不出账号：${JSON.stringify(invited).slice(0, 160)}`);
    const grantedA = await mcpAs(admin.sessionToken, "tools/call", {name: "identity-mcp.grant_create",
      arguments: {idempotencyKey: "doctor-mcp-resource-scope-a", subjectId,
        resource: {resourceType: "project", resourceId: "prj_control_plane"}}});
    const grantA = grantedA.structuredContent?.result?.grant;
    if (!grantA) throw new Error(`项目 A 的授权建不出来：${JSON.stringify(grantedA.structuredContent?.result || grantedA).slice(0, 200)}`);
    const otherProject = "prj_doctor_mcp_resource_scope";
    await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.project_create",
      arguments: {idempotencyKey: "doctor-mcp-resource-scope-project", projectId: otherProject,
        name: "授权作用域对照项目"}});
    const askedB = await mcpAs(admin.sessionToken, "tools/call", {name: "permission-mcp.permission_probe",
      arguments: {subjectId, permission: "task_group:read",
        resource: {resourceType: "project", resourceId: otherProject}}});
    const verdict = askedB.structuredContent?.result;
    if (verdict?.allowed !== false || (verdict?.grants || []).length) {
      throw new Error(`在项目 A 上有授权的人，问项目 B 被答成「允许」（命中 ${(verdict?.grants || []).length} 张授权）`
        + " —— 授权作用域没起作用，而这是系统对人说的一句假话");
    }
    const grantedB = await mcpAs(admin.sessionToken, "tools/call", {name: "identity-mcp.grant_create",
      arguments: {idempotencyKey: "doctor-mcp-resource-scope-b", subjectId,
        resource: {resourceType: "project", resourceId: otherProject}}});
    const grantB = grantedB.structuredContent?.result?.grant;
    if (!grantB) throw new Error(`为项目 B 建不出授权：${JSON.stringify(grantedB.structuredContent?.result || grantedB).slice(0, 200)}`);
    if (grantB.resource?.resourceId !== otherProject || grantB.grantId === grantA.grantId) {
      throw new Error(`为项目 B 申请授权，拿回来的却是指着 ${grantB.resource?.resourceId} 的那一张`
        + "（去重把两个资源当成了同一个）—— 调用方以为授权成功，而 B 上根本没有授权");
    }
    const afterGrant = await mcpAs(admin.sessionToken, "tools/call", {name: "permission-mcp.permission_probe",
      arguments: {subjectId, permission: "task_group:read",
        resource: {resourceType: "project", resourceId: otherProject}}});
    if (afterGrant.structuredContent?.result?.allowed !== true) {
      throw new Error("刚为项目 B 授了权，探询仍答「不允许」—— 守卫过头了，正面这条路被一起堵死");
    }
  }

  // 【发授权:能表达 + 有校验】2026-08-26 人定开出来的。此前 permissions/role 读了却传不进来，
  // 于是这个工具只能铸出一种固定授权，而回执是成功 —— 调用方以为发出去的是它要的那张。
  // 开的同时把 REST 那侧的四条委派校验搬成了两侧共用的一份（此前 MCP 一条都没有，
  // 挡住它的只是"词表里没这个键"）。正反都要验，否则「开了」和「开成了个筛子」分不开。
  {
    const target = {resourceType: "task_group", resourceId: "tg_runtime_management"};
    // 用一个【干净的】对象：去重逻辑会把"已有一张覆盖更广的授权"原样返回（这是对的），
    // 拿 acct_agent_runtime 来验的话，看到的是它原有那张，而不是这次发的那张。
    const grantee = (await mcpAs(admin.sessionToken, "tools/call", {name: "identity-mcp.account_invite",
      arguments: {idempotencyKey: "doctor-mcp-grant-subject", email: "grant.subject.probe@local",
        displayName: "发授权探针"}})).structuredContent?.result?.account?.accountId;
    if (!grantee) throw new Error("发授权探针建不出账号 —— 这一组断言会空转");
    // ① 能表达：给什么权限就落什么权限，不再被替换成那一种缺省。
    const minted = await mcpAs(admin.sessionToken, "tools/call", {name: "identity-mcp.grant_create",
      arguments: {idempotencyKey: "doctor-mcp-grant-explicit", subjectId: grantee,
        resource: target, grantPermissions: ["task_group:monitor"], grantRole: "agent_operator"}});
    const grant = minted.structuredContent?.result?.grant;
    if (!grant || JSON.stringify(grant.permissions) !== JSON.stringify(["task_group:monitor"])) {
      throw new Error(`MCP 发授权没按给的权限落（实得 ${JSON.stringify(grant?.permissions)}）——`
        + " 参数收了却不生效，调用方以为发出去的是它要的那张");
    }
    // ② 不可委派的一律拒。这是开这两个参数【必须先补】的那道检查：
    // 拿到 system:account_admin 就能铸系统管理员账号，而人工闸门只认账号类型。
    for (const unsafe of [["system:*"], ["system:account_admin"], ["project:*"]]) {
      const refused = await mcpAs(admin.sessionToken, "tools/call", {name: "identity-mcp.grant_create",
        arguments: {idempotencyKey: `doctor-mcp-grant-unsafe-${unsafe[0]}`, subjectId: grantee,
          resource: target, grantPermissions: unsafe}});
      const said = refused.structuredContent?.result;
      if (said?.error !== "unsafe_grant_permissions") {
        throw new Error(`MCP 发授权把不可委派的 ${unsafe[0]} 发出去了（${JSON.stringify(said).slice(0, 160)}）——`
          + " 这条通道能把整片权限一次交出去，而 REST 那侧一直是拒的");
      }
    }
    // ③ 授权对象必须已经存在：否则可以先给一个"面向未来的 id"建授权，再补建那个账号。
    const ghost = await mcpAs(admin.sessionToken, "tools/call", {name: "identity-mcp.grant_create",
      arguments: {idempotencyKey: "doctor-mcp-grant-ghost", subjectId: "acct_does_not_exist",
        resource: target, grantPermissions: ["task_group:read"]}});
    if (ghost.structuredContent?.result?.error !== "grant_subject_account_not_found") {
      throw new Error("MCP 给一个不存在的账号发出了授权 —— 那张授权在它自己被审视之前就生效了");
    }
    // ④ 认不出的作用域类型要拒：它在组织归属推导里会变成 null（＝系统级），
    // 于是跨组织那道检查整个不适用，还会落一条永远匹配不上任何资源却显示「启用中」的僵尸授权。
    const bogusScope = await mcpAs(admin.sessionToken, "tools/call", {name: "identity-mcp.grant_create",
      arguments: {idempotencyKey: "doctor-mcp-grant-scope", subjectId: grantee,
        resource: {resourceType: "galaxy", resourceId: "x"}, grantPermissions: ["task_group:read"]}});
    if (bogusScope.structuredContent?.result?.error !== "grant_resource_type_not_recognized") {
      throw new Error("MCP 收下了认不出的授权作用域类型 —— 会落一条僵尸授权，而它在名单里显示启用中");
    }
  }

  // 【指令包必须带上本项目现行规范】2026-08-26 人定：没有规范，agent 就可能走偏。
  // 原先 sharedDefinitionRefs 缺省是 [] —— 不给就是"这份指令不受任何规范约束"。
  // 现在由服务端自己算（与任务合同那条路同一个函数），调用方给的只能追加。
  {
    const active = (await mcpAs(admin.sessionToken, "tools/call", {name: "governance-mcp.contract_publish",
      arguments: {idempotencyKey: "doctor-mcp-def-for-envelope", contractId: "ctr_runtime_language"}}))
      .structuredContent?.result;
    const envelope = (await mcpAs(admin.sessionToken, "tools/call", {name: "instruction-mcp.instruction_envelope_create",
      arguments: {idempotencyKey: "doctor-mcp-envelope-specs", taskGroupId: "tg_runtime_management",
        roleId: "agent-runtime"}})).structuredContent?.result;
    const refs = envelope?.instructionEnvelope?.sharedDefinitionRefs;
    if (!Array.isArray(refs) || !refs.length) {
      throw new Error(`建指令包时没带上本项目现行规范（实得 ${JSON.stringify(refs)}，已发布的契约 `
        + `${JSON.stringify(active?.contract?.contractId || active?.error)}）—— 不给规范就是让 agent 自由发挥`);
    }
  }

  // 控制台「运行参数」里的 MCP 工具数，必须与这台 MCP 服务【真正实现了多少个工具】一致。
  // 它此前是 core 里手写的一个常量 81，而目录里是 85：运维 CLI 按目录算、屏幕上给人看的少 4 个。
  // 这里不拿目录去比目录（那是拿产品的写法当标准），而是问【这台服务自己认得多少个工具】：
  // 逐个 tools/call 空参试探太贵，改用它自己按主体过滤前的全量 —— 系统管理员会话看得到全部。
  {
    const adminTools = await mcpAs(admin.sessionToken, "tools/list", {});
    const implemented = (adminTools.tools || []).length;
    const shown = (await api("/api/state", {token: admin.sessionToken})).runtime?.mcp?.toolCount;
    if (!implemented) throw new Error("系统管理员会话一个工具都列不出来 —— 这条断言在空转");
    if (shown !== implemented) {
      throw new Error(`控制台运行参数说 MCP 工具数是 ${shown}，而这台服务实际实现了 ${implemented} 个`
        + " —— 屏幕上并排给人看的两个数由两处各算一遍，必然分叉");
    }
  }

  // 经 MCP 邀请、又【不显式给权限】的人，必须真的能看见那个项目。
  // 这条路的缺省权限原先写的是 "project:read" —— 一个全系统再无第二处的串：
  // 接口回成功、控制台上显示"已授权"，而这个人打开控制台什么都没有，任何一处都不说原因。
  // 判据不看那份权限清单长什么样（那是拿产品的写法当标准），只看【他到底看不看得见】。
  {
    const invited = await mcpAs(admin.sessionToken, "tools/call", {name: "identity-mcp.account_invite",
      arguments: {idempotencyKey: "doctor-mcp-default-grant", email: "default.grant.probe@local",
        displayName: "缺省授权探针", projectId: "prj_control_plane"}});
    const accountToken = invited.structuredContent?.result?.accountToken;
    if (!accountToken) {
      throw new Error(`MCP 邀请没给出一次性凭据，本条无从验证：${JSON.stringify(invited).slice(0, 200)}`);
    }
    const invitedLogin = await api("/api/auth/login", {method: "POST",
      body: {email: "default.grant.probe@local", token: accountToken}});
    const seen = await api("/api/state", {token: invitedLogin.sessionToken});
    if (!(seen.projects || []).some((project) => project.id === "prj_control_plane")) {
      throw new Error("经 MCP 邀请进项目、没显式给权限的人打开控制台看不到那个项目 ——"
        + " 授权是发出去了，但它带的权限没有任何守卫会要，等于什么都打不开");
    }
  }

  const mcpStates = checkRecordStatusesAreDeclaredStates(join(root, "spec/state-machines.yaml"),
    mcpProducedState, "MCP e2e 产出");
  console.log(mcpStates.note);
  if (mcpStates.errors.length) throw new Error(`mcp doctor: ${mcpStates.errors.join("\n- ")}`);

  const localStart = spawnSync(process.execPath, ["apps/mcp-server/server.mjs"], {cwd: root, encoding: "utf8"});
  if (localStart.status === 0 || !localStart.stderr.includes("Local MCP stdio startup is disabled")) throw new Error("Agent-local MCP stdio server was not disabled");
  console.log(`mcp doctor ok: ${listed.tools.length} remote tools, auth, HTTP transport, input policy and remote-only registration verified`);
} finally {
  child.kill("SIGTERM");
  await waitForChildExit(child, 3000);
  rmSync(runtimeDir, {recursive: true, force: true});
  rmSync(configDir, {recursive: true, force: true});
  if (child.exitCode && child.exitCode !== 0 && stderr) process.stderr.write(stderr);
}

async function mcp(method, params) {
  return mcpAs(token, method, params);
}

async function mcpAs(bearer, method, params) {
  assertNoUndefinedInPayload(`MCP ${method}${params?.name ? ` ${params.name}` : ""}`, params);
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {"content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}`},
    body: JSON.stringify({jsonrpc: "2.0", id: ++requestId, method, params})
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(payload.error || payload)}`);
  return payload.result;
}

async function api(path, options = {}) {
  assertNoUndefinedInPayload(`API ${path}`, options.body, options.allowUndefinedInPayload);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {"content-type": "application/json", accept: "application/json", ...(options.idempotencyKey ? {"idempotency-key": options.idempotencyKey} : {}), ...(options.token ? {authorization: `Bearer ${options.token}`} : {})},
    ...(options.body ? {body: JSON.stringify(options.body)} : {})
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`API ${path} failed: ${JSON.stringify(payload)}`);
  return payload;
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
  throw new Error(`remote MCP control plane health timeout: ${stderr}`);
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const selected = server.address().port;
  server.close();
  await once(server, "close");
  return selected;
}
