import { randomBytes } from "node:crypto";
import { clampEnvNumber } from "./env-number.mjs";
import { PROJECT_SHARD_COLLECTION_LIMITS } from "./state-store.mjs";
import { existsSync, readFileSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";
import { cancelPendingConfirmationsForDispatch, createId, digestOf, effectiveTaskGroupConfig, ensureRuntimeCollections, expireStaleQueuedDispatches, languagePolicyDirective, normalizeTaskGroupLanguagePolicy, organizationQuotaCheck,
  computeEffectiveRulesDigest, applyEffectiveRulesDigest, settleCellOwnedResources,
  assertHumanTextWithinLimit,
  normalizedExpiry, REGISTERED_OWNER_ROLES, unknownOwnerRoles} from "./control-plane-core.mjs";
import { openSecret, isSealed } from "./credential-seal.mjs";
import { projectRepositories } from "./path-policy.mjs";
import { isTerminalDispatchStatus } from "./lifecycle-states.mjs";
import {
  activeProjectIdsForOrganization,
  normalizeRegistrationScope,
  runtimeNodeCanAccessProject,
  runtimeNodeProjectIds,
  uniqueProjectIds
} from "./runtime-node-scope.mjs";

const DEFAULT_AGENT_MCP_TOOLS = [
  "agent-control-mcp.node_probe",
  "agent-control-mcp.session_start",
  "agent-control-mcp.session_pause",
  "agent-control-mcp.session_cancel",
  "agent-control-mcp.session_recover",
  "room-mcp.room_join",
  "room-mcp.room_send",
  "room-mcp.room_wait",
  "room-mcp.room_ack",
  "model-mcp.model_capabilities",
  "model-mcp.model_policy_get",
  "skill-mcp.role_skill_parse",
  "skill-mcp.role_skill_resolve",
  "evidence-mcp.artifact_register",
  "evidence-mcp.test_result_submit",
  "permission-mcp.permission_probe",
  "permission-mcp.permission_request_submit",
  "permission-mcp.permission_status",
  "human-review-mcp.confirmation_request_submit",
  "human-review-mcp.confirmation_status",
  "human-review-mcp.confirmation_consume",
  "human-review-mcp.confirmation_analyze",
  "ui-console-mcp.runtime_health_get",
  "ui-console-mcp.project_progress_get",
  "ui-console-mcp.task_group_progress_get",
  "instruction-mcp.cache_key_index",
  "instruction-mcp.stable_prefix_get",
  "repository-mcp.artifact_manifest_index"
];

const CONTROL_ROLE_MCP_TOOLS = [
  "orchestration-mcp.orchestrator_run",
  "orchestration-mcp.state_get",
  "scheduler-mcp.model_select",
  "scheduler-mcp.session_place",
  "scheduler-mcp.capacity_snapshot",
  "scheduler-mcp.execution_topology_plan",
  "scheduler-mcp.derived_task_classify",
  "review-mcp.review_plan_create",
  "review-mcp.review_bundle_register",
  "review-mcp.review_result_consume",
  "review-mcp.completion_readiness_compute",
  "governance-mcp.policy_decision_eval",
  "governance-mcp.finding_submit",
  "governance-mcp.close_barrier_compute",
  "definition-mcp.shared_definition_create",
  "definition-mcp.shared_definition_publish",
  "definition-mcp.shared_definition_consumer_bind",
  "definition-mcp.shared_definition_conflict_report"
];

export function ensureAgentGatewayCollections(state) {
  ensureRuntimeCollections(state);
  state.agentJoinTokens ||= [];
  state.agentRuntimeNodes ||= [];
  state.agentGatewayEvents ||= [];
  state.agentControlCommands ||= [];
  state.agentControlSequence ||= 0;
  state.agentExecutionEvents ||= [];
  state.agentExecutionSequence ||= 0;
  return state;
}

export function createAgentJoinToken(state, input = {}, options = {}) {
  ensureAgentGatewayCollections(state);
  const registrationScope = normalizeRegistrationScope(input.registrationScope || input.scope, "project");
  if (!registrationScope) throw gatewayError("permission_unknown", 400, {field: "registrationScope", supported: ["project", "organization"]});
  const projectId = String(input.projectId || "").trim();
  const tokenProject = registrationScope === "project" ? state.projects.find((project) => project.id === projectId) : null;
  // 带上状态码：不带的话它落进通用出口，成了 500 server_error —— 而这是【调用方少填了一个字段】，
  // 不是系统坏了。实测空 body 打这条路由就是 500，真实原因埋在 message 里；
  // 监控看到 5xx 会当成事故，人看到 server_error 会去查服务端日志，而他要做的只是补上 projectId。
  // （下面配额那条早就用了 gatewayError，同一个函数里两种写法 —— 这一条是漏掉的那个。）
  if (registrationScope === "project" && !tokenProject) throw gatewayError("join_token_project_not_found", 404, {projectId: projectId || null});
  const requestedOrganizationId = String(input.organizationId || tokenProject?.organizationId || "").trim();
  const tokenOrgId = registrationScope === "organization"
    ? requestedOrganizationId
    : (tokenProject.organizationId || "org_default");
  const tokenOrganization = (state.organizations || []).find((organization) => organization.orgId === tokenOrgId);
  if (!tokenOrganization) throw gatewayError("organization_not_found", 404, {organizationId: tokenOrgId || null});
  if (tokenOrganization.status !== "active") throw gatewayError("not_active", 409, {organizationId: tokenOrgId, status: tokenOrganization.status});
  // 归档的含义是「移出可建新工作的范围」，而此前只有建任务组那一处判了它 ——
  // 给已归档项目签出来的加入令牌，接进去的 agent 会绑在一个不能再建任何工作的项目上，
  // 两边都不报错；而控制台的「加入令牌」下拉里就摆着这些项目。锁落在决策点上，
  // 界面那份清单也一并收窄（只藏选项不锁门＝改个请求就绕过去了）。
  if (registrationScope === "project" && tokenProject.status === "archived") {
    throw gatewayError("project_archived", 409, {projectId,
      hint: "该项目已归档（终态，不可撤销），不能再往里接入 agent。要继续这条线，请另建一个项目"});
  }
  const quota = organizationQuotaCheck(state, tokenOrgId, "agents");
  // 已签发未用的令牌占位数【从配额检查那一处取】（quota.reserved 就是 recompute 的 usage.agentsReserved）——
  // 不再在这里各写一份 filter：页面显示的那格与这里的强制从此是同一个数，不会再漂成「页面 2/3、签发说 3/3」。
  const outstandingJoinTokens = quota.reserved || 0;
  if (!quota.allowed || quota.usage + outstandingJoinTokens >= quota.quota) {
    // 这个 usage 是"节点 + 未使用的令牌"，与页面上那格【同一口径】（usage.agentsReserved 就是后一半）。
    // 分开报出来，人才对得上："我明明只有 2 台节点"——第三格是自己上次签发还没用掉的那张令牌。
    throw gatewayError("org_quota_exceeded", 409, {kind: "agents", quota: quota.quota,
      usage: (quota.usage || 0) + outstandingJoinTokens,
      nodes: quota.usage || 0, outstandingJoinTokens});
  }
  const ttlSeconds = boundedInteger(input.ttlSeconds, 60, 86400, 1800);
  if (input.maxUses !== undefined && Number(input.maxUses) !== 1) throw gatewayError("join_token_must_be_one_time", 400);
  const maxUses = 1;
  const allowedRoles = uniqueStrings(input.allowedRoles?.length ? input.allowedRoles : ["agent-runtime"]);
  // 角色范围只认已登记的执行角色（"*" 表示不限）。原先任何字符串都照收：拼错成 agent-runtim 的票签得出来、
  // 界面上显示为已签发，节点拿它注册时才以 join_token_role_scope_mismatch 被拒 —— 失败推迟到另一台机器上的另一个人。
  {
    const unknownRoles = unknownOwnerRoles(allowedRoles.filter((role) => role !== "*"));
    if (unknownRoles.length) {
      throw gatewayError("join_token_role_not_registered", 400, {unknownOwnerRoles: unknownRoles.slice(0, 10), supported: [...REGISTERED_OWNER_ROLES],
        hint: "角色范围里有未登记的执行角色：这张票没有任何节点能用。按 supported 里的名字填，或填 * 表示不限"});
    }
  }
  const token = `aimac_join_${randomBytes(32).toString("base64url")}`;
  const at = new Date().toISOString();
  const record = {
    schemaVersion: "agent-join-token/v1",
    joinTokenId: createId("ajt"),
    projectId: registrationScope === "project" ? projectId : null,
    organizationId: tokenOrgId,
    registrationScope,
    // 节点名是人在表单里填的，而且会被嵌进【给人复制执行的安装命令】里 —— 超长要拒，不能截断
    // （截断后人复制到的命令与他填的不是一回事）。机器自报的字段走截断，见下面 runtimeVersion。
    expectedNodeName: assertHumanTextWithinLimit(
      String(input.nodeName || input.expectedNodeName || "").trim(), "agent_node_name", 200) || null,
    allowedRoles,
    allowedMcpTools: mcpToolsForRoles(allowedRoles),
    tokenDigest: digestOf(`agent-join:${token}`),
    status: "issued",
    maxUses,
    useCount: 0,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    createdBy: options.actor || "system",
    createdAt: at,
    updatedAt: at
  };
  state.agentJoinTokens.unshift(record);
  state.agentJoinTokens = capAgentJoinTokens(state.agentJoinTokens);
  const serverUrl = trimTrailingSlash(options.publicUrl || "http://127.0.0.1:4317");
  const nodeNameArg = record.expectedNodeName ? ` --node-name ${shellArg(record.expectedNodeName)}` : "";
  const tokenFileCommand = `umask 077; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT HUP INT TERM; cat > "$tmp/aimac.join" <<'AIMAC_JOIN_TOKEN'\n${token}\nAIMAC_JOIN_TOKEN\ncurl -fsSL ${shellUrl(`${serverUrl}/install-agent.sh`)} | sh -s -- --server ${shellArg(serverUrl)} --join-token-file "$tmp/aimac.join"${nodeNameArg} --configure-global-clients`;
  const verifiedTokenFileCommand = `umask 077; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT HUP INT TERM; cat > "$tmp/aimac.join" <<'AIMAC_JOIN_TOKEN'\n${token}\nAIMAC_JOIN_TOKEN\ncd "$tmp" && curl -fsSLO ${shellUrl(`${serverUrl}/install-agent.sh`)} && curl -fsSLO ${shellUrl(`${serverUrl}/install-agent.sh.sha256`)} && ( if command -v sha256sum >/dev/null 2>&1; then sha256sum -c install-agent.sh.sha256; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -c install-agent.sh.sha256; else printf '%s\\n' 'sha256sum or shasum is required' >&2; exit 1; fi ) || { printf '%s\\n' '安装脚本校验失败：下载可能被篡改或不完整 —— 别继续装；重新执行这条命令，仍失败就找控制面管理员' >&2; exit 1; } && sh install-agent.sh --server ${shellArg(serverUrl)} --join-token-file "$tmp/aimac.join"${nodeNameArg} --configure-global-clients`;
  appendGatewayEvent(state, "join_token_issued", record.joinTokenId, {projectId: record.projectId, organizationId: record.organizationId, registrationScope, allowedRoles});
  return {
    joinToken: token,
    joinTokenRecord: publicJoinToken(record),
    installCommand: tokenFileCommand,
    verifiedInstallCommand: verifiedTokenFileCommand
  };
}

// 【只读的取数不许顺手改状态】。这里原先调 ensureAgentGatewayCollections —— 而它会往下走到
// ensureRuntimeCollections，把一堆集合补齐、还会重写 project_owner 授权的 permissions。
// 于是每个 GET（控制台的视图就走这条）都在"读"的名义下改一遍状态。平时看不出来：
// 每个请求各拿一份克隆，改的是自己那份。共用只读那份是冻的，它当场抛
// "Cannot assign to read only property 'permissions'" —— 冻结的价值就在这里。
// 取数只需要容忍集合不存在，不需要把它建出来。
export function listAgentJoinTokens(state, projectId) {
  return (state.agentJoinTokens || [])
    .filter((item) => !projectId || item.projectId === projectId)
    .map(publicJoinToken);
}

export function registerAgentNode(state, input = {}, options = {}) {
  ensureAgentGatewayCollections(state);
  const rawToken = String(options.joinToken || "");
  const tokenDigest = digestOf(`agent-join:${rawToken}`);
  const record = state.agentJoinTokens.find((item) => item.tokenDigest === tokenDigest);
  if (!record) throw gatewayError("join_token_invalid", 401);
  // 注册没有幂等键：写入成功但响应在网络上丢失时，代理会重试，而这时 token 已经是 consumed，
  // 于是重试被拒，留下一个 initializing 的节点记录 —— 它持有一个谁也不知道的 nodeToken、
  // 永远不心跳、并且按 status !== "revoked" 永久占用组织配额，最终新节点再也接不进来。
  // join token 是一次性的，代理无法重新注册，只能人工介入。
  // 重放判断必须【早于】所有"这个 token 已经用过了"的检查 —— 那些检查正是重试会撞上的。
  // 它不会多授予任何东西：持有这个 token 的人本来就已经拿到过这份结果一次。
  // 判别依据必须是幂等键，不能是 join token 本身 —— 只看 token 的话，"重试"和"有人拿着同一个
  // token 想再注册一台"是同一件事，而后者正是一次性 token 要挡住的。
  const idempotencyKey = String(options.idempotencyKey || "").trim();
  const replay = record.registrationReplay;
  if (replay && idempotencyKey && replay.idempotencyKey === idempotencyKey) {
    const replayWindowMs = boundedInteger(process.env.AIMAC_REGISTER_REPLAY_WINDOW_MS, 60000, 3600000, 600000);
    const existingNode = state.agentRuntimeNodes.find((item) => item.nodeId === replay.nodeId);
    // 正文被抹掉之后不能再当作可重放：返回一份没有 nodeToken 的注册结果，节点会拿到一个
    // 看起来成功、实际无法认证的响应，而它已经把这次注册当成完成了。宁可让它显式失败。
    if (existingNode && replay.result?.nodeToken && Date.now() - new Date(replay.at || 0).getTime() <= replayWindowMs) {
      return {...replay.result, node: publicAgentNode(existingNode, {state}), replayed: true};
    }
  }
  // 状态要照实说。原先这四种状态一律回 join_token_not_active（"加入令牌不处于可用状态"）——
  // 系统明明知道是"已被使用"还是"已过期"还是"已吊销"，却给人最模糊的那一句；而下面那两道按
  // useCount/expiresAt 判的检查在正常流程里永远够不着（兑换成功当场就把 status 置成 consumed）。
  // 不用三元：拒绝码写在三元里会从拒绝码扫描面逃逸（本仓撞过的形状）。
  if (record.status === "consumed") throw gatewayError("join_token_consumed", 409, {tokenStatus: record.status});
  if (record.status === "expired") throw gatewayError("join_token_expired", 401, {tokenStatus: record.status});
  if (record.status === "revoked") throw gatewayError("join_token_revoked", 401, {tokenStatus: record.status});
  if (record.status !== "issued") throw gatewayError("join_token_not_active", 409, {tokenStatus: record.status});
  // 认不出的到期时间【按已过期处理】。`new Date("坏值").getTime()` 是 NaN，
  // 而 `NaN <= now` 是 false —— 直接比的话，一张 expiresAt 被写坏的令牌会被判成"没过期"，
  // 永久可用。schema 那一层已经要求 date-time（也补齐了全仓 24 个漏声明的字段），
  // 但这条路是【凭据兑换】：它自己也得在认不出时倒向拒绝，而不是依赖上游都没出错。
  const joinTokenExpiryMs = new Date(record.expiresAt).getTime();
  if (!Number.isFinite(joinTokenExpiryMs) || joinTokenExpiryMs <= Date.now()) {
    record.status = "expired";
    record.updatedAt = new Date().toISOString();
    throw gatewayError("join_token_expired", 401);
  }
  if (record.useCount >= record.maxUses) {
    record.status = "consumed";
    record.updatedAt = new Date().toISOString();
    throw gatewayError("join_token_consumed", 409);
  }
  const nodeName = String(input.nodeName || "").trim();
  if (!nodeName) throw gatewayError("node_name_required", 400);
  if (record.expectedNodeName && record.expectedNodeName !== nodeName) throw gatewayError("join_token_node_name_mismatch", 403);
  const requestedRoles = uniqueStrings(input.requestedRoles || record.allowedRoles);
  if (!rolesAllowed(requestedRoles, record.allowedRoles)) {
    // 只给一个码，接入方无从知道该改成什么：把要了什么、这张票允许什么一并说出来。
    // 读这条报文的是 agent（或正在接节点的人），它需要的恰好是这两个集合的差。
    throw gatewayError("join_token_role_scope_mismatch", 403,
      {requestedRoles, allowedRoles: record.allowedRoles, rejected: requestedRoles.filter((role) => !rolesAllowed([role], record.allowedRoles))});
  }
  const registerOrgId = record.organizationId || "org_default";
  const registerQuota = organizationQuotaCheck(state, registerOrgId, "agents");
  if (!registerQuota.allowed) {
    throw gatewayError("org_quota_exceeded", 409, {kind: "agents", quota: registerQuota.quota, usage: registerQuota.usage});
  }

  const nodeToken = `aimac_node_${randomBytes(40).toString("base64url")}`;
  const nodeId = createId("node");
  const at = new Date().toISOString();
  const profile = sanitizeNodeProfile(input.profile || {});
  const node = {
    schemaVersion: "agent-runtime-node/v1",
    nodeId,
    nodeName,
    organizationId: record.organizationId || "org_default",
    registrationScope: record.registrationScope || "project",
    projectIds: (record.registrationScope || "project") === "organization"
      ? activeProjectIdsForOrganization(state, record.organizationId || "org_default")
      : uniqueProjectIds([record.projectId]),
    allowedRoles: requestedRoles,
    allowedMcpTools: record.allowedMcpTools,
    status: "initializing",
    admission: "limited",
    credentialDigest: digestOf(`agent-node:${nodeId}:${nodeToken}`),
    credentialIssuedAt: at,
    credentialExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    profile,
    profileDigest: digestOf(profile),
    runtimeVersion: String(input.runtimeVersion || "unknown").slice(0, 100),
    lastHeartbeatAt: at,
    lastSelfCheckAt: null,
    activeDispatchIds: [],
    completedDispatchCount: 0,
    failedDispatchCount: 0,
    createdAt: at,
    updatedAt: at
  };
  state.agentRuntimeNodes.unshift(node);
  state.agentRuntimeNodes = capAgentRuntimeNodes(state.agentRuntimeNodes);
  record.useCount += 1;
  record.status = record.useCount >= record.maxUses ? "consumed" : "issued";
  record.updatedAt = at;
  appendGatewayEvent(state, "node_registered", nodeId, {projectId: record.projectId || null, organizationId: node.organizationId, registrationScope: node.registrationScope, profileDigest: node.profileDigest});
  const publicUrl = trimTrailingSlash(options.publicUrl || "http://127.0.0.1:4317");
  const registration = {
    node: publicAgentNode(node, {state}),
    nodeToken,
    gateway: {
      serverUrl: publicUrl,
      heartbeatUrl: `${publicUrl}/api/agent/v1/heartbeat`,
      selfCheckUrl: `${publicUrl}/api/agent/v1/self-check`,
      dispatchUrl: `${publicUrl}/api/agent/v1/dispatches/next`,
      controlUrl: `${publicUrl}/api/agent/v1/control`,
      eventUrl: `${publicUrl}/api/agent/v1/events`,
      mcpUrl: `${publicUrl}/mcp`,
      skillWorksetBaseUrl: `${publicUrl}/api/agent/v1/skill-worksets`,
      runtimeUrl: `${publicUrl}/agent-runtime.mjs`
    },
    heartbeatIntervalSeconds: 30,
    pollIntervalSeconds: 5
  };
  // 留下重放依据：同一个 join token 的重试要能拿回同一份结果，而不是新造一个僵尸节点。
  record.registrationReplay = {nodeId, at, result: registration, idempotencyKey: String(options.idempotencyKey || "").trim() || null};
  return registration;
}

const nodeTokenCache = new Map();

// 【鉴权是纯读】：它只按令牌找节点，不该顺手把一堆集合补齐（那一路会走到
// ensureRuntimeCollections，连 project_owner 授权的 permissions 都会重写）。而它在【每一个】
// 网关请求上都跑。取数只需要容忍集合不存在。
// 【这一条没有登记变异】：网关那一族目前整族拿可变状态（它有几条 GET 设计上就要写），
// 所以把这行 ensure 加回去今天不会让任何门变红 —— 它是预防性的，不是有判据的守卫。
// 登记一条验不出判别力的变异比不登记更坏，所以如实写在这里。
export function authenticateAgentNode(state, bearerToken) {
  const token = String(bearerToken || "");
  if (!token.startsWith("aimac_node_")) return null;
  const nodes = state.agentRuntimeNodes || [];
  const cachedNodeId = nodeTokenCache.get(token);
  if (cachedNodeId) {
    const node = nodes.find((item) => item.nodeId === cachedNodeId);
    if (node && nodeAcceptsToken(node, token)) return node;
    nodeTokenCache.delete(token);
  }
  for (const node of nodes) {
    if (nodeAcceptsToken(node, token)) {
      if (nodeTokenCache.size > 5000) nodeTokenCache.clear();
      nodeTokenCache.set(token, node.nodeId);
      return node;
    }
  }
  return null;
}

function nodeAcceptsToken(node, token) {
  if (node.status === "revoked") return false;
  const presentedDigest = digestOf(`agent-node:${node.nodeId}:${token}`);
  const currentValid = !node.credentialExpiresAt || new Date(node.credentialExpiresAt).getTime() > Date.now();
  const previousValid = node.previousCredentialDigest === presentedDigest
    && new Date(node.previousCredentialExpiresAt || 0).getTime() > Date.now();
  return (currentValid && node.credentialDigest === presentedDigest) || previousValid;
}

export function heartbeatAgentNode(state, node, input = {}, options = {}) {
  const at = new Date().toISOString();
  const previousHeartbeatAt = node.lastHeartbeatAt;
  const previousStatus = node.status;
  const previousProfileDigest = node.profileDigest;
  node.lastHeartbeatAt = at;
  node.updatedAt = at;
  if (input.profile) {
    node.profile = sanitizeNodeProfile(input.profile);
    // Digest the STABLE profile fields only — observedAt is a fresh timestamp on every heartbeat, so
    // including it would make profileDigest change every time and permanently defeat the
    // AIMAC_HEARTBEAT_PERSIST_FLOOR_MS throttle (forcing a full central write on every heartbeat).
    const {observedAt, ...stableProfile} = node.profile;
    node.profileDigest = digestOf(stableProfile);
  }
  // 心跳只能清掉"我们一段时间没听到它"这类状态（initializing/offline）。
  // degraded 是自检给出的结论，而心跳【不重做自检】：把它改回 online，界面上就会出现
  // "在线 + 自检未通过 + 只读"这种自相矛盾的一行 —— 人看到在线，却不明白为什么它领不到活。
  // 执行方拿不到派发时每 5 分钟会重做一次自检（runtime 的 re-admission 自检），
  // 问题修好后状态自己会恢复，不需要靠心跳把它抹平。
  const selfCheckStillFailing = Array.isArray(node.selfCheckMissing) && node.selfCheckMissing.length > 0;
  if (["initializing", "offline"].includes(node.status)) node.status = "online";
  else if (node.status === "degraded" && !selfCheckStillFailing) node.status = "online";
  const presentedDigest = digestOf(`agent-node:${node.nodeId}:${String(options.presentedToken || "")}`);
  const usingPreviousCredential = node.previousCredentialDigest === presentedDigest
    && new Date(node.previousCredentialExpiresAt || 0).getTime() > Date.now();
  let rotatedNodeToken;
  if (!usingPreviousCredential && (!node.credentialExpiresAt || new Date(node.credentialExpiresAt).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000)) {
    rotatedNodeToken = `aimac_node_${randomBytes(40).toString("base64url")}`;
    node.previousCredentialDigest = node.credentialDigest;
    node.previousCredentialExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    node.credentialDigest = digestOf(`agent-node:${node.nodeId}:${rotatedNodeToken}`);
    node.credentialIssuedAt = at;
    node.credentialExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  }
  // NOTE: the node heartbeat deliberately does NOT renew dispatch claims. Claim renewal comes only from
  // dispatch-specific execution events (recordAgentExecutionEvent) — the agent emits a keepalive execution
  // event ~every 60s while actually executing, far under the claim TTL. A blanket heartbeat renewal would
  // keep an ORPHANED running dispatch (lost claim response / agent crashed mid-dispatch) alive forever
  // (renewed but never executed), wedging its close barrier; without it the orphan's claim expires and
  // recycleExpiredClaims requeues it, while a genuinely-executing dispatch stays renewed by its events.
  // Drive dead-node reconciliation from ANY heartbeat, not only from a claim poll: otherwise a stranded
  // dispatch (expired claim / ACK-timeout backstop) is recovered only when some other online+full node
  // happens to pull work — never on an idle/degraded/read_only fleet. This makes recovery elapsed-time
  // driven. A requeue here must force a persist even if this node's own fields are unchanged.
  const reconciled = recycleExpiredClaims(state);
  const heartbeatPersistFloorMs = clampEnvNumber(process.env.AIMAC_HEARTBEAT_PERSIST_FLOOR_MS, 30000, 120000);
  const persistRequired = reconciled ||
    Boolean(rotatedNodeToken) ||
    node.status !== previousStatus ||
    node.profileDigest !== previousProfileDigest ||
    !previousHeartbeatAt ||
    Date.now() - new Date(previousHeartbeatAt).getTime() >= heartbeatPersistFloorMs ||
    (node.activeDispatchIds || []).length > 0;
  appendGatewayEvent(state, "node_heartbeat", node.nodeId, {profileDigest: node.profileDigest, credentialRotated: Boolean(rotatedNodeToken)});
  const queuedCommands = (state.agentControlCommands || []).filter((command) => command.nodeId === node.nodeId && command.status === "queued").length;
  return {ok: true, accepted: true, commandsAvailable: queuedCommands, node: publicAgentNode(node, {state}), serverTime: at, persistRequired, ...(rotatedNodeToken ? {nodeToken: rotatedNodeToken} : {})};
}

// Keep dispatch-bound MCP grants alive as long as the claim is renewed, so a long-running dispatch
// never silently loses MCP access mid-execution when it outlives the initial claim TTL. Only
// refreshes already-issued grants — it must never resurrect a revoked one.
function refreshDispatchGrantExpiry(state, dispatch, expiresAt, at) {
  for (const grant of state.mcpGrants || []) {
    if (grant.dispatchId === dispatch.dispatchId && grant.grantStatus === "issued") {
      grant.expiresAt = expiresAt;
      grant.updatedAt = at;
    }
  }
}

// 吊销【凭据】与重排【派发】是两件事，原先被绑在一起。重排派发确有重复执行风险，所以要等 ACK
// 或等节点确实死掉；但吊销凭据没有这个风险，它纯粹是栅栏。绑在一起的后果是：一个被入侵的节点
// 只要不 ACK、继续心跳，就永远不会被置为 revoked —— 而 nodeAcceptsToken 只在 revoked 时拒绝，
// 于是它的令牌无限期有效。空闲节点更糟：ACK 超时兜底遍历的是派发，它根本不在循环里。
// 而控制台显示的是"已请求撤销"，运维会认为已经断开。
//
// 派发不在这里重排：凭据一死，它做不了 claim/续约/push，租约到期由 recycleExpiredClaims 回收，
// 那条路径会推进 claimEpoch 并标记 previousHolderMayHavePushed —— 该有的痕迹一样不少。
export function finalizeNodeCredentialRevocation(state, node, reason) {
  if (node.status === "revoked") return false;
  node.status = "revoked";
  node.admission = "read_only";
  node.revocationFinalizedAt = new Date().toISOString();
  node.revocationFinalizedReason = reason;
  delete node.revocationDeadlineAt;
  for (const dispatchId of node.activeDispatchIds || []) {
    revokeDispatchMcpGrants(state, node.nodeId, dispatchId, reason);
  }
  appendGatewayEvent(state, "node_credential_revoked", node.nodeId, {reason});
  return true;
}

// 到了截止期还没 ACK 的撤销，一律落实为凭据吊销 —— 不问节点是否还在心跳、是否还挂着派发。
// 撤销是运维已经做出的决定，节点合不合作不该决定它生不生效。
// 注册重放里存着明文 nodeToken（30 天有效），随 state 落盘 / 进 Postgres。它的用途只有一个：
// 同一个幂等键的重试要能拿回同一份结果 —— 而读取侧本来就只在重放窗口内认它（默认 10 分钟）。
// 可原先窗口过后没有任何地方清除它，于是一份长期凭据永久留在状态库与每一份备份里。
// 拿到状态库的人可以直接冒充节点，而节点凭据的设计本是"只存 credentialDigest"。
// 窗口一过就抹掉正文，留下时间戳 —— 谁都能看出这里曾经有过什么、什么时候没的。
export function redactExpiredRegistrationReplays(state, at = Date.now()) {
  const replayWindowMs = boundedInteger(process.env.AIMAC_REGISTER_REPLAY_WINDOW_MS, 60000, 3600000, 600000);
  let changed = false;
  for (const record of state.agentJoinTokens || []) {
    const replay = record.registrationReplay;
    if (!replay?.result || replay.tokenRedactedAt) continue;
    if (at - new Date(replay.at || 0).getTime() <= replayWindowMs) continue;
    delete replay.result.nodeToken;
    replay.tokenRedactedAt = new Date(at).toISOString();
    changed = true;
  }
  return changed;
}

export function finalizeOverdueRevocations(state, at = Date.now()) {
  let changed = false;
  for (const node of state.agentRuntimeNodes || []) {
    if (!node.revocationDeadlineAt || node.status === "revoked") continue;
    if (new Date(node.revocationDeadlineAt).getTime() > at) continue;
    changed = finalizeNodeCredentialRevocation(state, node, "revocation_ack_deadline_elapsed") || changed;
  }
  return changed;
}

export function requestAgentNodeRevocation(state, node, input = {}, options = {}) {
  ensureAgentGatewayCollections(state);
  // 立即切断：已知失陷时，十分钟也太久。凭据当场作废，派发交给租约到期回收。
  if (input.force === true) {
    finalizeNodeCredentialRevocation(state, node, "operator_forced_revocation");
    appendGatewayEvent(state, "node_revocation_forced", node.nodeId, {actor: options.actor || null});
    return {nodeId: node.nodeId, status: node.status, command: null, pendingDispatchIds: [], requeuedDispatchIds: [], forced: true};
  }
  const result = createAgentControlCommand(state, node, {
    ...input,
    commandType: "revoke",
    payload: {...(input.payload || {})}
  }, options);
  const pendingDispatchIds = [...(result.command.payload?.activeDispatchIds || [])];
  // 截止期：优雅撤销要给节点时间把派发交回来（它还需要有效令牌才能 ACK），但这段时间必须有尽头。
  const ackTimeoutMs = boundedInteger(process.env.AIMAC_REVOCATION_ACK_TIMEOUT_MS, 60000, 3600000, 600000);
  node.revocationDeadlineAt = new Date(Date.now() + ackTimeoutMs).toISOString();
  appendGatewayEvent(state, "node_revocation_requested", node.nodeId, {commandId: result.command.commandId, pendingDispatchIds, deadlineAt: node.revocationDeadlineAt});
  return {nodeId: node.nodeId, status: node.status, command: result.command, pendingDispatchIds, requeuedDispatchIds: []};
}

function ensureDispatchMcpGrants(state, dispatch, node) {
  state.mcpGrants ||= [];
  const contract = state.agentTaskContracts.find((item) => item.sessionId === dispatch.sessionId && item.runId === dispatch.runId);
  const at = new Date().toISOString();
  const expiresAt = dispatch.claimExpiresAt || new Date(Date.now() + 30 * 60 * 1000).toISOString();
  for (const toolName of node.allowedMcpTools || []) {
    if (toolName === "*") continue;
    const existing = state.mcpGrants.find((grant) =>
      grant.principalRef === `agent-node:${node.nodeId}` &&
      grant.dispatchId === dispatch.dispatchId &&
      grant.toolName === toolName &&
      grant.grantStatus === "issued"
    );
    if (existing) {
      existing.expiresAt = expiresAt;
      existing.updatedAt = at;
      continue;
    }
    const serverId = toolName.split(".")[0];
    const grantSeed = {
      grantId: createId("mcp_grant"),
      serverId,
      toolName,
      principalRef: `agent-node:${node.nodeId}`,
      agentNodeId: node.nodeId,
      dispatchId: dispatch.dispatchId,
      projectId: dispatch.projectId,
      taskGroupId: dispatch.taskGroupId,
      workId: dispatch.workItemId,
      sessionId: dispatch.sessionId,
      runId: dispatch.runId,
      roleId: contract?.roleId || dispatch.roleId
    };
    state.mcpGrants.unshift({
      schemaVersion: "mcp-grant/v1",
      ...grantSeed,
      endpointPath: "/mcp",
      transport: "streamable-http",
      resource: `mcp://${toolName}`,
      action: `mcp:${toolName}`,
      issuedAt: at,
      expiresAt,
      schemaDigest: digestOf(`mcp-tool:${toolName}:v1`),
      policyDecisionRef: `policy:mcp:${toolName}:dispatch:${dispatch.dispatchId}`,
      approvalRequestRef: "approval:dispatch-bound-agent-grant",
      riskLevel: dispatchBoundRiskLevel(toolName),
      paramPolicyRef: `policy://mcp/dispatch-bound/${toolName}`,
      paramPolicyDigest: digestOf(grantSeed),
      resultFilterRef: "filter://mcp/agent-dispatch-scope",
      resultFilterDigest: digestOf("filter://mcp/agent-dispatch-scope"),
      leaseRef: "lease:dispatch-scope",
      idempotencyKey: "*",
      maxTtl: "PT6H",
      grantStatus: "issued",
      revocationRef: "revocation:none",
      auditRef: `audit:mcp-grant:${dispatch.dispatchId}:${toolName}`,
      grantDigest: digestOf(grantSeed)
    });
  }
  state.mcpGrants = capMcpGrants(state, state.mcpGrants);
}

// Never evict a still-issued grant of a live (running/blocked) dispatch: authorization reads
// state.mcpGrants for grantStatus==="issued", so a blind slice would strip the oldest grants of the
// LONGEST-running dispatches and deny them MCP access mid-execution. Keep all live-issued grants; trim
// only terminal/revoked/expired grants (or grants of finished dispatches). Mirrors capLeaseHistory.
function capMcpGrants(state, grants, limit = 4000) {
  if (!Array.isArray(grants) || grants.length <= limit) return grants;
  const liveDispatchIds = new Set((state.agentDispatches || [])
    .filter((dispatch) => dispatch.status === "running" || dispatch.status === "blocked")
    .map((dispatch) => dispatch.dispatchId));
  const isLive = (grant) => grant.grantStatus === "issued" && liveDispatchIds.has(grant.dispatchId);
  const live = grants.filter(isLive);
  const rest = grants.filter((grant) => !isLive(grant)).slice(0, Math.max(0, limit - live.length));
  return [...live, ...rest];
}

export function revokeDispatchMcpGrants(state, nodeId, dispatchId, reason) {
  const at = new Date().toISOString();
  for (const grant of state.mcpGrants || []) {
    if (grant.agentNodeId !== nodeId || grant.dispatchId !== dispatchId || grant.grantStatus !== "issued") continue;
    grant.grantStatus = "revoked";
    grant.revocationRef = `revocation:${reason}`;
    grant.updatedAt = at;
  }
}

function dispatchBoundRiskLevel(toolName) {
  if (toolName.includes("grant") || toolName.includes("account") || toolName.includes("approval") || toolName.includes("lease")) return "L2";
  return "L1";
}

export function selfCheckAgentNode(state, node, input = {}) {
  if (input.profile) {
    node.profile = sanitizeNodeProfile(input.profile);
    // Digest the STABLE profile fields only — observedAt is a fresh timestamp on every heartbeat, so
    // including it would make profileDigest change every time and permanently defeat the
    // AIMAC_HEARTBEAT_PERSIST_FLOOR_MS throttle (forcing a full central write on every heartbeat).
    const {observedAt, ...stableProfile} = node.profile;
    node.profileDigest = digestOf(stableProfile);
  }
  const checks = normalizeChecks(input.checks || []);
  const required = ["runtime", "gateway", "filesystem", "git", "remote_mcp", "model_executor"];
  const missing = required.filter((checkId) => !checks.some((check) => check.checkId === checkId && check.status === "ok"));
  const at = new Date().toISOString();
  node.lastSelfCheckAt = at;
  node.selfCheckDigest = digestOf(checks);
  // 缺哪几项原先只进网关事件的负载（那条流没有任何界面）与给 agent 的响应，节点记录上只留一个摘要 ——
  // 于是人在控制台看到"降级 / 只读"，而"为什么降级"没有答案。落在节点上，它才跟着节点一起被人看见。
  if (missing.length) node.selfCheckMissing = missing;
  else delete node.selfCheckMissing;
  // 缺哪几项已经落到节点上了，但【为什么缺】还留在 checks 里没人读：人看到"自检未通过：gateway"，
  // 分不清是 DNS、TLS、401 还是服务端没起，只能上那台机器翻日志。agent 那一侧知道确切原因，
  // 这里把失败项的 detail 一并留下（限长，且只留失败的那几条）。
  const failureDetails = checks
    .filter((check) => check.status !== "ok" && missing.includes(check.checkId) && String(check.detail || "").trim())
    .slice(0, required.length)
    .map((check) => ({checkId: check.checkId, detail: String(check.detail).slice(0, 300)}));
  if (failureDetails.length) node.selfCheckFailures = failureDetails;
  else delete node.selfCheckFailures;
  if (node.status !== "draining") {
    node.status = missing.length ? "degraded" : "online";
    node.admission = missing.length ? "read_only" : "full";
  }
  node.updatedAt = at;
  appendGatewayEvent(state, "node_self_check", node.nodeId, {status: node.status, missing});
  return {ok: missing.length === 0, admission: node.admission, missingChecks: missing, node: publicAgentNode(node, {state})};
}

// 只对 /mcp 有效的执行器凭据。刻意不复用 authenticateAgentNode：那一条同时给网关端点放行，
// 而这份凭据的全部意义就是【不能】做那些事。
export function authenticateExecutorPrincipal(state, token) {
  const presented = String(token || "");
  if (!presented) return null;
  for (const dispatch of state.agentDispatches || []) {
    if (dispatch.status !== "running" || !dispatch.executorTokenDigest || !dispatch.assignedNodeId) continue;
    if (!dispatch.claimExpiresAt || new Date(dispatch.claimExpiresAt).getTime() <= Date.now()) continue;
    if (dispatch.executorTokenDigest !== digestOf(`executor:${dispatch.dispatchId}:${dispatch.claimEpoch}:${presented}`)) continue;
    const node = (state.agentRuntimeNodes || []).find((item) => item.nodeId === dispatch.assignedNodeId);
    if (!node || node.status === "revoked") return null;
    return {node, dispatch};
  }
  return null;
}

export function claimNextDispatch(state, node, options = {}) {
  ensureAgentGatewayCollections(state);
  if (node.status !== "online" || node.admission !== "full") return {dispatch: null, reason: "node_not_admitted", missDetail: {admission: node.admission, status: node.status}};
  recycleExpiredClaims(state);
  expireStaleQueuedDispatches(state);
  const eligibleProjectIds = runtimeNodeProjectIds(state, node);
  const eligibleProjectIdSet = new Set(eligibleProjectIds);
  // 治理动作必须挡住【已经排队】的派发，不只是挡住新建。
  //
  // 编排周期跳过被暂停的任务组、也跳过被停用组织名下的任务组 —— 但那只防住"再造新的"。
  // 已经在队列里的派发，此前照样会被节点领走执行：暂停一个任务组、停用一个组织之后，
  // agent 仍在跑、模型额度仍在烧，而控制台上写着"已暂停/已停用"。（我上一轮只修了新建那一半。）
  // 两张小表在这里各建一次（认领是低频调用，不在每单元的热路径上），单条判定是 O(1)。
  const suspendedOrgIds = new Set((state.organizations || [])
    .filter((organization) => organization.status === "suspended").map((organization) => organization.orgId));
  const projectOrgId = suspendedOrgIds.size
    ? new Map((state.projects || []).map((project) => [project.id, project.organizationId || "org_default"]))
    : null;
  const haltedTaskGroupIds = new Set();
  for (const taskGroup of state.taskGroups || []) {
    const paused = ["active_paused_by_freeze", "active_paused_by_control"].includes(taskGroup.goalExecutionStatus);
    const orgHalted = projectOrgId && suspendedOrgIds.has(projectOrgId.get(taskGroup.projectId));
    if (paused || orgHalted) haltedTaskGroupIds.add(taskGroup.id);
  }
  let haltedCandidates = 0;
  const dispatch = state.agentDispatches.find((item) => {
    if (item.status !== "queued") return false;
    if (haltedTaskGroupIds.has(item.taskGroupId)) { haltedCandidates += 1; return false; }
    if (!eligibleProjectIdSet.has(item.projectId)) return false;
    if (item.assignedNodeId && item.assignedNodeId !== node.nodeId) return false;
    const contract = state.agentTaskContracts.find((candidate) => candidate.sessionId === item.sessionId && candidate.runId === item.runId);
    if (!contract || (contract.expiresAt && new Date(contract.expiresAt).getTime() <= Date.now())) return false;
    return roleAllowed(contract.roleId, node.allowedRoles) && modelRunnable(contract.model, node.profile);
  });
  if (!dispatch) {
    // "在线但不领活"此前在控制台上完全不可诊断：no_compatible_dispatch 只回给 agent，不落库；
    // 而派发需要什么角色/什么模型根本不在任何视图里（agentTaskContracts 不下发）。人看到的是一个
    // 绿色"在线/完全准入"的节点加一条"排队中"的派发，两种原因（角色不匹配 / 模型不可用）
    // 在界面上长得一模一样。控制面在筛的时候就知道答案，只是没把它留下来。
    // 区分"没有匹配的活"与"活被治理动作挡住了"：两者在界面上原本长得一模一样，
    // 而后者会让人去查角色/模型为什么不匹配 —— 那是一条完全找错方向的排查路径。
    if (haltedCandidates > 0) {
      // 沿用界面既有的形状（queuedCount + reasons[]）：claimMissHint 缺 queuedCount 会整条不渲染 ——
      // 那样这条诊断只存在于返回值里，控制台上依旧什么都看不到。
      const haltedChanged = recordClaimMiss(node, {queuedCount: haltedCandidates,
        at: new Date().toISOString(), reasons: [{reason: "execution_halted"}]});
      return {dispatch: null, reason: "execution_halted", stateChanged: haltedChanged, missDetail: {queuedCount: haltedCandidates}};
    }
    // 未命中的摘要（排队几个、每个为什么轮不到本节点）原先只落到节点记录给控制台看；agent 自己的终端上一个字没有。一并回给它。
    const miss = summarizeClaimMiss(state, node, eligibleProjectIdSet);
    const missChanged = recordClaimMiss(node, miss);
    return {dispatch: null, reason: "no_compatible_dispatch", stateChanged: missChanged, missDetail: miss};
  }
  delete node.lastClaimMiss;
  const at = new Date().toISOString();
  dispatch.status = "running";
  dispatch.assignedNodeId = node.nodeId;
  // Clear the prior-owner marker on (re)claim: it exists only so a just-unbound node can read its own
  // terminal permission_status. A live re-claim by a DIFFERENT node must not leave the former owner able
  // to read the new owner's session permission requests.
  delete dispatch.previousNodeId;
  dispatch.claimedAt = at;
  // claim 代次：每次因过期/撤销把派发收回并重排队时递增。旧持有者拿着的是旧代次，
  // 于是它在做不可逆动作（push）之前复核时能自己发现"我已经不是持有者了"。
  // 没有这个代次时，一个网络分区 30 分钟的节点恢复后会直接把提交 push 上去，
  // 而新持有者的 reset --hard origin/<branch> 会把那些提交静默当作基线继续往上做。
  dispatch.claimEpoch = Number(dispatch.claimEpoch || 0) + 1;
  dispatch.claimTtlSeconds = boundedInteger(options.claimTtlSeconds, 60, 21600, 1800);
  dispatch.claimExpiresAt = new Date(Date.now() + dispatch.claimTtlSeconds * 1000).toISOString();
  dispatch.attempts = Number(dispatch.attempts || 0) + 1;
  dispatch.updatedAt = at;
  node.activeDispatchIds = uniqueStrings([...(node.activeDispatchIds || []), dispatch.dispatchId]);
  node.updatedAt = at;
  ensureDispatchMcpGrants(state, dispatch, node);
  // 执行器（宿主机上跑的那个 AI CLI）此前拿到的是【节点令牌】—— 与网关端点用的是同一份凭据。
  // 于是一个被提示注入的模型不只是能用 MCP：它能心跳、能领取本项目内的其他派发、能报执行事件。
  // 改为按派发签发一份只对 /mcp 有效的凭据，网关端点一律不认它。
  // 有效性从活的状态派生（派发仍在运行、认领未过期、代次匹配），而不是靠记得在每条回收路径上
  // 清字段 —— 重排/撤销/换持有者时旧令牌自动失效，少一处忘记就少一个洞。
  const executorToken = randomBytes(32).toString("hex");
  dispatch.executorTokenDigest = digestOf(`executor:${dispatch.dispatchId}:${dispatch.claimEpoch}:${executorToken}`);
  appendGatewayEvent(state, "dispatch_claimed", dispatch.dispatchId, {nodeId: node.nodeId});
  return {dispatch: {...buildDispatchPackage(state, dispatch, node, options), executorToken}};
}

// Cap the node registry without ever dropping a live node: a register->revoke loop otherwise
// accumulates full node records (profile.tools/models up to 100 each) forever, since revoke only flips
// status (the record is never spliced) and frees the org quota. Keep all live nodes; trim oldest
// terminal (revoked/retired/offline) first.
// Never evict a still-redeemable join token (issued + unexpired): a blind slice would drop an
// outstanding token and its one-command join would then fail token_not_found. Trim consumed/expired first.
function capAgentJoinTokens(tokens, limit = 500) {
  if (!Array.isArray(tokens) || tokens.length <= limit) return tokens;
  const nowMs = Date.now();
  const isLive = (token) => token.status === "issued" && new Date(token.expiresAt || 0).getTime() > nowMs;
  const live = tokens.filter(isLive);
  const rest = tokens.filter((token) => !isLive(token)).slice(0, Math.max(0, limit - live.length));
  return [...live, ...rest];
}

// Never evict a still-active control command (queued/delivered/received): a later ackAgentControlCommand
// would then throw agent_control_command_not_found, and a paired blocked dispatch (e.g. resume) would
// never be acted on. Keep active commands; trim oldest acknowledged/terminal first.
function capAgentControlCommands(commands, limit = 2000) {
  if (!Array.isArray(commands) || commands.length <= limit) return commands;
  const activeStatuses = new Set(["queued", "delivered", "received"]);
  const active = commands.filter((command) => activeStatuses.has(command.status));
  const done = commands.filter((command) => !activeStatuses.has(command.status)).slice(0, Math.max(0, limit - active.length));
  return [...active, ...done];
}

function capAgentRuntimeNodes(nodes, limit = 2000) {
  if (!Array.isArray(nodes) || nodes.length <= limit) return nodes;
  const liveStatuses = new Set(["online", "draining", "initializing", "degraded"]);
  const live = nodes.filter((node) => liveStatuses.has(node.status));
  const dead = nodes.filter((node) => !liveStatuses.has(node.status)).slice(0, Math.max(0, limit - live.length));
  return [...live, ...dead];
}

// 全仓唯一会把节点标成非活状态的地方，是 shutdown 完成、revoke 完成、以及 ACK 超时兜底 ——
// 而 ACK 超时那条只在"该节点恰好带着一个 pending stop 标记的派发"时才走到。纯崩溃的节点
// 因此【永远停在 online】，后果是连锁的：
//   · capAgentRuntimeNodes 把 online 视为存活、永不裁剪 → 节点集合无界增长；
//   · recomputeOrganizationUsage 按 status !== "revoked" 统计 agents 配额 → 崩过的节点永久占额，
//     最终 createAgentJoinToken 报 org_quota_exceeded，再也接不了新节点；
//   · 给它排队的控制命令永远投不出去、永远不会被 ack、永远算"活跃"，把持久层的分片上限推过阈值。
// 判定用的是服务端时间与节点上报心跳的间隔，与代理端时钟无关。
// 不可逆动作（push）之前的 claim 复核。运行时在 push 前调用它；代次对不上就中止，
// 而不是推完之后才在提交检查点时拿到一个 404 —— 那时提交已经在远端分支上了。
export function validateDispatchClaim(state, node, dispatchId, claimEpoch) {
  const dispatch = (state.agentDispatches || []).find((item) => item.dispatchId === dispatchId);
  if (!dispatch) return {valid: false, reason: "dispatch_not_found"};
  if (dispatch.assignedNodeId !== node.nodeId) return {valid: false, reason: "claim_reassigned", claimEpoch: Number(dispatch.claimEpoch || 0)};
  if (dispatch.status !== "running") return {valid: false, reason: `dispatch_${dispatch.status}`, claimEpoch: Number(dispatch.claimEpoch || 0)};
  if (claimEpoch !== undefined && Number(claimEpoch) !== Number(dispatch.claimEpoch || 0)) {
    return {valid: false, reason: "claim_epoch_stale", claimEpoch: Number(dispatch.claimEpoch || 0)};
  }
  const expiresAt = new Date(dispatch.claimExpiresAt || 0).getTime();
  if (!expiresAt || expiresAt <= Date.now()) return {valid: false, reason: "claim_expired", claimEpoch: Number(dispatch.claimEpoch || 0)};
  return {valid: true, claimEpoch: Number(dispatch.claimEpoch || 0), claimExpiresAt: dispatch.claimExpiresAt};
}

// 判死的阈值要【下发给界面】：界面上"在线"这个字来自 node.status，而 status 只有在扫描跑过之后
// 才会翻成 offline —— 扫描挂在编排拍上，拍不跑它就一直写着"在线"。实测读到过「在线 + 已 175 分钟
// 没有心跳」同行并排。界面自己再写死一个阈值就成了第二个真相源，所以从这里取同一个数。
export function nodeHeartbeatTimeoutMs() {
  return boundedInteger(process.env.AIMAC_NODE_HEARTBEAT_TIMEOUT_MS, 60000, 86400000, 900000);
}

// 「这个节点的心跳过期了没」只有这一处判据：扫描把它标 offline 用它，健康检查算"在线节点数"也用它。
// 原先健康检查按 node.status === "online" 数 —— 而 status 只在扫描跑过之后才翻成 offline（扫描挂在
// 编排拍上），于是一批早就没心跳的节点在监控眼里一直"在线"。
export function agentNodeHeartbeatOverdue(node, nowMs = Date.now(), graceMs = nodeHeartbeatTimeoutMs()) {
  if (!["online", "degraded", "draining", "initializing"].includes(node?.status)) return false;
  const lastBeat = new Date(node.lastHeartbeatAt || node.registeredAt || 0).getTime();
  return Boolean(lastBeat) && nowMs - lastBeat >= graceMs;
}

export function agentNodeHealthSummary(state, nowMs = Date.now()) {
  const graceMs = nodeHeartbeatTimeoutMs();
  const nodes = state.agentRuntimeNodes || [];
  const overdueNodes = nodes.filter((node) => agentNodeHeartbeatOverdue(node, nowMs, graceMs)).map((node) => ({
    nodeId: node.nodeId, nodeName: node.nodeName || null, status: node.status, lastHeartbeatAt: node.lastHeartbeatAt || null,
    overdueMs: nowMs - new Date(node.lastHeartbeatAt || node.registeredAt || 0).getTime()
  }));
  const overdueIds = new Set(overdueNodes.map((node) => node.nodeId));
  return {onlineNodes: nodes.filter((node) => node.status === "online" && !overdueIds.has(node.nodeId)).length, overdueNodes};
}

export function sweepDeadAgentNodes(state, nowMs = Date.now()) {
  const graceMs = nodeHeartbeatTimeoutMs();
  const swept = [];
  for (const node of state.agentRuntimeNodes || []) {
    if (!agentNodeHeartbeatOverdue(node, nowMs, graceMs)) continue;
    node.status = "offline";
    node.admission = "read_only";
    node.offlineReason = "heartbeat_timeout";
    node.updatedAt = new Date(nowMs).toISOString();
    // 它名下还排着的控制命令永远投不出去了：留着既不会被 ack，又会被 cap 当作活跃项一直保留。
    for (const command of state.agentControlCommands || []) {
      if (command.nodeId !== node.nodeId) continue;
      if (!["queued", "delivered", "received"].includes(command.status)) continue;
      command.status = "expired";
      command.expiredReason = "node_heartbeat_timeout";
      command.updatedAt = new Date(nowMs).toISOString();
    }
    swept.push(node.nodeId);
    appendGatewayEvent(state, "agent_node_heartbeat_timeout", node.nodeId, {lastHeartbeatAt: node.lastHeartbeatAt || null});
  }
  // offline 仍按 status !== "revoked" 计入组织 agents 配额。一个再也不会回来的节点
  //（例如注册响应丢失留下的 initializing 僵尸）会永久扣掉一个名额，最终新节点接不进来。
  // 因此在一个【远长于】心跳宽限期的阈值之后退役它 —— 它随时可以用新的 join token 重新加入。
  const retireMs = boundedInteger(process.env.AIMAC_NODE_RETIRE_TIMEOUT_MS, 3600000, 30 * 86400000, 7 * 86400000);
  for (const node of state.agentRuntimeNodes || []) {
    if (node.status === "revoked") continue;
    const lastBeat = new Date(node.lastHeartbeatAt || node.registeredAt || 0).getTime();
    if (!lastBeat || nowMs - lastBeat < retireMs) continue;
    if ((node.activeDispatchIds || []).length) continue; // 还挂着活儿的不退役，先让回收逻辑处理
    node.status = "revoked";
    node.admission = "read_only";
    node.revokedReason = "unreachable_beyond_retire_window";
    node.updatedAt = new Date(nowMs).toISOString();
    swept.push(node.nodeId);
    appendGatewayEvent(state, "agent_node_retired_unreachable", node.nodeId, {lastHeartbeatAt: node.lastHeartbeatAt || null});
  }
  return swept;
}

export function recycleExpiredClaims(state) {
  const at = Date.now();
  let changed = sweepDeadAgentNodes(state, at).length > 0;
  changed = finalizeOverdueRevocations(state, at) || changed;
  changed = redactExpiredRegistrationReplays(state, at) || changed;
  for (const dispatch of state.agentDispatches || []) {
    if (dispatch.status !== "running" || !dispatch.claimExpiresAt || new Date(dispatch.claimExpiresAt).getTime() > at) continue;
    changed = true;
    const previousNodeId = dispatch.assignedNodeId;
    dispatch.status = "queued";
    dispatch.blockedReason = "claim_expired_requeued";
    delete dispatch.assignedNodeId;
    delete dispatch.claimedAt;
    delete dispatch.claimExpiresAt;
    // 代次前进：旧持有者从此复核不过，做不可逆动作前会自行中止。
    dispatch.claimEpoch = Number(dispatch.claimEpoch || 0) + 1;
    // 进度必须跟着代次归零。事件写入点用的是 Math.max（为的是抵抗【同一次尝试内】的乱序事件），
    // 跨尝试保留就成了谎报：上一次跑到 90%，认领过期重排后新持有者从头开始上报 5%、10%，
    // Math.max 让控制台一直显示 90% —— 人看到"快完成了"，而活刚重新开始。
    // 归零之后 Math.max 在本次尝试内仍然成立，这是它原本要解决的问题。
    dispatch.progressPercent = 0;
    // 会话与派发一一对应且跨尝试复用，进度同源同理由。当前控制台没有展示会话进度，
    // 但把两个字段留在不同状态，等于给将来展示它的人留一个同样的谎。
    const requeuedSession = (state.workSessions || []).find((item) => item.sessionId === dispatch.sessionId);
    if (requeuedSession) requeuedSession.progressPercent = 0;
    // 上一任是"失联"而不是"失败"——它可能已经把提交推到远端分支上了，而控制面对此没有任何记录。
    // 新持有者的 reset --hard origin/<branch> 会把那些提交当作基线，于是它们被静默吸收进结果里。
    // 这件事必须留痕并让人看到，而不是当作什么都没发生。
    dispatch.previousHolderMayHavePushed = true;
    dispatch.recycledFromNodeId = previousNodeId || null;
    dispatch.updatedAt = new Date().toISOString();
    const previousNode = state.agentRuntimeNodes.find((item) => item.nodeId === previousNodeId);
    if (previousNode) previousNode.activeDispatchIds = (previousNode.activeDispatchIds || []).filter((id) => id !== dispatch.dispatchId);
    revokeDispatchMcpGrants(state, previousNodeId, dispatch.dispatchId, "claim_expired_requeued");
    appendGatewayEvent(state, "dispatch_claim_expired", dispatch.dispatchId, {previousNodeId});
  }
  // Liveness backstop: a revoke/shutdown whose ACK never arrives leaves its dispatch blocked +
  // revocationPending and the node draining forever. Force-requeue ONLY when the owning node is
  // effectively dead (no heartbeat within the ACK timeout) — a live node would ACK, and requeuing a
  // still-running node would risk double execution. This preserves the ACK-gated fencing invariant.
  const ackTimeoutMs = boundedInteger(process.env.AIMAC_REVOCATION_ACK_TIMEOUT_MS, 60000, 3600000, 600000);
  for (const dispatch of state.agentDispatches || []) {
    // A shutdown pre-effect clears revocationPending (it is not a revoke) but still leaves the dispatch
    // blocked + the node draining; a revoke keeps revocationPending. Both must be backstopped, or a node
    // that dies mid-drain strands its dispatches forever. Select either shape.
    const shutdownPending = dispatch.shutdownPending || dispatch.blockedReason === "assigned_node_shutdown_pending_stop";
    // A paused dispatch has no pending-stop marker; if its node then dies it can never be resumed or
    // cancelled (the control-command API rejects a dead node), wedging it + its close barrier forever.
    // Back it up too — ONLY on a genuinely dead node (past ACK timeout), so a live-node hold is untouched.
    const pausePending = dispatch.blockedReason === "control_pause_requested";
    if ((!dispatch.revocationPending && !shutdownPending && !pausePending) || dispatch.status !== "blocked") continue;
    const node = state.agentRuntimeNodes.find((item) => item.nodeId === dispatch.assignedNodeId);
    const lastBeat = node ? new Date(node.lastHeartbeatAt || 0).getTime() : 0;
    if (node && at - lastBeat < ackTimeoutMs) continue; // node still alive; keep waiting for its ACK / hold
    changed = true;
    const previousNodeId = dispatch.assignedNodeId;
    dispatch.status = "queued";
    dispatch.blockedReason = pausePending ? "paused_node_dead_requeued" : (shutdownPending ? "shutdown_ack_timeout_requeued" : "revocation_ack_timeout_requeued");
    delete dispatch.assignedNodeId;
    delete dispatch.claimedAt;
    delete dispatch.claimExpiresAt;
    delete dispatch.revocationPending;
    delete dispatch.shutdownPending;
    dispatch.updatedAt = new Date().toISOString();
    if (node) {
      node.activeDispatchIds = (node.activeDispatchIds || []).filter((id) => id !== dispatch.dispatchId);
      node.status = shutdownPending || pausePending ? "offline" : "revoked";
      node.admission = "read_only";
    }
    const timeoutReason = pausePending ? "paused_node_dead" : (shutdownPending ? "shutdown_ack_timeout" : "revocation_ack_timeout");
    revokeDispatchMcpGrants(state, previousNodeId, dispatch.dispatchId, timeoutReason);
    appendGatewayEvent(state, pausePending ? "dispatch_paused_node_dead" : (shutdownPending ? "dispatch_shutdown_ack_timeout" : "dispatch_revocation_ack_timeout"), dispatch.dispatchId, {previousNodeId});
  }
  return changed;
}

export function getDispatchForNode(state, node, dispatchId, options = {}) {
  const dispatch = state.agentDispatches.find((item) => item.dispatchId === dispatchId && item.assignedNodeId === node.nodeId);
  if (!dispatch) throw gatewayError("dispatch_not_found", 404);
  return buildDispatchPackage(state, dispatch, node, options);
}

export function createAgentControlCommand(state, node, input = {}, options = {}) {
  // 到期时间解析不了就拒。控制命令（暂停/取消/吊销…）的 expiresAt 一旦是 NaN，
  // 判它过没过期的比较两个方向都会静默失败 —— 要么这条命令永不过期、一直挂在队列里，
  // 要么被当成早已过期而从不投递；两种都不报错。ttlSeconds 已由 boundedInteger 收敛，
  // expiresAt 此前是【原样收下调用方给的】。
  const commandExpiry = normalizedExpiry(input.expiresAt);
  if (commandExpiry === false) {
    throw gatewayError("control_command_expires_at_invalid", 400, {received: String(input.expiresAt).slice(0, 60)});
  }
  ensureAgentGatewayCollections(state);
  if (!node || node.status === "revoked") throw gatewayError("agent_node_not_active", 409);
  const commandType = normalizeControlCommandType(input.commandType || input.action || "refresh_profile");
  const at = new Date().toISOString();
  state.agentControlSequence = Number(state.agentControlSequence || 0) + 1;
  const command = {
    schemaVersion: "agent-control-command/v1",
    commandId: createId("acc"),
    sequence: state.agentControlSequence,
    nodeId: node.nodeId,
    projectId: input.projectId || node.projectIds?.[0] || null,
    taskGroupId: input.taskGroupId || null,
    sessionId: input.sessionId || null,
    dispatchId: input.dispatchId || null,
    commandType,
    payload: ["shutdown", "revoke"].includes(commandType)
      ? {...(input.payload || {}), activeDispatchIds: [...(node.activeDispatchIds || [])]}
      : input.payload || {},
    status: "queued",
    requiresAck: true,
    createdBy: options.actor || "control-plane",
    idempotencyKey: options.idempotencyKey || null,
    expiresAt: commandExpiry || new Date(Date.now() + boundedInteger(input.ttlSeconds, 60, 86400, 1800) * 1000).toISOString(),
    createdAt: at,
    updatedAt: at
  };
  applyControlCommandPreEffects(state, node, command);
  state.agentControlCommands.unshift(command);
  state.agentControlCommands = capAgentControlCommands(state.agentControlCommands);
  appendGatewayEvent(state, "agent_control_command_queued", command.commandId, {nodeId: node.nodeId, commandType, dispatchId: command.dispatchId});
  return {command};
}

export function listAgentControlCommands(state, node, input = {}) {
  ensureAgentGatewayCollections(state);
  const afterSequence = Number(input.afterSequence || 0);
  const limit = boundedInteger(input.limit, 1, 50, 20);
  const nowMs = Date.now();
  const commands = (state.agentControlCommands || [])
    .filter((command) =>
      command.nodeId === node.nodeId &&
      Number(command.sequence || 0) > afterSequence &&
      ["queued", "delivered", "received"].includes(command.status) &&
      (!command.expiresAt || new Date(command.expiresAt).getTime() > nowMs)
    )
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    .slice(0, limit);
  let deliveredCount = 0;
  const at = new Date().toISOString();
  for (const command of commands) {
    if (command.status !== "queued") continue;
    command.status = "delivered";
    command.deliveredAt = at;
    command.updatedAt = at;
    deliveredCount += 1;
  }
  return {commands, nextCursor: commands.at(-1)?.sequence || afterSequence, deliveredCount};
}

const controlAckRank = {queued: 0, delivered: 1, received: 2, acked: 3, completed: 4, failed: 4, rejected: 4};

export function ackAgentControlCommand(state, node, commandId, input = {}) {
  ensureAgentGatewayCollections(state);
  const command = state.agentControlCommands.find((item) => item.commandId === commandId && item.nodeId === node.nodeId);
  if (!command) throw gatewayError("agent_control_command_not_found", 404);
  // 认不出的状态原先静默变成 "acked"：节点想【拒绝】一条暂停命令，拼错一个字母就被记成
  // "已接受" —— 人从屏幕上看到的是 agent 收下了这条命令，而实际上它什么也没做。
  // 不带 status 仍按 acked（那是合法的默认：收到了，没别的话说）；带了但认不出的必须拒。
  // 合法值从 controlAckRank 派生：那张表本来就是这套回执状态的权威来源，
  // 再抄一份就会漂（queued/delivered 是服务端自己写的，节点报不上来，所以排除）。
  const nodeReportable = Object.keys(controlAckRank).filter((name) => !["queued", "delivered"].includes(name));
  if (input.status !== undefined && !nodeReportable.includes(input.status)) {
    throw gatewayError("agent_control_command_ack_status_unknown", 400, {supported: nodeReportable});
  }
  const status = input.status === undefined ? "acked" : input.status;
  const currentRank = controlAckRank[command.status] ?? 0;
  if (command.status === status) return {command, replayed: true};
  if (currentRank >= 4) throw gatewayError("agent_control_command_already_terminal", 409);
  if ((controlAckRank[status] ?? 0) < currentRank) throw gatewayError("agent_control_command_ack_regression", 409);
  command.status = status;
  command.acknowledgedAt = new Date().toISOString();
  command.ackResult = sanitizeAckResult(input.result || {});
  command.resultDigest = digestOf(command.ackResult);
  command.updatedAt = command.acknowledgedAt;
  if (status === "completed" && command.commandType === "revoke") finalizeNodeRevocation(state, node, command);
  if (status === "completed" && command.commandType === "shutdown") finalizeNodeShutdown(state, node, command);
  if (["failed", "rejected"].includes(status) && ["revoke", "shutdown"].includes(command.commandType)) handleStopControlFailure(state, node, command, status);
  if (["failed", "rejected"].includes(status) && ["pause_dispatch", "cancel_dispatch"].includes(command.commandType)) handleDispatchControlFailure(state, node, command, status);
  appendGatewayEvent(state, "agent_control_command_ack", command.commandId, {nodeId: node.nodeId, status});
  return {command};
}

function handleDispatchControlFailure(state, node, command, status) {
  const at = new Date().toISOString();
  const dispatch = (state.agentDispatches || []).find((item) => item.dispatchId === command.dispatchId);
  if (!dispatch) return;
  const retryAttempt = Number(command.payload?.retryAttempt || 0) + 1;
  if (status === "failed" && retryAttempt <= 3 && ["running", "blocked"].includes(dispatch.status)) {
    const retry = createAgentControlCommand(state, node, {
      commandType: command.commandType,
      dispatchId: command.dispatchId,
      payload: {...(command.payload || {}), retryOf: command.commandId, retryAttempt},
      ttlSeconds: 300
    }, {actor: "agent-gateway", idempotencyKey: `control-retry:${command.commandId}:${retryAttempt}`}).command;
    command.retryCommandId = retry.commandId;
  } else {
    // 不再重试了。此前这一支什么都不做，于是派发停在下发暂停那一刻写下的 control_pause_requested
    // ——「控制通道请求暂停」。而真相是：节点连拒了 4 次、不会再有第 5 次，**agent 仍在跑**。
    // 控制台显示"已暂停"而世界上没有暂停，这比看不见更糟：人以为处置完了。
    // 换成说真话的终态原因，并记下试了几次、最后一次报了什么，人才判断得了下一步。
    const rejectedReason = command.commandType === "pause_dispatch"
      ? "control_pause_rejected_by_node"
      : "control_cancel_rejected_by_node";
    dispatch.controlFailure = {
      commandType: command.commandType,
      attempts: retryAttempt,
      lastStatus: status,
      lastError: String(command.result?.error || command.failureReason || "").slice(0, 200) || undefined,
      at
    };
    // 取消在下发那一刻就把派发写成了终态 cancelled；把它翻回 blocked 是让终态复活，
    // 编排会把它当活的重新处理。终态就留在终态，只把【失败原因】改成说真话的那一条。
    if (isTerminalDispatchStatus(dispatch.status)) {
      if (dispatch.status === "cancelled") dispatch.failureReason = rejectedReason;
    } else {
      dispatch.status = "blocked";
      dispatch.blockedReason = rejectedReason;
      const failedSession = state.workSessions.find((item) => item.sessionId === dispatch.sessionId);
      if (failedSession && !["completed_objective", "recycled", "failed", "aborted"].includes(failedSession.status)) {
        failedSession.status = "needs_decision";
        failedSession.blockedReason = rejectedReason;
        failedSession.updatedAt = at;
      }
      const failedTaskGroup = state.taskGroups.find((item) => item.id === dispatch.taskGroupId);
      const failedWorkItem = failedTaskGroup?.workItems?.find((item) => item.id === dispatch.workItemId);
      if (failedWorkItem && !["verified", "closed"].includes(failedWorkItem.status)) {
        failedWorkItem.status = "needs_decision";
        failedWorkItem.blockedReason = rejectedReason;
        failedWorkItem.updatedAt = at;
      }
    }
  }
  const taskGroup = state.taskGroups.find((item) => item.id === dispatch.taskGroupId);
  if (taskGroup) {
    taskGroup.health = "attention";
    taskGroup.updatedAt = at;
  }
  command.failureHandledAt = at;
  appendGatewayEvent(state, "agent_dispatch_control_ack_failure", command.commandId, {nodeId: node.nodeId, commandType: command.commandType, status, dispatchId: dispatch.dispatchId, retryCommandId: command.retryCommandId || null});
}

export function submitAgentExecutionEvent(state, node, input = {}) {
  const prepared = prepareAgentExecutionEvent(state, node, input);
  if (prepared.duplicate) return prepared;
  return recordAgentExecutionEvent(state, node, prepared.event);
}

export function prepareAgentExecutionEvent(state, node, input = {}) {
  ensureAgentGatewayCollections(state);
  const dispatchId = String(input.dispatchId || "").trim();
  const dispatch = state.agentDispatches.find((item) => item.dispatchId === dispatchId && item.assignedNodeId === node.nodeId);
  if (!dispatch) throw gatewayError("dispatch_not_found", 404);
  const eventKey = String(input.eventKey || "").slice(0, 240);
  if (!eventKey) throw gatewayError("execution_event_key_required", 400);
  if (eventKey) {
    // 幂等去重必须【限定在这次派发内】。原先是全局按 eventKey 匹配，而 eventKey 由调用方提供：
    // 一个节点抢注另一个节点的 key，就能压制对方的执行证据（对方的上报被当成重复丢弃），
    // 并且命中的事件会被原样返回，连带读到对方的 summary/sessionId。证据完整性是验收闸门的地基。
    const existing = (state.agentExecutionEvents || []).find((item) => item.eventKey === eventKey && item.dispatchId === dispatchId);
    if (existing) return {event: existing, duplicate: true};
  }
  const at = new Date().toISOString();
  const nextSequence = Math.max(Number(state.agentExecutionSequence || 0) + 1, Date.now() * 1000 + Math.floor(Math.random() * 1000));
  state.agentExecutionSequence = nextSequence;
  const eventType = normalizeExecutionEventType(input.eventType || input.phase || "progress");
  const event = {
    schemaVersion: "agent-execution-event/v1",
    eventId: createId("aee"),
    sequence: nextSequence,
    nodeId: node.nodeId,
    dispatchId,
    projectId: dispatch.projectId,
    taskGroupId: dispatch.taskGroupId,
    workItemId: dispatch.workItemId,
    sessionId: dispatch.sessionId,
    runId: dispatch.runId,
    eventType,
    progressPercent: boundedInteger(input.progressPercent, 0, 100, progressForEventType(eventType)),
    status: ["running", "attention", "failed", "completed"].includes(input.status) ? input.status : statusForExecutionEvent(eventType),
    summary: String(input.summary || "").slice(0, 1000),
    outputTailDigest: /^sha256:[0-9a-f]{64}$/u.test(String(input.outputTailDigest || "")) ? input.outputTailDigest : null,
    evidenceRefs: uniqueStrings(input.evidenceRefs || []).slice(0, 40),
    eventKey: eventKey || null,
    payloadDigest: digestOf(input.payload || input.summary || eventType),
    languagePolicyDigest: dispatch.languagePolicyDigest || null,
    createdAt: at
  };
  return {event};
}

export function recordAgentExecutionEvent(state, node, event = {}, options = {}) {
  ensureAgentGatewayCollections(state);
  const dispatch = state.agentDispatches.find((item) =>
    item.dispatchId === event.dispatchId &&
    (item.assignedNodeId === node.nodeId || (options.allowHistoricalNodeBinding && event.nodeId === node.nodeId))
  );
  if (!dispatch) throw gatewayError("dispatch_not_found", 404);
  if (event.eventKey) {
    // 同上：按 (eventKey, dispatchId) 去重，跨派发的同名 key 互不影响。
    const existing = (state.agentExecutionEvents || []).find((item) => item.eventKey === event.eventKey && item.dispatchId === event.dispatchId);
    if (existing) return {event: existing, duplicate: true};
  }
  if ((state.agentExecutionEvents || []).some((item) => item.eventId === event.eventId)) return {event, duplicate: true};
  state.agentExecutionSequence = Math.max(Number(state.agentExecutionSequence || 0), Number(event.sequence || 0));
  state.agentExecutionEvents.unshift(event);
  // 上限取【存储层那一份】：这里原先写死 500，比分片的 1000 更严 ——
  // 真正生效的是这个看不见的数，而且它切掉的那些不记账（分片那层的记账根本看不到它们，
  // 记录在到达分片之前就已经没了）。同一个数 + 记账，界面才说得出「这个数是剩下的」。
  const executionEventLimit = PROJECT_SHARD_COLLECTION_LIMITS.agentExecutionEvents;
  if (state.agentExecutionEvents.length > executionEventLimit) {
    const dropped = state.agentExecutionEvents.length - executionEventLimit;
    state.agentExecutionEvents = state.agentExecutionEvents.slice(0, executionEventLimit);
    state.centralDroppedCounts = state.centralDroppedCounts || {};
    state.centralDroppedCounts.agentExecutionEvents =
      Number(state.centralDroppedCounts.agentExecutionEvents || 0) + dropped;
  }
  const at = event.createdAt || new Date().toISOString();
  if (dispatch.status === "running" && dispatch.assignedNodeId === node.nodeId && dispatch.claimExpiresAt) {
    const ttlSeconds = boundedInteger(dispatch.claimTtlSeconds, 60, 21600, 1800);
    const renewed = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    if (renewed > dispatch.claimExpiresAt) {
      dispatch.claimExpiresAt = renewed;
      refreshDispatchGrantExpiry(state, dispatch, renewed, at);
    }
  }
  updateExecutionProgress(state, dispatch, event, at);
  appendGatewayEvent(state, "agent_execution_event", event.eventId, {nodeId: node.nodeId, dispatchId: event.dispatchId, eventType: event.eventType, progressPercent: event.progressPercent});
  return {event};
}

function applyControlCommandPreEffects(state, node, command) {
  if (["revoke", "shutdown"].includes(command.commandType)) {
    applyNodeStopPreEffects(state, node, command);
    return;
  }
  if (!["pause_dispatch", "cancel_dispatch", "resume_dispatch"].includes(command.commandType)) return;
  const dispatch = findNodeDispatchForControl(state, node, command);
  if (!dispatch) throw gatewayError("control_dispatch_not_active", 409);
  // Defense-in-depth (the HTTP route already rejects this): resume may only revive a BLOCKED dispatch.
  // Requeuing a still-running dispatch would let a second node re-claim and re-run the same runId while
  // the original node keeps executing → double execution + orphaned push.
  if (command.commandType === "resume_dispatch" && dispatch.status !== "blocked") throw gatewayError("dispatch_not_resumable", 409);
  const at = command.createdAt;
  command.dispatchId = dispatch.dispatchId;
  command.projectId = dispatch.projectId;
  command.taskGroupId = dispatch.taskGroupId;
  command.sessionId = dispatch.sessionId;
  dispatch.controlCommandRef = command.commandId;
  dispatch.controlRequestedAt = at;
  if (dispatch.blockedReason === "awaiting_human_confirmation") cancelPendingConfirmationsForDispatch(state, dispatch.dispatchId, `control_${command.commandType}`);
  if (command.commandType === "pause_dispatch") {
    dispatch.status = "blocked";
    dispatch.blockedReason = "control_pause_requested";
  } else if (command.commandType === "cancel_dispatch") {
    dispatch.status = "cancelled";
    dispatch.failureReason = "control_cancel_requested";
    // 与控制台那条直接取消同规：取消要连它名下的资源一起了结，否则输出目标永远挡着关闭门。
    settleCellOwnedResources(state, dispatch.taskGroupId, dispatch.workItemId, "control_cancel_requested");
  } else {
    dispatch.status = "queued";
    dispatch.blockedReason = "control_resume_requested";
    delete dispatch.assignedNodeId;
    delete dispatch.claimedAt;
    delete dispatch.claimExpiresAt;
    delete dispatch.revocationPending;
    delete dispatch.shutdownPending;
  }
  dispatch.updatedAt = at;
  revokeDispatchMcpGrants(state, node.nodeId, dispatch.dispatchId, `control_${command.commandType}`);
  const session = state.workSessions.find((item) => item.sessionId === dispatch.sessionId);
  if (session) {
    session.status = command.commandType === "pause_dispatch" ? "needs_decision" : command.commandType === "cancel_dispatch" ? "aborted" : "active";
    if (command.commandType === "pause_dispatch") session.blockedReason = "control_pause_requested";
    else delete session.blockedReason;
    session.controlCommandRef = command.commandId;
    session.updatedAt = at;
  }
  const taskGroup = state.taskGroups.find((item) => item.id === dispatch.taskGroupId);
  const workItem = taskGroup?.workItems?.find((item) => item.id === dispatch.workItemId);
  if (workItem) {
    workItem.status = command.commandType === "resume_dispatch" ? "ready" : "needs_decision";
    workItem.blockedReason = command.commandType === "pause_dispatch" ? "control_pause_requested" : command.commandType === "cancel_dispatch" ? "control_cancel_requested" : "control_resume_requested";
    workItem.updatedAt = at;
  }
  // Detach from the node's active set for both resume (back to queued/unassigned) AND cancel (now
  // terminal). Leaving a cancelled dispatch in activeDispatchIds let a later node revoke/shutdown
  // finalizer treat it as "was active" and requeue it — resurrecting operator-cancelled work.
  if (command.commandType === "resume_dispatch" || command.commandType === "cancel_dispatch") node.activeDispatchIds = (node.activeDispatchIds || []).filter((id) => id !== dispatch.dispatchId);
  if (taskGroup) {
    taskGroup.health = "attention";
    taskGroup.updatedAt = at;
  }
  appendGatewayEvent(state, "agent_control_pre_effect_applied", command.commandId, {dispatchId: dispatch.dispatchId, commandType: command.commandType});
}

function applyNodeStopPreEffects(state, node, command) {
  const at = command.createdAt || new Date().toISOString();
  const pendingReason = command.commandType === "revoke"
    ? "assigned_node_revocation_pending_stop"
    : "assigned_node_shutdown_pending_stop";
  const pendingDispatchIds = [];
  for (const dispatch of state.agentDispatches || []) {
    if (dispatch.assignedNodeId !== node.nodeId || !["running", "blocked"].includes(dispatch.status)) continue;
    if (dispatch.blockedReason === "awaiting_human_confirmation") cancelPendingConfirmationsForDispatch(state, dispatch.dispatchId, pendingReason);
    dispatch.status = "blocked";
    dispatch.blockedReason = pendingReason;
    dispatch.controlCommandRef = command.commandId;
    dispatch.controlRequestedAt = at;
    if (command.commandType === "revoke") { dispatch.revocationPending = true; delete dispatch.shutdownPending; }
    else { dispatch.shutdownPending = true; delete dispatch.revocationPending; }
    dispatch.updatedAt = at;
    pendingDispatchIds.push(dispatch.dispatchId);
    revokeDispatchMcpGrants(state, node.nodeId, dispatch.dispatchId, pendingReason);
  }
  command.payload = {
    ...(command.payload || {}),
    activeDispatchIds: uniqueStrings([...(command.payload?.activeDispatchIds || []), ...pendingDispatchIds])
  };
  node.status = "draining";
  node.admission = "read_only";
  node.updatedAt = at;
  appendGatewayEvent(state, "agent_node_stop_pre_effect_applied", command.commandId, {nodeId: node.nodeId, commandType: command.commandType, pendingDispatchIds});
}

function findNodeDispatchForControl(state, node, command) {
  const candidates = (state.agentDispatches || []).filter((dispatch) =>
    dispatch.assignedNodeId === node.nodeId &&
    (command.dispatchId ? dispatch.dispatchId === command.dispatchId : (node.activeDispatchIds || []).includes(dispatch.dispatchId))
  );
  return candidates.find((dispatch) => ["running", "blocked"].includes(dispatch.status)) || candidates[0] || null;
}

function finalizeNodeRevocation(state, node, command) {
  const at = new Date().toISOString();
  const commandDispatchIds = new Set(command.payload?.activeDispatchIds || []);
  const requeuedDispatchIds = [];
  for (const dispatch of state.agentDispatches || []) {
    if (dispatch.assignedNodeId !== node.nodeId) continue;
    const commandOwned = dispatch.controlCommandRef === command.commandId || dispatch.revocationPending;
    const wasActive = commandDispatchIds.has(dispatch.dispatchId) || (node.activeDispatchIds || []).includes(dispatch.dispatchId);
    // In-flight work on the stopping node is requeued to a live node. A terminal (cancelled/failed)
    // dispatch is requeued ONLY if THIS stop's own drain terminalized it (commandOwned) — never merely
    // because it lingered in the node's active set, which would resurrect operator-cancelled or
    // independently-failed work onto another node.
    if (["running", "blocked"].includes(dispatch.status)) { if (!commandOwned && !wasActive) continue; }
    else if (["cancelled", "failed"].includes(dispatch.status)) { if (!commandOwned) continue; }
    else continue;
    dispatch.status = "queued";
    dispatch.blockedReason = "assigned_node_revocation_ack_requeued";
    delete dispatch.assignedNodeId;
    delete dispatch.claimedAt;
    delete dispatch.claimExpiresAt;
    delete dispatch.revocationPending;
    delete dispatch.shutdownPending;
    dispatch.updatedAt = at;
    // 与 finalizeNodeShutdown 对称：那边重排队每个派发时都会撤销它的 MCP 授权，这边漏了。
    // 当前被两层兜住（下发 revoke 时的 pre-effect 已撤过一轮，且 revoked 节点的令牌一律不被接受），
    // 所以不是可利用漏洞 —— 但只要将来出现一条能在 pre-effect 之后给该节点补发授权的路径就会漏。
    // 两个同类收尾路径必须做同样的事，不能靠"别处恰好也挡了"。
    revokeDispatchMcpGrants(state, node.nodeId, dispatch.dispatchId, "assigned_node_revocation_ack_requeued");
    requeuedDispatchIds.push(dispatch.dispatchId);
  }
  node.status = "revoked";
  node.admission = "read_only";
  node.activeDispatchIds = [];
  node.updatedAt = at;
  command.finalizedAt = at;
  appendGatewayEvent(state, "node_revoked", node.nodeId, {commandId: command.commandId, requeuedDispatchIds});
}

function finalizeNodeShutdown(state, node, command) {
  const at = new Date().toISOString();
  const commandDispatchIds = new Set(command.payload?.activeDispatchIds || []);
  const requeuedDispatchIds = [];
  for (const dispatch of state.agentDispatches || []) {
    if (dispatch.assignedNodeId !== node.nodeId) continue;
    const commandOwned = dispatch.controlCommandRef === command.commandId || dispatch.shutdownPending;
    const wasActive = commandDispatchIds.has(dispatch.dispatchId) || (node.activeDispatchIds || []).includes(dispatch.dispatchId);
    // Same rule as revocation: requeue in-flight work, but only requeue a terminal dispatch if this
    // stop's own drain produced it — never resurrect an operator-cancelled/failed dispatch that merely
    // lingered in the node's active set.
    if (["running", "blocked"].includes(dispatch.status)) { if (!wasActive) continue; }
    else if (["cancelled", "failed"].includes(dispatch.status)) { if (!commandOwned) continue; }
    else continue;
    dispatch.status = "queued";
    dispatch.blockedReason = "assigned_node_shutdown_ack_requeued";
    delete dispatch.assignedNodeId;
    delete dispatch.claimedAt;
    delete dispatch.claimExpiresAt;
    delete dispatch.revocationPending;
    delete dispatch.shutdownPending;
    dispatch.updatedAt = at;
    revokeDispatchMcpGrants(state, node.nodeId, dispatch.dispatchId, "assigned_node_shutdown_ack_requeued");
    requeuedDispatchIds.push(dispatch.dispatchId);
  }
  node.status = "offline";
  node.admission = "read_only";
  node.activeDispatchIds = [];
  node.updatedAt = at;
  command.finalizedAt = at;
  appendGatewayEvent(state, "node_shutdown_completed", node.nodeId, {commandId: command.commandId, requeuedDispatchIds});
}

function handleStopControlFailure(state, node, command, status) {
  const at = new Date().toISOString();
  node.status = "degraded";
  node.admission = "read_only";
  node.updatedAt = at;
  const affectedDispatchIds = [];
  for (const dispatch of state.agentDispatches || []) {
    if (dispatch.assignedNodeId !== node.nodeId) continue;
    // trulyOwned == this stop's own drain touched it; payload membership alone is NOT ownership (an
    // operator-cancelled dispatch can appear in the snapshot). Re-block in-flight drained work for
    // retry, but never re-block a terminal dispatch this stop did not itself drain.
    const trulyOwned = dispatch.controlCommandRef === command.commandId || dispatch.revocationPending || dispatch.shutdownPending;
    const inSnapshot = (command.payload?.activeDispatchIds || []).includes(dispatch.dispatchId);
    if (["running", "blocked"].includes(dispatch.status)) { if (!trulyOwned && !inSnapshot) continue; }
    else if (["cancelled", "failed"].includes(dispatch.status)) { if (!trulyOwned) continue; }
    else continue;
    dispatch.status = "blocked";
    // Static closed-set reason (commandType/status are carried in the emitted event payload) so the
    // Chinese console can localize it — a template literal would leak 4 raw-English variants.
    dispatch.blockedReason = "assigned_node_stop_control_failed_retry_queued";
    dispatch.controlCommandRef = command.commandId;
    // Preserve a persistent pending-stop marker across retries AND retry exhaustion: revoke keeps
    // revocationPending, shutdown keeps shutdownPending. Without this, an exhausted shutdown (no retry
    // command re-stamps the pending blockedReason) would lose all backstop signal and wedge forever.
    if (command.commandType === "revoke" || dispatch.revocationPending) dispatch.revocationPending = true;
    else { delete dispatch.revocationPending; dispatch.shutdownPending = true; }
    dispatch.updatedAt = at;
    affectedDispatchIds.push(dispatch.dispatchId);
  }
  const retryAttempt = Number(command.payload?.retryAttempt || 0) + 1;
  if (retryAttempt <= 3) {
    const retry = createAgentControlCommand(state, node, {
      commandType: command.commandType,
      payload: {...(command.payload || {}), retryOf: command.commandId, retryAttempt},
      ttlSeconds: 300
    }, {actor: "agent-gateway", idempotencyKey: `control-retry:${command.commandId}:${retryAttempt}`}).command;
    command.retryCommandId = retry.commandId;
  } else {
    // 重试用尽：原因不能再写 *_retry_queued（「重试入队」）—— 没有任何重试在队列里，
    // 而人会照着那句话干等。换成终态原因，出口是强制吊销（不需要节点配合）。
    for (const dispatchId of affectedDispatchIds) {
      const stuck = (state.agentDispatches || []).find((item) => item.dispatchId === dispatchId);
      if (!stuck) continue;
      stuck.blockedReason = "assigned_node_stop_control_failed_retries_exhausted";
      stuck.controlFailure = {commandType: command.commandType, attempts: retryAttempt, lastStatus: status, at};
      stuck.updatedAt = at;
    }
  }
  command.failureHandledAt = at;
  appendGatewayEvent(state, "agent_stop_control_retry_queued", command.commandId, {nodeId: node.nodeId, commandType: command.commandType, status, affectedDispatchIds, retryCommandId: command.retryCommandId || null});
}

export function finishNodeDispatch(state, node, dispatchId, succeeded) {
  const wasActive = (node.activeDispatchIds || []).includes(dispatchId);
  node.activeDispatchIds = (node.activeDispatchIds || []).filter((id) => id !== dispatchId);
  // Idempotent: a retried completion/failure whose dispatch was already finalized for this claim must
  // not double-count completed/failedDispatchCount, re-revoke grants, or re-emit the gateway event.
  if (!wasActive) return;
  if (succeeded) node.completedDispatchCount = Number(node.completedDispatchCount || 0) + 1;
  else node.failedDispatchCount = Number(node.failedDispatchCount || 0) + 1;
  node.updatedAt = new Date().toISOString();
  revokeDispatchMcpGrants(state, node.nodeId, dispatchId, succeeded ? "dispatch_completed" : "dispatch_failed");
  appendGatewayEvent(state, succeeded ? "dispatch_completed" : "dispatch_failed", dispatchId, {nodeId: node.nodeId});
}

export function isSafeGitRemoteUrl(url) {
  const value = String(url || "");
  if (!value || value.startsWith("-")) return false;
  // Reject remote-helper transports (ext::, fd::, <anything>::) and ext:/fd: — these can execute
  // arbitrary commands on the host. This is the primary RCE guard; callers also constrain git with
  // GIT_ALLOW_PROTOCOL. http(s)/ssh/git/file and local filesystem paths are permitted (local repos
  // are used by local deployments and the doctor, and cannot execute commands).
  if (/^[a-z0-9+.-]*::/iu.test(value)) return false;
  if (value.startsWith("ext:") || value.startsWith("fd:")) return false;
  // git 认的 remote-helper 语法是【第一个 `/` 之前出现 `::`】，helper 名可以带 @：
  // `user@host::payload` 会被它当成名为 `user@host` 的 helper 去 exec，而上面那条
  // `^[a-z0-9+.-]*::` 因为 @ 不在字符集里，正好放过这一种。
  // 目前它撞不上真问题（每处 git 调用都设了 GIT_ALLOW_PROTOCOL，helper 传输被 git 自己拦下），
  // 但那是第二道门；这一道自己也该关严。IPv6 要放行：`user@[::1]:repo.git` 里的 :: 在方括号内。
  const beforeSlash = value.split("/")[0];
  if (beforeSlash.includes("::") && !beforeSlash.includes("[")) return false;
  // Reject a host segment that begins with '-' so git cannot pass it to ssh as an option (e.g. -oProxyCommand=...).
  const scp = value.match(/^[^@\s]+@([^:\s]+):.+/u);
  if (scp) return !scp[1].startsWith("-");
  const sshUrl = value.match(/^ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)/iu);
  if (sshUrl) return !sshUrl[1].startsWith("-");
  if (/^(https?|git|file):\/\//iu.test(value)) return true;
  // Local filesystem repository paths (absolute POSIX, Windows drive, or explicit ./ .. relative).
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("./") || value.startsWith("../");
}

function gitTransferForBundle(config) {
  const repository = config.repositories?.[0];
  if (!repository?.url || String(repository.url).startsWith("git:unknown") || !isSafeGitRemoteUrl(repository.url)) return {};
  // Only declared git-backed baseline entries (locator "git:<path>") transfer via git; everything else
  // rides the inline bundle. Large binaries therefore never bloat the JSON payload.
  const paths = (config.baselineData || [])
    .map((item) => String(item.locator || ""))
    .filter((locator) => locator.startsWith("git:"))
    .map((locator) => locator.slice("git:".length).replace(/^\/+/u, ""))
    .filter((path) => path && !path.includes(".."));
  if (!paths.length) return {};
  return {gitTransfer: {enabled: true, repositoryUrl: repository.url, ref: repository.defaultBranch || "main", paths: [...new Set(paths)]}};
}

export function buildExecutionContentBundle(state, node, sessionId, options = {}) {
  const dispatch = (state.agentDispatches || []).find((item) => item.sessionId === sessionId && item.assignedNodeId === node.nodeId && item.status === "running");
  if (!dispatch) throw gatewayError("content_bundle_dispatch_not_active", 404);
  const contract = state.agentTaskContracts.find((item) => item.sessionId === dispatch.sessionId && item.runId === dispatch.runId);
  const taskGroup = state.taskGroups.find((item) => item.id === dispatch.taskGroupId);
  if (!contract || !taskGroup) throw gatewayError("content_bundle_context_missing", 409);
  const project = state.projects.find((item) => item.id === dispatch.projectId);
  const config = effectiveTaskGroupConfig(state, taskGroup);
  // 契约冻结的规则摘要 vs 此刻真正要下发的规则。不一致意味着规则在这个派发排队/执行期间被改过 ——
  // agent 会拿到新规则，而契约、指令包、事后的检查点记的都是旧摘要。原先这个摘要没有任何消费者，
  // 所以这件事从头到尾不可见。这里把它变成一条有记录的事实：更新契约摘要（让证据链说实话），
  // 并在派发上留痕 + 发事件，人能看到"这个派发中途换过规则"。
  const currentRulesDigest = computeEffectiveRulesDigest(config);
  if (contract.effectiveRulesDigest && contract.effectiveRulesDigest !== currentRulesDigest) {
    const previousDigest = contract.effectiveRulesDigest;
    // 只改 effectiveRulesDigest 会让同一份契约自相矛盾：rulesetDigest / digestRefs /
    // actionBasis.activeRuleRefs 三处都由它派生，此前全部留在旧值上，而这份契约会整份交给 agent。
    applyEffectiveRulesDigest(contract, currentRulesDigest);
    contract.rulesChangedAfterContract = {previousDigest, currentDigest: currentRulesDigest, at: new Date().toISOString()};
    dispatch.rulesChangedAfterContract = true;
    appendGatewayEvent(state, "dispatch_rules_changed_after_contract", dispatch.dispatchId, {previousDigest, currentDigest: currentRulesDigest});
  }
  let skillWorkset = options.skillWorkset || null;
  // 技能集构造失败此前被吞成 null：内容包照发，只是【没有角色技能文件】——
  // agent 于是拿着一份缺了角色规则的包去执行，产出质量下降，而全系统没有一处记录过这件事。
  // 降级本身是对的（不该因为技能源出问题就让所有执行停摆），但必须留痕、必须让人看见。
  let skillWorksetFailure = null;
  if (!skillWorkset) {
    try {
      skillWorkset = buildSkillWorkset(state, contract, options);
    } catch (error) {
      skillWorkset = null;
      skillWorksetFailure = String(error?.message || error).slice(0, 200);
    }
  }
  if (skillWorksetFailure) {
    appendGatewayEvent(state, "content_bundle_skill_workset_unavailable", dispatch.dispatchId,
      {nodeId: node.nodeId, sessionId: dispatch.sessionId, detail: skillWorksetFailure});
    dispatch.contentDegradation = {what: "skill_workset", detail: skillWorksetFailure, at: new Date().toISOString()};
    const degradedGroup = (state.taskGroups || []).find((item) => item.id === dispatch.taskGroupId);
    if (degradedGroup) {
      degradedGroup.blockers = degradedGroup.blockers || [];
      const summary = `派发 ${dispatch.dispatchId} 下发的内容包缺少角色技能文件（${skillWorksetFailure}）：`
        + "执行方是在没有角色规则的情况下干活的，产出质量会打折 —— 先让系统管理员到「系统设置」页核对技能源，再决定这次产出要不要采信";
      if (!degradedGroup.blockers.some((item) => item.summary === summary)) {
        degradedGroup.blockers.push({id: `blk_skill_${dispatch.dispatchId}`, severity: "S2", summary});
      }
    }
  }
  const entries = [];
  const pushEntry = (path, category, retention, content, sourceRef) => {
    const text = String(content || "");
    if (!text.trim()) return;
    entries.push({path, category, retention, contentDigest: digestOf(text), content: text, ...(sourceRef ? {sourceRef} : {})});
  };
  if (skillWorkset?.files?.length) {
    for (const file of skillWorkset.files) {
      pushEntry(`role/${file.path}`, "role", "durable", file.content, `role-skill:${contract.roleSkill?.roleSkillRef || ""}`);
    }
  }
  const renderRules = (rules, label) => (rules || [])
    .map((rule, index) => `## ${rule.title || `${label} ${index + 1}`}\n\n${rule.content || ""}`)
    .join("\n\n");
  // sourceRef 是随包交给 agent 的出处声明。这三项都来自三级配置，写死一层就会说假话：
  // 规则按 ruleId 跨三层【合并】，所以如实列出真正贡献过内容的层；
  // 基线数据由"最具体的非空那层"【整体取胜】，所以只标那一层。
  const projectConfigBase = ((state.projects || []).find((item) => item.id === taskGroup.projectId) || {}).config || {};
  const layerNonEmpty = (value) => Array.isArray(value) && value.length > 0;
  const mergedLayersRef = (key) => ["Defaults",
    layerNonEmpty(projectConfigBase[key]) ? `Project:${taskGroup.projectId}` : null,
    layerNonEmpty(taskGroup.configOverrides?.[key]) ? `TaskGroup:${taskGroup.id}` : null].filter(Boolean).join("+");
  const winningLayerRef = (key) => (layerNonEmpty(taskGroup.configOverrides?.[key]) ? `TaskGroup:${taskGroup.id}`
    : layerNonEmpty(projectConfigBase[key]) ? `Project:${taskGroup.projectId}` : "Defaults");
  const systemRulesText = renderRules(config.activeSystemRules, "系统规则");
  pushEntry("system/rules.md", "system", "durable", systemRulesText, mergedLayersRef("systemRules"));
  const businessRulesText = renderRules(config.activeBusinessRules, "业务规则");
  pushEntry("business/rules.md", "business", "durable", businessRulesText, mergedLayersRef("businessRules"));
  const baselineText = (config.baselineData || []).map((item) => `- ${item.name || item.locator}: ${item.locator || ""} ${item.digest || ""}`).join("\n");
  pushEntry("business/baseline.md", "business", "durable", baselineText, winningLayerRef("baselineData"));
  const answeredConfirmations = (state.humanConfirmationRequests || [])
    .filter((item) => item.taskGroupId === taskGroup.id && ["answered", "consumed"].includes(item.status))
    .map((item) => ({requestId: item.requestId, question: item.question?.summary, selectedOptionId: item.decision?.selectedOptionId, selectedLabel: item.decision?.selectedLabel, inputText: item.decision?.inputText}));
  pushEntry("task/confirmations.json", "task", "task", answeredConfirmations.length ? JSON.stringify(answeredConfirmations, null, 2) : "", `TaskGroup:${taskGroup.id}`);
  // 补充要求有上限（见 core 的 appendHumanGuidance）。丢掉过就必须在包里说出来 ——
  // agent 拿到的是一份"人的全部要求"，少了几条而不作声，它会按不完整的要求去做。
  const guidanceDropped = Number(taskGroup.humanGuidanceDroppedCount || 0);
  const guidance = [
    ...(taskGroup.humanGuidance || []).filter((item) => !item.workItemId || item.workItemId === contract.workId)
      .map((item) => `- ${item.text}`),
    ...(guidanceDropped ? [`- （另有 ${guidanceDropped} 条更早的补充要求已超出保留上限，不在本包内；需要时到任务组页查看历史指令）`] : [])
  ].join("\n");
  const dispatchedWorkItemTitle = contract.workId
    ? (taskGroup.workItems || []).find((item) => item.id === contract.workId)?.title
    : null;
  const contextText = [
    `# 任务上下文`,
    `任务组：${taskGroup.id}（${taskGroup.phase || taskGroup.status || ""}）`,
    taskGroup.objective ? `目标：${taskGroup.objective}` : "",
    guidance ? `\n## 人工补充要求\n${guidance}` : "",
    // 清单要标出【这次派发做的是哪一项】。运行时给模型的指令里只有 id（`implement only work_x`），
    // 而这份清单只有标题 —— 实测同一个任务组里三项同时 in_progress，agent 得自己把 id 映射到标题。
    // 让它猜，猜错就是改错文件；而这一步本来不需要存在。
    taskGroup.taskAnalysis ? `\n## 事项清单\n${taskGroup.taskAnalysis.items.map((item) => {
      const isTarget = item.id && contract.workId && item.id === contract.workId;
      return `- [${item.status}] ${item.title}${item.id ? `（${item.id}）` : ""}${isTarget ? "  ← 本次派发就是这一项" : ""}`;
    }).join("\n")}` : "",
    // 兜底：清单里若没有与 workId 对得上的条目（分析项与工作项不同源时会这样），
    // 也要把本次的工作项单独说清楚，而不是让 agent 在一份对不上的清单里找。
    contract.workId ? `\n## 本次派发\n工作项：${contract.workId}${
      dispatchedWorkItemTitle ? `（${dispatchedWorkItemTitle}）` : ""}` : ""
  ].filter(Boolean).join("\n");
  pushEntry("task/context.md", "task", "task", contextText, `TaskGroup:${taskGroup.id}`);
  if (!entries.length) pushEntry("task/context.md", "task", "task", `# 任务上下文\n任务组：${taskGroup.id}`, `TaskGroup:${taskGroup.id}`);
  const bundleDigest = digestOf(entries.map((entry) => `${entry.path}:${entry.contentDigest}`));
  // 控制台的「稳定前缀」一直显示 instructionMetrics.stablePrefixTokens，而那是初始化时写死的 1800，
  // 从来没有任何生产者更新过它 —— 人看到的是一个常量，被当成测量结果。实测系统规则正文已 15000+ 字符，
  // 差了 8 倍以上，而这个数字正是回答"每次派发要烧多少上下文"的那一个。
  // 这里如实记录【最近一次真实构建】的稳定前缀体积（durable 类条目：角色技能/系统规则/业务规则/基线），
  // 并带上观测时刻与来源任务组；覆盖而非 ||=，因为它是"最近一次实测"，持久化旧值只会越来越不准。
  const stablePrefixChars = entries
    .filter((entry) => entry.retention === "durable")
    .reduce((total, entry) => total + String(entry.content || "").length, 0);
  state.instructionMetrics ||= {};
  state.instructionMetrics.stablePrefixMeasured = {
    chars: stablePrefixChars,
    entryCount: entries.filter((entry) => entry.retention === "durable").length,
    taskGroupId: taskGroup.id,
    observedAt: new Date().toISOString()
  };
  return {
    schemaVersion: "execution-content-bundle/v1",
    bundleId: `ecb_${bundleDigest.slice("sha256:".length, "sha256:".length + 20)}`,
    bundleDigest,
    organizationId: node.organizationId || project?.organizationId || "org_default",
    projectId: dispatch.projectId,
    taskGroupId: taskGroup.id,
    sessionId: dispatch.sessionId,
    dispatchId: dispatch.dispatchId,
    entries,
    // 降级要跟着内容包一起走：agent 拿到的是一份缺了角色技能的包，它自己也该知道。
    ...(skillWorksetFailure ? {degradations: [{what: "skill_workset", detail: skillWorksetFailure}]} : {}),
    ...gitTransferForBundle(config),
    createdAt: new Date().toISOString()
  };
}

export function getSkillWorkset(state, node, worksetId, options = {}) {
  const dispatch = (state.agentDispatches || []).find((item) =>
    item.status === "running" &&
    item.assignedNodeId === node.nodeId &&
    item.skillWorksetId === worksetId
  );
  if (!dispatch) throw gatewayError("skill_workset_not_found", 404);
  const contract = state.agentTaskContracts.find((item) =>
    item.sessionId === dispatch.sessionId &&
    item.runId === dispatch.runId &&
    item.roleSkill?.worksetId === worksetId
  );
  if (!contract || !runtimeNodeCanAccessProject(state, node, contract.projectId)) throw gatewayError("skill_workset_not_found", 404);
  return buildSkillWorkset(state, contract, options);
}

// 白名单式投影。原先是"剔除已知敏感字段"，而本仓已经为这个形状交过一次学费：publicJoinToken
// 当初也是逐个剔除，于是后加的 registrationReplay（内含明文 nodeToken）直接漏了出去。
// 节点记录同样会长出新字段（这次会话里我自己就加了三个），黑名单只保护它列举过的那些，
// 而新字段默认外泄；白名单反过来 —— 新字段默认不外泄，忘了加只是"界面上少一格"，看得见、改得动。
// 带认领代次提交是 0.3.0 引入的 agent↔控制面契约。低于它的节点，其派发一旦被重新认领就会
// 卡在 checkpoint_claim_epoch_required —— 而这件事此前只有在卡住那一刻才浮现。
// 控制面本来就知道每个节点的运行时版本，就该在卡住【之前】把它摆出来。
export const REQUIRED_AGENT_RUNTIME_VERSION = "0.3.0";

function versionBelow(actual, required) {
  const parse = (value) => String(value || "").split(".").map((part) => Number.parseInt(part, 10));
  const a = parse(actual);
  const b = parse(required);
  if (a.some((part) => !Number.isFinite(part)) || a.length < b.length) return true; // 版本号读不出来，按过旧处理
  for (let index = 0; index < b.length; index += 1) {
    if ((a[index] || 0) < b[index]) return true;
    if ((a[index] || 0) > b[index]) return false;
  }
  return false;
}

export function agentRuntimeOutdated(node) {
  return versionBelow(node?.runtimeVersion, REQUIRED_AGENT_RUNTIME_VERSION);
}

const PUBLIC_AGENT_NODE_FIELDS = [
  "schemaVersion", "nodeId", "nodeName", "organizationId", "registrationScope", "projectIds",
  "allowedRoles", "allowedMcpTools", "status", "admission",
  "profile", "profileDigest", "runtimeVersion", "runtimeOutdated",
  "lastHeartbeatAt", "lastSelfCheckAt", "selfCheckDigest", "selfCheckMissing", "selfCheckFailures",
  "activeDispatchIds", "completedDispatchCount", "failedDispatchCount",
  "lastClaimMiss", "offlineReason", "revokedReason",
  "revocationDeadlineAt", "revocationFinalizedAt", "revocationFinalizedReason",
  "createdAt", "updatedAt"
];

export function publicAgentNode(node, options = {}) {
  const safe = {};
  for (const field of PUBLIC_AGENT_NODE_FIELDS) {
    if (node[field] !== undefined) safe[field] = node[field];
  }
  // 派生字段：每次投影时算，不落库 —— 要求版本会随契约变化，持久化下来的判定必然过期。
  safe.runtimeOutdated = agentRuntimeOutdated(node);
  safe.registrationScope ||= "project";
  const projectIdSet = options.projectIdSet ? new Set([...options.projectIdSet].map((item) => String(item))) : null;
  if (options.state) {
    safe.effectiveProjectIds = runtimeNodeProjectIds(options.state, node);
    if (projectIdSet) {
      safe.effectiveProjectIds = safe.effectiveProjectIds.filter((projectId) => projectIdSet.has(projectId));
      safe.projectIds = (safe.projectIds || []).filter((projectId) => projectIdSet.has(projectId));
      const active = new Set((options.state.agentDispatches || [])
        .filter((dispatch) => dispatch.assignedNodeId === node.nodeId && projectIdSet.has(dispatch.projectId))
        .map((dispatch) => dispatch.dispatchId));
      safe.activeDispatchIds = (safe.activeDispatchIds || []).filter((dispatchId) => active.has(dispatchId));
    }
  }
  if (options.profileMode === "project") safe.profile = projectVisibleNodeProfile(safe.profile || {});
  return safe;
}

function projectVisibleNodeProfile(profile = {}) {
  return {
    platform: profile.platform,
    arch: profile.arch,
    cpuCount: profile.cpuCount,
    memoryBytes: profile.memoryBytes,
    diskFreeBytes: profile.diskFreeBytes,
    tools: (profile.tools || []).map((tool) => ({name: tool.name, version: tool.version, available: tool.available})),
    models: (profile.models || []).map((model) => ({providerClass: model.providerClass, available: model.available})),
    capabilityFlags: profile.capabilityFlags || [],
    region: profile.region,
    networkSpeedMbps: profile.networkSpeedMbps,
    observedAt: profile.observedAt
  };
}

// 「这次派发用哪份仓库凭证」：按产出目标的 repositoryId 在项目仓库配置里找，密文只在这一刻解开、只进
// 认领响应（节点令牌鉴权、不落盘）。解不开（密钥或运行时目录换过）要如实报 repository_credential_unreadable，
// 不能静默当"没配"——那会让 agent 拿主机凭证瞎试、人查不到原因。mode none / 没配 → null，agent 照旧走主机凭证。
export function dispatchRepositoryCredential(state, dispatch, repositoryOutputTarget, options = {}) {
  const project = (state.projects || []).find((item) => item.id === dispatch.projectId);
  // 项目仓库有两个落点（顶层与 config），一律走 projectRepositories() 这唯一的读者，别与界面写的那个分叉。
  const repositories = project ? projectRepositories(project) : [];
  const wanted = repositoryOutputTarget?.repositoryId;
  const repository = repositories.find((item) => item && (item.id === wanted || item.repositoryId === wanted));
  const credential = repository?.credential || null;
  const mode = credential?.mode || repository?.credentialMode || "none";
  if (!credential || mode === "none") return null;
  let secret = "";
  if (isSealed(credential.sealedSecret)) {
    try {
      secret = openSecret(credential.sealedSecret, resolve(options.runtimeDir || ".runtime"));
    } catch (error) {
      throw gatewayError("repository_credential_unreadable", 409, {repositoryId: wanted,
        hint: "这份仓库凭证是用另一把密钥密封的（密钥或运行时目录换过）：到项目设置里重新填一次凭证"});
    }
  } else {
    // 旧版留下的明文：照样投递（今天它已经在盘上了，不投递只会让功能不通）；下一次保存会被密封掉。
    secret = String(credential.password || credential.apiKey || "");
  }
  if (!secret) return null;
  return {mode, repositoryId: wanted, username: String(credential.username || (mode === "api_key" ? "x-access-token" : "")), secret};
}

function buildDispatchPackage(state, dispatch, node, options) {
  const contract = state.agentTaskContracts.find((item) => item.sessionId === dispatch.sessionId && item.runId === dispatch.runId);
  const repositoryOutputTarget = state.repositoryOutputs.find((item) => item.targetId === dispatch.repositoryOutputTargetRef);
  const instructionPacket = state.effectiveInstructionPackets.find((item) => item.packetId === contract?.effectiveInstructionPacketRef);
  if (!contract || !repositoryOutputTarget || !instructionPacket) {
    // 三样缺哪一样，决定了该去查哪条链路（契约没建 / 写入边界没建 / 指令包没生成）。
    throw gatewayError("dispatch_package_incomplete", 409, {missing: [
      ...(contract ? [] : ["agentTaskContract"]),
      ...(repositoryOutputTarget ? [] : ["repositoryOutputTarget"]),
      ...(instructionPacket ? [] : ["effectiveInstructionPacket"])
    ], dispatchId: dispatch.dispatchId, sessionId: dispatch.sessionId});
  }
  const skillWorkset = buildSkillWorkset(state, contract, options);
  return {
    schemaVersion: "agent-dispatch-package/v1",
    dispatch,
    taskContract: contract,
    effectiveInstructionPacket: instructionPacket,
    repositoryOutputTarget,
    // 只在认领响应里出现；agent 只用于本次派发的 git 网络操作，不落盘、不进检查点。
    repositoryCredential: dispatchRepositoryCredential(state, dispatch, repositoryOutputTarget, options),
    skillWorkset: {
      worksetId: skillWorkset.worksetId,
      worksetDigest: skillWorkset.worksetDigest,
      downloadPath: `/api/agent/v1/skill-worksets/${encodeURIComponent(skillWorkset.worksetId)}`,
      requiredSkillRefs: skillWorkset.requiredSkillRefs,
      languagePolicy: skillWorkset.languagePolicy,
      languagePolicyDigest: skillWorkset.languagePolicyDigest,
      executionDirective: skillWorkset.executionDirective
    },
    remoteServices: {
      mcpPath: "/mcp",
      checkpointPath: `/api/agent/v1/dispatches/${encodeURIComponent(dispatch.dispatchId)}/checkpoint`,
      failurePath: `/api/agent/v1/dispatches/${encodeURIComponent(dispatch.dispatchId)}/fail`,
      contentBundlePath: `/api/agent/v1/content-bundles/${encodeURIComponent(dispatch.sessionId)}`,
      confirmationPath: "/api/agent/v1/confirmations"
    },
    organizationId: node.organizationId || "org_default",
    nodeBinding: {nodeId: node.nodeId, profileDigest: node.profileDigest},
    packageDigest: digestOf({dispatch, contractDigest: contract.contractDigest, worksetDigest: skillWorkset.worksetDigest, nodeId: node.nodeId})
  };
}

export function buildSkillWorkset(state, contract, options) {
  const runtimeDir = resolve(options.runtimeDir || ".runtime");
  const effectiveRef = String(contract.roleSkill?.roleSkillRef || contract.roleSkill?.selectedAgentSkillRef || "");
  const baseRef = effectiveRef.split("+")[0];
  const skill = state.roleSkills.find((item) => item.roleSkillId === baseRef) || state.roleSkills.find((item) => item.roleSkillId === effectiveRef);
  if (!skill) throw gatewayError("role_skill_not_found", 409);
  const files = [];
  if (skill.sourceId === "agency-agents-zh" && skill.sourcePath) {
    const sourceRoot = resolve(runtimeDir, "skill-sources", skill.sourceId, "repo");
    const target = resolve(sourceRoot, normalize(skill.sourcePath));
    if (!inside(sourceRoot, target) || !existsSync(target)) throw gatewayError("role_skill_source_missing", 409);
    const content = readFileSync(target, "utf8");
    if (digestOf(content) !== skill.contentDigest) {
      // 技能文件与登记的摘要对不上：不说清是哪一份、盘上算出来是多少，运维只能逐个文件去猜。
      throw gatewayError("role_skill_digest_mismatch", 409,
        {roleSkillId: skill.roleSkillId, sourcePath: skill.sourcePath, expected: skill.contentDigest, actual: digestOf(content)});
    }
    files.push({path: "SKILL.md", content, contentDigest: skill.contentDigest, sourcePath: skill.sourcePath});
  } else {
    const content = [`# ${skill.name}`, "", skill.description, "", `Capabilities: ${(skill.capabilities || []).join(", ")}`, ""].join("\n");
    files.push({path: "SKILL.md", content, contentDigest: digestOf(content), sourcePath: skill.sourcePath});
  }
  const overlayRefs = contract.roleSkill?.overlayRefs || [];
  const overlays = (state.roleSkillOverlays || []).filter((item) => overlayRefs.includes(item.overlayId)).map((overlay) => ({
    overlayId: overlay.overlayId,
    overlayDigest: overlay.overlayDigest,
    patch: overlay.patch
  }));
  // overlay 声称是"项目级角色规则定制"，但它此前只改了能力标签与摘要 —— 下发给 agent 的
  // SKILL.md 取的是 base 正文（effectiveRef.split("+")[0]），patch.instructionRef 全仓从未被解析。
  // 也就是说这套定制【一个字都到不了 agent】：契约里写着它生效了，执行方读到的却是未经修改的原文。
  // 把 overlay 的实际约束落成一份 agent 会读到的文件，定制才真的存在。
  if (overlays.length) {
    const overlayText = ["# 角色技能定制（项目级 overlay）", "",
      "以下约束在本任务上【叠加于】SKILL.md，与之冲突时以本文件为准。", ""];
    for (const overlay of overlays) {
      const patch = overlay.patch || {};
      overlayText.push(`## ${overlay.overlayId}`);
      if ((patch.allowedCapabilityAdds || []).length) overlayText.push(`- 追加允许的能力：${patch.allowedCapabilityAdds.join("、")}`);
      if ((patch.forbiddenCapabilityAdds || []).length) overlayText.push(`- 追加禁止的能力：${patch.forbiddenCapabilityAdds.join("、")}`);
      if (patch.instructionRef && patch.instructionRef !== "overlay:empty") overlayText.push(`- 附加说明引用：${patch.instructionRef}`);
      if (patch.modelRequirementPatchRef && patch.modelRequirementPatchRef !== "overlay:model:none") overlayText.push(`- 模型要求补丁：${patch.modelRequirementPatchRef}`);
      overlayText.push("");
    }
    const overlayContent = overlayText.join("\n");
    files.push({path: "SKILL.overlay.md", content: overlayContent, contentDigest: digestOf(overlayContent)});
  }
  const languagePolicy = normalizeTaskGroupLanguagePolicy(contract.languagePolicy);
  const languagePolicyDigest = contract.languagePolicyDigest || digestOf(languagePolicy);
  const requiredSkillRefs = [effectiveRef];
  const manifestSeed = {
    roleId: contract.roleId,
    synchronizationMode: "server_managed_on_demand",
    requiredSkillRefs,
    roleSkillDigest: contract.roleSkill.roleSkillDigest,
    languagePolicyDigest,
    overlays,
    files: files.map(({path, contentDigest, sourcePath}) => ({path, contentDigest, sourcePath}))
  };
  const worksetDigest = digestOf(manifestSeed);
  const worksetId = contract.roleSkill.worksetId || `skillset_${worksetDigest.slice("sha256:".length, "sha256:".length + 24)}`;
  return {
    schemaVersion: "agent-skill-workset/v1",
    worksetId,
    worksetDigest,
    projectId: contract.projectId,
    taskGroupId: contract.taskGroupId,
    workItemId: contract.workId,
    roleId: contract.roleId,
    synchronizationMode: "server_managed_on_demand",
    languagePolicy,
    languagePolicyDigest,
    requiredSkillRefs,
    overlays,
    files,
    executionDirective: `The ${contract.roleId} agent MUST load and apply every skill in this workset before executing the task. Child roles MUST receive their own explicit skill workset from the control plane; they may not inherit or choose skills implicitly. ${languagePolicyDirective(languagePolicy)}`,
    createdAt: contract.issuedAt
  };
}

export function mcpToolsForRoles(roles) {
  const control = roles.some((role) => ["orchestrator", "scheduler", "monitor", "reviewer", "security"].includes(role));
  return uniqueStrings([...DEFAULT_AGENT_MCP_TOOLS, ...(control ? CONTROL_ROLE_MCP_TOOLS : [])]);
}

function normalizeControlCommandType(value) {
  const normalized = String(value || "").trim();
  if (["refresh_profile", "pause_dispatch", "cancel_dispatch", "resume_dispatch", "shutdown", "revoke"].includes(normalized)) return normalized;
  throw gatewayError("agent_control_command_type_invalid", 400);
}

function normalizeExecutionEventType(value) {
  const normalized = String(value || "").trim();
  if ([
    "dispatch_received",
    "skill_synced",
    "executor_started",
    "executor_output",
    "repository_changed",
    "git_committed",
    "git_pushed",
    "checkpoint_prepared",
    "checkpoint_submitted",
    "heartbeat",
    "blocked",
    "drift_signal",
    "failed"
  ].includes(normalized)) return normalized;
  return "progress";
}

function progressForEventType(eventType) {
  return {
    dispatch_received: 8,
    skill_synced: 15,
    executor_started: 25,
    executor_output: 45,
    repository_changed: 65,
    git_committed: 80,
    git_pushed: 90,
    checkpoint_prepared: 95,
    checkpoint_submitted: 100,
    blocked: 35,
    drift_signal: 35,
    failed: 100
  }[eventType] || 50;
}

function statusForExecutionEvent(eventType) {
  if (eventType === "failed") return "failed";
  if (eventType === "blocked" || eventType === "drift_signal") return "attention";
  if (eventType === "checkpoint_submitted") return "completed";
  return "running";
}

function updateExecutionProgress(state, dispatch, event, at) {
  dispatch.lastExecutionEventRef = `AgentExecutionEvent:${event.eventId}`;
  dispatch.lastExecutionEventAt = at;
  dispatch.progressPercent = Math.max(Number(dispatch.progressPercent || 0), event.progressPercent);
  dispatch.updatedAt = at;
  const session = state.workSessions.find((item) => item.sessionId === dispatch.sessionId);
  if (session) {
    session.lastExecutionEventRef = dispatch.lastExecutionEventRef;
    session.progressPercent = Math.max(Number(session.progressPercent || 0), event.progressPercent);
    // "monitor_attention" is not a legal WorkSession state; surface attention as a derived UI flag
    // without leaving the "active" state, and clear it once normal progress resumes.
    if (event.status === "attention") session.attentionFlag = true;
    else if (event.status === "running" && session.attentionFlag) delete session.attentionFlag;
    session.updatedAt = at;
  }
  const taskGroup = state.taskGroups.find((item) => item.id === dispatch.taskGroupId);
  const workItem = taskGroup?.workItems?.find((item) => item.id === dispatch.workItemId);
  if (workItem) {
    workItem.progress = Math.max(Number(workItem.progress || 0), Math.min(99, event.progressPercent));
    if (event.status === "attention") taskGroup.health = "attention";
    workItem.updatedAt = at;
    taskGroup.updatedAt = at;
  }
}

function sanitizeAckResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const text = JSON.stringify(value);
  if (text.length > 10000) return {truncated: true, resultDigest: digestOf(text)};
  return JSON.parse(text);
}

