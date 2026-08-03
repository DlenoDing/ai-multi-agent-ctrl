import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";
import { cancelPendingConfirmationsForDispatch, createId, digestOf, effectiveTaskGroupConfig, ensureRuntimeCollections, expireStaleQueuedDispatches, languagePolicyDirective, normalizeTaskGroupLanguagePolicy, organizationQuotaCheck,
  computeEffectiveRulesDigest, applyEffectiveRulesDigest
} from "./control-plane-core.mjs";

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
  const projectId = String(input.projectId || "").trim();
  const tokenProject = state.projects.find((project) => project.id === projectId);
  if (!tokenProject) throw new Error("join_token_project_not_found");
  const tokenOrgId = tokenProject.organizationId || "org_default";
  const outstandingJoinTokens = (state.agentJoinTokens || []).filter((item) => item.status === "issued" && (item.organizationId || "org_default") === tokenOrgId && new Date(item.expiresAt).getTime() > Date.now()).length;
  const quota = organizationQuotaCheck(state, tokenOrgId, "agents");
  if (!quota.allowed || quota.usage + outstandingJoinTokens >= quota.quota) {
    throw gatewayError("org_quota_exceeded", 409, {kind: "agents", quota: quota.quota, usage: (quota.usage || 0) + outstandingJoinTokens});
  }
  const ttlSeconds = boundedInteger(input.ttlSeconds, 60, 86400, 1800);
  if (input.maxUses !== undefined && Number(input.maxUses) !== 1) throw gatewayError("join_token_must_be_one_time", 400);
  const maxUses = 1;
  const allowedRoles = uniqueStrings(input.allowedRoles?.length ? input.allowedRoles : ["agent-runtime"]);
  const token = `aimac_join_${randomBytes(32).toString("base64url")}`;
  const at = new Date().toISOString();
  const record = {
    schemaVersion: "agent-join-token/v1",
    joinTokenId: createId("ajt"),
    projectId,
    organizationId: tokenProject.organizationId || "org_default",
    expectedNodeName: String(input.nodeName || input.expectedNodeName || "").trim() || null,
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
  const tokenFileCommand = `umask 077; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT HUP INT TERM; cat > "$tmp/aimac.join" <<'AIMAC_JOIN_TOKEN'\n${token}\nAIMAC_JOIN_TOKEN\ncurl -fsSL ${shellUrl(`${serverUrl}/install-agent.sh`)} | sh -s -- --server ${shellArg(serverUrl)} --join-token-file "$tmp/aimac.join"${nodeNameArg}`;
  const verifiedTokenFileCommand = `umask 077; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT HUP INT TERM; cat > "$tmp/aimac.join" <<'AIMAC_JOIN_TOKEN'\n${token}\nAIMAC_JOIN_TOKEN\ncd "$tmp" && curl -fsSLO ${shellUrl(`${serverUrl}/install-agent.sh`)} && curl -fsSLO ${shellUrl(`${serverUrl}/install-agent.sh.sha256`)} && ( if command -v sha256sum >/dev/null 2>&1; then sha256sum -c install-agent.sh.sha256; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -c install-agent.sh.sha256; else printf '%s\\n' 'sha256sum or shasum is required' >&2; exit 1; fi ) && sh install-agent.sh --server ${shellArg(serverUrl)} --join-token-file "$tmp/aimac.join"${nodeNameArg}`;
  appendGatewayEvent(state, "join_token_issued", record.joinTokenId, {projectId, allowedRoles});
  return {
    joinToken: token,
    joinTokenRecord: publicJoinToken(record),
    installCommand: tokenFileCommand,
    verifiedInstallCommand: verifiedTokenFileCommand
  };
}

