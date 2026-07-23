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
    seed.runtime.initializedAt = now();
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
    const seed = JSON.parse(readFileSync(seedPath, "utf8"));
    seed.runtime.initializedAt = now();
    audit(seed, "system", "bootstrap_init", "RuntimeBootstrapProfile:runtime_local");
    writeState(seed);
    json(res, 200, seed);
    return;
  }

  const body = req.method === "POST" ? await parseBody(req) : {};

  if (req.method === "POST" && url.pathname === "/api/projects") {
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
    if (!state.accounts.some((account) => account.id === accountId)) {
      json(res, 400, {error: "account_not_found"});
      return;
    }
    project.members = project.members.filter((member) => member.accountId !== accountId);
    project.members.push({accountId, role: body.role || "project_viewer"});
    state.accessGrants.push({
      id: createId("grant"),
      subjectId: accountId,
      resourceType: "project",
      resourceId: project.id,
      role: body.role || "project_viewer",
      permissions: body.permissions || ["project:view"],
      status: "active"
    });
    audit(state, "ui-console-service", "project_member_grant", `Project:${project.id}`);
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
    agent.status = body.active === false ? "inactive" : "active";
    agent.capacity = agent.status === "active" ? "ready" : "standby";
    audit(state, "ui-console-service", "agent_activation_update", `AgentNode:${agent.id}`);
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
    const action = body.action || "recompute_readiness";
    if (action === "pause") taskGroup.status = "paused";
    if (action === "resume") taskGroup.status = "in_progress";
    if (action === "request_review") taskGroup.status = "review_requested";
    if (action === "rebound_drift") taskGroup.health = "attention";
    audit(state, "ui-console-service", `task_group_${action}`, `TaskGroup:${taskGroup.id}`);
    writeState(state);
    json(res, 200, taskGroup);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const account = {
      id: createId("acct"),
      accountType: body.accountType || "user_account",
      displayName: body.displayName || "New User",
      email: body.email || `user-${Date.now()}@local`,
      status: "invited",
      roles: body.roles || ["project_viewer"],
      permissions: body.permissions || ["project:view"],
      auth: {method: "invite_token", passwordSet: false}
    };
    state.accounts.push(account);
    audit(state, "ui-console-service", "account_invite", `Account:${account.id}`);
    writeState(state);
    json(res, 201, account);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/access-grants") {
    const grant = {
      id: createId("grant"),
      subjectId: body.subjectId || "acct_workspace_owner",
      resourceType: body.resourceType || "project",
      resourceId: body.resourceId || "prj_control_plane",
      role: body.role || "viewer",
      permissions: body.permissions || ["project:view"],
      status: "active"
    };
    state.accessGrants.push(grant);
    audit(state, "ui-console-service", "access_grant_create", `${grant.resourceType}:${grant.resourceId}`);
    writeState(state);
    json(res, 201, grant);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/instruction-envelopes") {
    const envelope = {
      id: createId("env"),
      recipientRole: body.recipientRole || "orchestrator",
      cacheKey: body.cacheKey || `runtime:v1:${Date.now()}`,
      status: "cache_indexed",
      estimatedTokens: Number(body.estimatedTokens || 320)
    };
    state.instructionMetrics.envelopes.push(envelope);
    audit(state, "instruction-optimizer", "instruction_envelope_create", `InstructionEnvelope:${envelope.id}`);
    writeState(state);
    json(res, 201, envelope);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/shared-definition-contracts") {
    const definition = {
      id: createId("sdc"),
      name: body.name || "Shared Definition",
      definitionType: body.definitionType || "terminology",
      canonicalOwnerRole: body.canonicalOwnerRole || "orchestrator",
      producerRole: body.producerRole || "decision-center",
      status: body.status || "owner_assigned",
      definitionDigest: body.definitionDigest || null,
      consumerRefs: body.consumerRefs || [],
      repositoryTarget: body.repositoryTarget || null
    };
    state.sharedDefinitions.push(definition);
    audit(state, "orchestrator", "shared_definition_contract_create", `SharedDefinitionContract:${definition.id}`);
    writeState(state);
    json(res, 201, definition);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/repository-output-targets") {
    const target = {
      id: createId("rot"),
      projectId: body.projectId || "prj_control_plane",
      taskGroupId: body.taskGroupId || "tg_runtime_management",
      workItemId: body.workItemId || "work_unknown",
      repositoryId: body.repositoryId || "repo_control_plane",
      branch: body.branch || "main",
      baseRef: body.baseRef || "HEAD",
      pathAllowlist: body.pathAllowlist || ["docs/**", "spec/**"],
      status: "selected",
      outputPolicy: "project_git_repository_only",
      artifactManifestPath: body.artifactManifestPath || `artifacts/manifest.${Date.now()}.json`
    };
    state.repositoryOutputs ||= [];
    state.repositoryOutputs.push(target);
    audit(state, "repository-router", "repository_output_target_select", `RepositoryOutputTarget:${target.id}`);
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