// 诊断算出来了还得【落盘】才有人看得见 —— 而认领路由原先只在真领到活时提交，
// 也就是恰恰在"没领到"这条路上不写，整个"在线但不领活"的诊断从落地起就没拿到过数据。
// 反过来，每次空轮询都写一遍 = 一台闲着的节点按轮询频率重写整份状态（空转 churn）。
// 所以只在【诊断本身变了】时写：at 是时间戳，不参与比较，否则每次都不一样。
function recordClaimMiss(node, miss) {
  const shape = (value) => (value
    ? JSON.stringify({queuedCount: value.queuedCount, reasons: value.reasons})
    : null);
  if (shape(miss) === shape(node.lastClaimMiss)) return false;
  node.lastClaimMiss = miss;
  node.updatedAt = miss.at;
  return true;
}

// 逐条说清"这个排队中的派发为什么这个节点接不了"。只留前几条：人要的是原因，不是清单。
function summarizeClaimMiss(state, node, projectIdSet = new Set(runtimeNodeProjectIds(state, node))) {
  const queued = (state.agentDispatches || []).filter((item) => item.status === "queued"
    && projectIdSet.has(item.projectId)
    && (!item.assignedNodeId || item.assignedNodeId === node.nodeId));
  const reasons = [];
  for (const item of queued.slice(0, 5)) {
    const contract = (state.agentTaskContracts || []).find((candidate) =>
      candidate.sessionId === item.sessionId && candidate.runId === item.runId);
    if (!contract) { reasons.push({dispatchId: item.dispatchId, reason: "task_contract_missing"}); continue; }
    if (contract.expiresAt && new Date(contract.expiresAt).getTime() <= Date.now()) {
      reasons.push({dispatchId: item.dispatchId, reason: "task_contract_expired"});
      continue;
    }
    if (!roleAllowed(contract.roleId, node.allowedRoles)) {
      reasons.push({dispatchId: item.dispatchId, reason: "role_not_allowed_on_node",
        requiredRole: contract.roleId, nodeRoles: node.allowedRoles});
      continue;
    }
    if (!modelRunnable(contract.model, node.profile)) {
      reasons.push({dispatchId: item.dispatchId, reason: "model_not_runnable_on_node",
        requiredModel: contract.model?.providerClass || contract.model?.alias || contract.model?.model || "unknown",
        nodeProviders: [...new Set((node.profile?.models || []).filter((m) => m.available !== false)
          .map((m) => m.providerClass || m.provider).filter(Boolean))]});
      continue;
    }
    reasons.push({dispatchId: item.dispatchId, reason: "unknown"});
  }
  return {at: new Date().toISOString(), queuedCount: queued.length, reasons};
}

