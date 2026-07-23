import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const publicDir = join(root, "apps", "control-plane-ui", "public");
const runtimeDir = resolve(root, process.env.AIMAC_RUNTIME_DIR || ".runtime");
const statePath = join(runtimeDir, "control-plane-state.json");
const seedPath = join(root, "data", "seed-state.json");
const host = process.env.AIMAC_HOST || "127.0.0.1";
const port = Number(process.env.AIMAC_PORT || 4317);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function now() {
  return new Date().toISOString();
}

function ensureState() {
  mkdirSync(runtimeDir, { recursive: true });
  if (!existsSync(statePath)) {
    const seed = JSON.parse(readFileSync(seedPath, "utf8"));
    seed.runtime.updatedAt = now();
    writeState(seed);
  }
}

function readState() {
  ensureState();
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function writeState(state) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function audit(state, actor, action, subject, result = "succeeded") {
  ensureControlState(state);
  state.auditLog.unshift({
    id: `audit_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    at: now(),
    actor,
    action,
    subject,
    result
  });
  state.auditLog = state.auditLog.slice(0, 80);
}

function ensureControlState(state) {
  state.stateVersion ||= 1;
  state.auditLog ||= [];
  state.policyDecisions ||= [];
  state.commands ||= [];
  state.idempotencyRecords ||= {};
}

function beginGuardedWrite(req, state, action, subject) {
  ensureControlState(state);
  const idempotencyKey = req.headers["idempotency-key"];
  if (!idempotencyKey) {
    return {status: 428, payload: {error: "idempotency_key_required"}};
  }
  if (state.idempotencyRecords[idempotencyKey]) {
    return state.idempotencyRecords[idempotencyKey];
  }
  const at = now();
  const policyDecision = {
    id: createId("pd"),
    status: "allowed",
    actor: "ui-console-service",
    action,
    resource: subject,
    policyVersion: "local-demo-policy/v1",
    evidenceRefs: [`idempotency:${idempotencyKey}`],
    createdAt: at
  };
  const command = {
    id: createId("cmd"),
    type: action,
    subject,
    status: "admitted",
    idempotencyKey,
    policyDecisionRef: policyDecision.id,
    createdAt: at,
    updatedAt: at
  };
  return {idempotencyKey, policyDecision, command};
}

function finishGuardedWrite(state, guard, status, payload) {
  ensureControlState(state);
  const updatedAt = now();
  state.stateVersion += 1;
  state.policyDecisions.unshift(guard.policyDecision);
  state.commands.unshift({...guard.command, status: "succeeded", resultRef: `response:${guard.idempotencyKey}`, updatedAt});
  state.policyDecisions = state.policyDecisions.slice(0, 120);
  state.commands = state.commands.slice(0, 120);
  state.idempotencyRecords[guard.idempotencyKey] = {status, payload};
  audit(state, "policy-engine", "policy_decision_allowed", guard.command.subject);
  audit(state, "command-bus", "command_succeeded", guard.command.subject);
}

function accountIdOf(account) {
  return account.accountId || account.id;
}

function stableDigest(fill) {
  return `sha256:${fill.repeat(64).slice(0, 64)}`;
}

function gitTrackablePath(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.startsWith("artifacts/") && !path.startsWith(".runtime/") && !path.startsWith("tmp/") && !path.includes("..");
}

function validPathAllowlist(paths) {
  return Array.isArray(paths) && paths.length > 0 && paths.every(gitTrackablePath);
}

function json(res, status, payload) {
  res.writeHead(status, {"content-type": "application/json; charset=utf-8"});
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const target = normalize(join(publicDir, requested));
  if (!target.startsWith(publicDir) || !existsSync(target)) {
    res.writeHead(404, {"content-type": "text/plain; charset=utf-8"});
    res.end("Not found");
    return;
  }
  res.writeHead(200, {"content-type": mimeTypes[extname(target)] || "application/octet-stream"});
  res.end(readFileSync(target));
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const state = readState();
  const body = req.method === "POST" ? await parseBody(req) : {};

  if (req.method === "GET" && ["/api/health", "/api/runtime/health"].includes(url.pathname)) {
    json(res, 200, {status: "ok", runtime: state.runtime.status, at: now()});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    json(res, 200, state);
    return;
  }

  const projectProgressMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/progress$/);
  if (req.method === "GET" && projectProgressMatch) {
    const project = state.projects.find((item) => item.id === projectProgressMatch[1]);
    if (!project) {
      json(res, 404, {error: "project_not_found"});
      return;
    }
    json(res, 200, {
      projectId: project.id,
      progress: project.progress,
      repositoryOutputs: (state.repositoryOutputs || []).filter((target) => target.projectId === project.id)
    });
    return;
  }

  const taskGroupProgressMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/progress$/);
  if (req.method === "GET" && taskGroupProgressMatch) {
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupProgressMatch[1]);
    if (!taskGroup) {
      json(res, 404, {error: "task_group_not_found"});
      return;
    }
    json(res, 200, {
      taskGroupId: taskGroup.id,
      phase: taskGroup.phase,
      progress: taskGroup.progress,
      health: taskGroup.health,
      roles: taskGroup.roles,
      workItems: taskGroup.workItems,
      blockers: taskGroup.blockers,
      repositoryOutputs: (state.repositoryOutputs || []).filter((target) => target.taskGroupId === taskGroup.id)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/bootstrap/init") {
    const guard = beginGuardedWrite(req, state, "bootstrap_init", "RuntimeBootstrapProfile:runtime_local");
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const seed = JSON.parse(readFileSync(seedPath, "utf8"));
    seed.runtime.updatedAt = now();
    finishGuardedWrite(seed, guard, 200, {profileId: "runtime_local"});
    audit(seed, "system", "bootstrap_init", "RuntimeBootstrapProfile:runtime_local");
    writeState(seed);
    json(res, 200, seed);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    const guard = beginGuardedWrite(req, state, "project_create", "Project:new");
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const id = createId("prj");
    const ownerAccountId = body.ownerAccountId || "acct_workspace_owner";
    state.projects.push({
      id,
      name: body.name || "Untitled Project",
      status: "active",
      ownerAccountId,
      members: [{accountId: ownerAccountId, role: "project_owner"}],
      progress: {percent: 0, phase: "intake", health: "ok", openTaskGroups: 0, blockedItems: 0, updatedAt: now()}
    });
    audit(state, ownerAccountId, "project_create", `Project:${id}`);
    finishGuardedWrite(state, guard, 201, {id});
    writeState(state);
    json(res, 201, {id});
    return;
  }

  const memberMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/members$/);
  if (req.method === "POST" && memberMatch) {
    const project = state.projects.find((item) => item.id === memberMatch[1]);
    if (!project) {
      json(res, 404, {error: "project_not_found"});
      return;
    }
    const accountId = body.accountId;
    if (!state.accounts.some((account) => accountIdOf(account) === accountId)) {
      json(res, 400, {error: "account_not_found"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "project_member_grant", `Project:${project.id}`);
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    project.members = project.members.filter((member) => member.accountId !== accountId);
    project.members.push({accountId, role: body.role || "viewer"});
    state.accessGrants.push({
      schemaVersion: "access-control-grant/v1",
      grantId: createId("grant"),
      subjectRef: {subjectType: "account", subjectId: accountId},
      resource: {resourceType: "project", resourceId: project.id},
      role: body.role || "viewer",
      permissions: body.permissions || ["project:view"],
      status: "active",
      policyDecisionRef: guard.policyDecision.id,
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: now(),
      updatedAt: now()
    });
    audit(state, "ui-console-service", "project_member_grant", `Project:${project.id}`);
    finishGuardedWrite(state, guard, 200, project);
    writeState(state);
    json(res, 200, project);
    return;
  }

  const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/(?:activate|activation)$/);
  if (req.method === "POST" && agentMatch) {
    const agent = state.agents.find((item) => item.id === agentMatch[1]);
    if (!agent) {
      json(res, 404, {error: "agent_not_found"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "agent_activation_update", `AgentNode:${agent.id}`);
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    agent.status = body.active === false ? "inactive" : "active";
    agent.capacity = agent.status === "active" ? "ready" : "standby";
    audit(state, "ui-console-service", "agent_activation_update", `AgentNode:${agent.id}`);
    finishGuardedWrite(state, guard, 200, agent);
    writeState(state);
    json(res, 200, agent);
    return;
  }

  const taskGroupMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/control$/);
  if (req.method === "POST" && taskGroupMatch) {
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupMatch[1]);
    if (!taskGroup) {
      json(res, 404, {error: "task_group_not_found"});
      return;
    }
    const guard = beginGuardedWrite(req, state, `task_group_${body.action || "recompute_readiness"}`, `TaskGroup:${taskGroup.id}`);
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const action = body.action || "recompute_readiness";
    if (action === "pause") taskGroup.goalExecutionStatus = "active_paused_by_control";
    if (action === "resume") taskGroup.goalExecutionStatus = "active";
    if (action === "request_review") taskGroup.reviewState = "review_requested";
    if (action === "rebound_drift") taskGroup.health = "attention";
    taskGroup.updatedAt = now();
    audit(state, "ui-console-service", `task_group_${action}`, `TaskGroup:${taskGroup.id}`);
    finishGuardedWrite(state, guard, 200, taskGroup);
    writeState(state);
    json(res, 200, taskGroup);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const guard = beginGuardedWrite(req, state, "account_invite", "Account:new");
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const at = now();
    const accountId = createId("acct");
    const account = {
      schemaVersion: "account/v1",
      accountId,
      accountType: body.accountType || "user_account",
      displayName: body.displayName || "New User",
      email: body.email || `user-${Date.now()}@local`,
      status: "invited",
      roles: body.roles || ["viewer"],
      permissions: body.permissions || ["project:view"],
      authPolicy: {method: "invite_token", mfaRequired: false, passwordSet: false, sessionTtlSeconds: 3600},
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.accounts.push(account);
    audit(state, "ui-console-service", "account_invite", `Account:${account.accountId}`);
    finishGuardedWrite(state, guard, 201, account);
    writeState(state);
    json(res, 201, account);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/access-grants") {
    const guard = beginGuardedWrite(req, state, "access_grant_create", `${body.resourceType || "project"}:${body.resourceId || "prj_control_plane"}`);
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const at = now();
    const grant = {
      schemaVersion: "access-control-grant/v1",
      grantId: createId("grant"),
      subjectRef: {subjectType: "account", subjectId: body.subjectId || "acct_workspace_owner"},
      resource: {resourceType: body.resourceType || "project", resourceId: body.resourceId || "prj_control_plane"},
      role: body.role || "viewer",
      permissions: body.permissions || ["project:view"],
      status: "active",
      policyDecisionRef: guard.policyDecision.id,
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.accessGrants.push(grant);
    audit(state, "ui-console-service", "access_grant_create", `${grant.resource.resourceType}:${grant.resource.resourceId}`);
    finishGuardedWrite(state, guard, 201, grant);
    writeState(state);
    json(res, 201, grant);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/instruction-envelopes") {
    const guard = beginGuardedWrite(req, state, "instruction_envelope_create", "InstructionEnvelope:new");
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const at = now();
    const envelope = {
      schemaVersion: "instruction-envelope/v1",
      envelopeId: createId("env"),
      taskGroupId: body.taskGroupId || "tg_runtime_management",
      recipientRole: body.recipientRole || "orchestrator",
      effectiveInstructionPacketRef: body.effectiveInstructionPacketRef || "eip_runtime_management",
      formatVersion: "ai-native-instruction-envelope/v1",
      stablePrefixDigest: body.stablePrefixDigest || stableDigest("6"),
      digestRefs: body.digestRefs || ["ruleset:runtime:v1"],
      sharedDefinitionRefs: body.sharedDefinitionRefs || [],
      cacheKey: body.cacheKey || `runtime:v1:${Date.now()}`,
      status: "cache_indexed",
      tokenBudget: body.tokenBudget || {maxInputTokens: 4096, targetDeltaTokens: Number(body.estimatedTokens || 320), maxOutputTokens: 1200},
      outputContractRef: body.outputContractRef || "spec/checkpoint.schema.json",
      payloadDigest: body.payloadDigest || stableDigest("7"),
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.instructionMetrics.envelopes.push(envelope);
    audit(state, "instruction-optimizer", "instruction_envelope_create", `InstructionEnvelope:${envelope.envelopeId}`);
    finishGuardedWrite(state, guard, 201, envelope);
    writeState(state);
    json(res, 201, envelope);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/shared-definition-contracts") {
    const guard = beginGuardedWrite(req, state, "shared_definition_contract_create", "SharedDefinitionContract:new");
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const at = now();
    const definition = {
      schemaVersion: "shared-definition-contract/v1",
      contractId: createId("sdc"),
      projectId: body.projectId || "prj_control_plane",
      definitionType: body.definitionType || "terminology",
      scopeRefs: body.scopeRefs || ["Project"],
      canonicalOwnerRole: body.canonicalOwnerRole || "orchestrator",
      producerRole: body.producerRole || "decision-center",
      status: body.status || "owner_assigned",
      definitionDigest: body.definitionDigest || stableDigest("8"),
      consumerRefs: body.consumerRefs || [],
      repositoryOutputTargetRef: body.repositoryOutputTargetRef || "rot_runtime_management",
      repositoryOutputTargetDigest: body.repositoryOutputTargetDigest || stableDigest("9"),
      conflictPolicy: body.conflictPolicy || "block_and_request_canonical_decision",
      changePolicy: body.changePolicy || {requiresDecisionRecord: true, invalidatesConsumers: true, consumerAckRequired: true},
      reviewEvidenceRefs: body.reviewEvidenceRefs || ["review:auto"],
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.sharedDefinitions.push(definition);
    audit(state, "orchestrator", "shared_definition_contract_create", `SharedDefinitionContract:${definition.contractId}`);
    finishGuardedWrite(state, guard, 201, definition);
    writeState(state);
    json(res, 201, definition);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/repository-output-targets") {
    const pathAllowlist = body.pathAllowlist || ["docs/**", "spec/**"];
    const artifactManifestPath = body.artifactManifestPath || `docs/artifact-manifests/manifest.${Date.now()}.json`;
    if (!validPathAllowlist(pathAllowlist) || !gitTrackablePath(artifactManifestPath)) {
      json(res, 400, {error: "repository_output_target_must_use_git_trackable_paths"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "repository_output_target_select", "RepositoryOutputTarget:new");
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const at = now();
    const target = {
      schemaVersion: "repository-output-target/v1",
      targetId: createId("rot"),
      projectId: body.projectId || "prj_control_plane",
      taskGroupId: body.taskGroupId || "tg_runtime_management",
      workItemId: body.workItemId || "work_unknown",
      repositoryId: body.repositoryId || "repo_control_plane",
      branch: body.branch || "main",
      baseRef: body.baseRef || "HEAD",
      pathAllowlist,
      status: "selected",
      outputPolicy: "project_git_repository_only",
      decisionRecordRef: body.decisionRecordRef || guard.policyDecision.id,
      artifactManifestPath,
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.repositoryOutputs ||= [];
    state.repositoryOutputs.push(target);
    audit(state, "repository-router", "repository_output_target_select", `RepositoryOutputTarget:${target.targetId}`);
    finishGuardedWrite(state, guard, 201, target);
    writeState(state);
    json(res, 201, target);
    return;
  }

  json(res, 404, {error: "api_not_found"});
}

const server = createServer((req, res) => {
  if (!req.url.startsWith("/api/")) {
    serveStatic(req, res);
    return;
  }

  handleApi(req, res).catch((error) => {
    json(res, 500, {error: "server_error", message: error.message});
  });
});

ensureState();
server.listen(port, host, () => {
  console.log(`AI Multi-Agent Ctrl console: http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
});