export function listAgentJoinTokens(state, projectId) {
  ensureAgentGatewayCollections(state);
  return state.agentJoinTokens
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
      return {...replay.result, node: publicAgentNode(existingNode), replayed: true};
    }
  }
  if (record.status !== "issued") throw gatewayError("join_token_not_active", 409);
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
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
  if (!rolesAllowed(requestedRoles, record.allowedRoles)) throw gatewayError("join_token_role_scope_mismatch", 403);
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
    projectIds: [record.projectId],
    allowedRoles: requestedRoles,
    allowedMcpTools: record.allowedMcpTools,
    status: "initializing",
    admission: "limited",
    credentialDigest: digestOf(`agent-node:${nodeId}:${nodeToken}`),
    credentialIssuedAt: at,
    credentialExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    profile,
    profileDigest: digestOf(profile),
    runtimeVersion: String(input.runtimeVersion || "unknown"),
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
  appendGatewayEvent(state, "node_registered", nodeId, {projectId: record.projectId, profileDigest: node.profileDigest});
  const publicUrl = trimTrailingSlash(options.publicUrl || "http://127.0.0.1:4317");
  const registration = {
    node: publicAgentNode(node),
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

export function authenticateAgentNode(state, bearerToken) {
  ensureAgentGatewayCollections(state);
  const token = String(bearerToken || "");
  if (!token.startsWith("aimac_node_")) return null;
  const cachedNodeId = nodeTokenCache.get(token);
  if (cachedNodeId) {
    const node = state.agentRuntimeNodes.find((item) => item.nodeId === cachedNodeId);
    if (node && nodeAcceptsToken(node, token)) return node;
    nodeTokenCache.delete(token);
  }
  for (const node of state.agentRuntimeNodes) {
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
  if (["initializing", "offline", "degraded"].includes(node.status)) node.status = "online";
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
  const heartbeatPersistFloorMs = Math.max(30000, Number(process.env.AIMAC_HEARTBEAT_PERSIST_FLOOR_MS || 120000));
  const persistRequired = reconciled ||
    Boolean(rotatedNodeToken) ||
    node.status !== previousStatus ||
    node.profileDigest !== previousProfileDigest ||
    !previousHeartbeatAt ||
    Date.now() - new Date(previousHeartbeatAt).getTime() >= heartbeatPersistFloorMs ||
    (node.activeDispatchIds || []).length > 0;
  appendGatewayEvent(state, "node_heartbeat", node.nodeId, {profileDigest: node.profileDigest, credentialRotated: Boolean(rotatedNodeToken)});
  const queuedCommands = (state.agentControlCommands || []).filter((command) => command.nodeId === node.nodeId && command.status === "queued").length;
  return {ok: true, accepted: true, commandsAvailable: queuedCommands, node: publicAgentNode(node), serverTime: at, persistRequired, ...(rotatedNodeToken ? {nodeToken: rotatedNodeToken} : {})};
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
  return {ok: missing.length === 0, admission: node.admission, missingChecks: missing, node: publicAgentNode(node)};
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
  if (node.status !== "online" || node.admission !== "full") return {dispatch: null, reason: "node_not_admitted"};
  recycleExpiredClaims(state);
  expireStaleQueuedDispatches(state);
  const dispatch = state.agentDispatches.find((item) => {
    if (item.status !== "queued") return false;
    if (!node.projectIds.includes(item.projectId)) return false;
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
    node.lastClaimMiss = summarizeClaimMiss(state, node);
    node.updatedAt = new Date().toISOString();
    return {dispatch: null, reason: "no_compatible_dispatch"};
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

export function sweepDeadAgentNodes(state, nowMs = Date.now()) {
  const graceMs = boundedInteger(process.env.AIMAC_NODE_HEARTBEAT_TIMEOUT_MS, 60000, 86400000, 900000);
  const swept = [];
  for (const node of state.agentRuntimeNodes || []) {
    if (!["online", "degraded", "draining", "initializing"].includes(node.status)) continue;
    const lastBeat = new Date(node.lastHeartbeatAt || node.registeredAt || 0).getTime();
    if (!lastBeat || nowMs - lastBeat < graceMs) continue;
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
    expiresAt: input.expiresAt || new Date(Date.now() + boundedInteger(input.ttlSeconds, 60, 86400, 1800) * 1000).toISOString(),
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
  const status = ["received", "acked", "completed", "failed", "rejected"].includes(input.status) ? input.status : "acked";
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
  state.agentExecutionEvents = state.agentExecutionEvents.slice(0, 500);
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
  if (!skillWorkset) {
    try {
      skillWorkset = buildSkillWorkset(state, contract, options);
    } catch {
      skillWorkset = null;
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
  const guidance = (taskGroup.humanGuidance || []).map((item) => `- ${item.text}`).join("\n");
  const contextText = [
    `# 任务上下文`,
    `任务组：${taskGroup.id}（${taskGroup.phase || taskGroup.status || ""}）`,
    taskGroup.objective ? `目标：${taskGroup.objective}` : "",
    guidance ? `\n## 人工补充要求\n${guidance}` : "",
    taskGroup.taskAnalysis ? `\n## 事项清单\n${taskGroup.taskAnalysis.items.map((item) => `- [${item.status}] ${item.title}`).join("\n")}` : ""
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
  if (!contract || !node.projectIds.includes(contract.projectId)) throw gatewayError("skill_workset_not_found", 404);
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
  "schemaVersion", "nodeId", "nodeName", "organizationId", "projectIds",
  "allowedRoles", "allowedMcpTools", "status", "admission",
  "profile", "profileDigest", "runtimeVersion", "runtimeOutdated",
  "lastHeartbeatAt", "lastSelfCheckAt", "selfCheckDigest", "selfCheckMissing", "selfCheckFailures",
  "activeDispatchIds", "completedDispatchCount", "failedDispatchCount",
  "lastClaimMiss", "offlineReason", "revokedReason",
  "revocationDeadlineAt", "revocationFinalizedAt", "revocationFinalizedReason",
  "createdAt", "updatedAt"
];

export function publicAgentNode(node) {
  const safe = {};
  for (const field of PUBLIC_AGENT_NODE_FIELDS) {
    if (node[field] !== undefined) safe[field] = node[field];
  }
  // 派生字段：每次投影时算，不落库 —— 要求版本会随契约变化，持久化下来的判定必然过期。
  safe.runtimeOutdated = agentRuntimeOutdated(node);
  return safe;
}

function buildDispatchPackage(state, dispatch, node, options) {
  const contract = state.agentTaskContracts.find((item) => item.sessionId === dispatch.sessionId && item.runId === dispatch.runId);
  const repositoryOutputTarget = state.repositoryOutputs.find((item) => item.targetId === dispatch.repositoryOutputTargetRef);
  const instructionPacket = state.effectiveInstructionPackets.find((item) => item.packetId === contract?.effectiveInstructionPacketRef);
  if (!contract || !repositoryOutputTarget || !instructionPacket) throw gatewayError("dispatch_package_incomplete", 409);
  const skillWorkset = buildSkillWorkset(state, contract, options);
  return {
    schemaVersion: "agent-dispatch-package/v1",
    dispatch,
    taskContract: contract,
    effectiveInstructionPacket: instructionPacket,
    repositoryOutputTarget,
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
    if (digestOf(content) !== skill.contentDigest) throw gatewayError("role_skill_digest_mismatch", 409);
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

function mcpToolsForRoles(roles) {
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

// 逐条说清"这个排队中的派发为什么这个节点接不了"。只留前几条：人要的是原因，不是清单。
function summarizeClaimMiss(state, node) {
  const queued = (state.agentDispatches || []).filter((item) => item.status === "queued"
    && node.projectIds.includes(item.projectId)
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
    tools: Array.isArray(profile.tools) ? profile.tools.filter((item) => item && typeof item === "object").slice(0, 100).map((item) => ({name: String(item.name || ""), version: String(item.version || "unknown"), available: item.available === true})) : [],
    models: Array.isArray(profile.models) ? profile.models.filter((item) => item && typeof item === "object").slice(0, 100).map((item) => ({providerClass: String(item.providerClass || "custom"), adapter: String(item.adapter || "custom"), available: item.available !== false})) : [],
    capabilityFlags: uniqueStrings(profile.capabilityFlags || []).slice(0, 100),
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
const PUBLIC_JOIN_TOKEN_FIELDS = ["schemaVersion", "joinTokenId", "projectId", "organizationId",
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
  state.agentGatewayEvents.unshift({eventId: createId("age"), eventType, subjectId, payload, createdAt: new Date().toISOString()});
  state.agentGatewayEvents = state.agentGatewayEvents.slice(0, 1000);
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))];
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