function roleAllowed(role, allowedRoles) {
  return allowedRoles.includes("*") || allowedRoles.includes(role);
}

function rolesAllowed(requested, allowed) {
  return allowed.includes("*") || requested.every((role) => allowed.includes(role));
}

function modelRunnable(model, profile = {}) {
  const providers = new Set((profile.models || []).filter((item) => item.available !== false).map((item) => item.providerClass || item.provider).filter(Boolean));
  if (!providers.size) return false;
  const provider = String(model?.providerClass || model?.alias || String(model?.modelId || model?.model || "").split(":")[0] || "custom");
  return providers.has(provider) || providers.has("custom");
}

function sanitizeNodeProfile(profile) {
  return {
    platform: String(profile.platform || "unknown"),
    arch: String(profile.arch || "unknown"),
    cpuCount: boundedInteger(profile.cpuCount, 0, 4096, 0),
    memoryBytes: boundedInteger(profile.memoryBytes, 0, Number.MAX_SAFE_INTEGER, 0),
    diskFreeBytes: boundedInteger(profile.diskFreeBytes, 0, Number.MAX_SAFE_INTEGER, 0),
    // 条数截到 100 了，【条目里的字符串】原先一个都没截 —— 同一个函数里 region/dataRoot 都截了，
    // 数组里的没截，是"只补一半"长在一个函数内部的样子。节点自报 100 个工具、每个名字 20KB，
    // 就是 2MB 的 profile 常驻中央状态，而每次写入的成本正比于状态大小。
    // 这里用截断而不是拒绝：profile 是机器上报的观测值，不是人写的文字，
    // truncate 掉超长的名字不会让任何人"看到的与自己写的不一致"（与 region/dataRoot 同规）。
    tools: Array.isArray(profile.tools) ? profile.tools.filter((item) => item && typeof item === "object").slice(0, 100).map((item) => ({name: String(item.name || "").slice(0, 200), version: String(item.version || "unknown").slice(0, 100), available: item.available === true})) : [],
    models: Array.isArray(profile.models) ? profile.models.filter((item) => item && typeof item === "object").slice(0, 100).map((item) => ({providerClass: String(item.providerClass || "custom").slice(0, 100), adapter: String(item.adapter || "custom").slice(0, 100), available: item.available !== false})) : [],
    capabilityFlags: uniqueStrings(profile.capabilityFlags || []).slice(0, 100).map((flag) => String(flag).slice(0, 100)),
    ...(sanitizePermissionProbe(profile.permission) ? {permission: sanitizePermissionProbe(profile.permission)} : {}),
    ...(sanitizeIntegrityProbe(profile.integrity) ? {integrity: sanitizeIntegrityProbe(profile.integrity)} : {}),
    region: String(profile.region || "").slice(0, 100) || undefined,
    dataRoot: String(profile.dataRoot || "").slice(0, 500) || undefined,
    networkSpeedMbps: Number.isFinite(Number(profile.networkSpeedMbps)) && Number(profile.networkSpeedMbps) > 0 ? Number(profile.networkSpeedMbps) : undefined,
    observedAt: new Date().toISOString()
  };
}

// §3.2 permission probe ingestion — additive-optional. Each raw observation keeps its detection method and
// whether it was produced by an automated tool invocation (toolDriven), per sys.full-chain-diagnosis.
function sanitizePermissionProbe(permission) {
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return undefined;
  const fields = ["os", "browser", "credentialHelper", "oauth", "network", "git", "db", "keychainSudo"];
  const result = {};
  for (const field of fields) {
    const raw = permission[field];
    if (raw === undefined) continue;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      result[field] = {
        status: ["available", "unavailable", "unknown", "denied"].includes(raw.status) ? raw.status : "unknown",
        detectedBy: String(raw.detectedBy || "default").slice(0, 80),
        toolDriven: raw.toolDriven === true
      };
    } else {
      result[field] = {status: raw === true ? "available" : raw === false ? "unavailable" : "unknown", detectedBy: "default", toolDriven: false};
    }
  }
  return Object.keys(result).length ? result : undefined;
}

// §3.2 integrity probe ingestion — additive-optional runtime/installer/config digests and sandbox mode.
function sanitizeIntegrityProbe(integrity) {
  if (!integrity || typeof integrity !== "object" || Array.isArray(integrity)) return undefined;
  const digest = (value) => /^sha256:[a-f0-9]{64}$/u.test(String(value || "")) ? String(value) : "unknown";
  return {
    runtimeDigest: digest(integrity.runtimeDigest),
    installerDigest: digest(integrity.installerDigest),
    configDigest: digest(integrity.configDigest),
    sandboxMode: String(integrity.sandboxMode || "unknown").slice(0, 60)
  };
}

function normalizeChecks(checks) {
  return checks.slice(0, 100).map((check) => ({
    checkId: String(check.checkId || "unknown"),
    status: check.status === "ok" ? "ok" : "failed",
    detail: String(check.detail || "").slice(0, 1000)
  }));
}

// 原先是"逐个剥掉已知敏感字段"的黑名单式脱敏，于是我后来加的 registrationReplay 自然漏网 ——
// 它整份存着注册结果，里面含【明文 nodeToken】，而 join token 会随 state 下发给任何持
// project:view 的项目成员。读的门槛比签发（需要 agent:activate）低一整级，拿到明文令牌即可冒充节点：
// 领派发、报执行事件、按 allowedMcpTools 调 MCP、拉取该租户数据；而令牌要到剩余不足 7 天才轮换，
// 注册时给的是 30 天，也就是约 23 天内一直有效。
// 改为白名单：只放行确定安全的字段，将来新增的字段默认不外泄 —— 这类泄露必须默认关闭。
const PUBLIC_JOIN_TOKEN_FIELDS = ["schemaVersion", "joinTokenId", "projectId", "organizationId", "registrationScope",
  "expectedNodeName", "allowedRoles", "allowedMcpTools", "status", "maxUses", "useCount",
  "expiresAt", "createdBy", "createdAt", "updatedAt", "consumedAt", "revokedAt", "revokedBy"];

function publicJoinToken(record) {
  const safe = {};
  for (const field of PUBLIC_JOIN_TOKEN_FIELDS) {
    if (record[field] !== undefined) safe[field] = record[field];
  }
  return safe;
}

function appendGatewayEvent(state, eventType, subjectId, payload) {
  state.agentGatewayEvents.unshift({schemaVersion: "agent-gateway-event/v1", eventId: createId("age"), eventType, subjectId, payload, createdAt: new Date().toISOString()});
  state.agentGatewayEvents = state.agentGatewayEvents.slice(0, 1000);
}

// 与 agent 运行时那份孪生实现对齐：`String(value)` 会把 null/undefined/0/false 变成
// 字符串 "null"/"undefined"/"0"/"false" 并留在结果里 —— 而这里过的全是调用方给的东西
//（allowedRoles / requestedRoles / evidenceRefs / capabilityFlags）。
// 一个 [null] 就会被存成名为 "null" 的角色，然后在授权比对里当作一个真角色参与。
function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function boundedInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function inside(root, target) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(prefix);
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

function shellArg(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function shellUrl(value) {
  if (!/^https?:\/\//u.test(value)) throw new Error("public_url_must_be_http_or_https");
  return shellArg(value);
}

function gatewayError(message, status, details = null) {
  const error = new Error(message);
  error.status = status;
  if (details) error.details = details;
  return error;
}
