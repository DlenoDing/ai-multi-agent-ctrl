#!/usr/bin/env node
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

process.env.AIMAC_STATE_STORE = "runtime_json";
process.env.DATABASE_URL = "";
process.env.AIMAC_PROJECT_EVENT_FSYNC = "false";
process.env.AIMAC_PROJECT_EVENT_TAIL_BYTES = "65536";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeDir = mkdtempSync(join(tmpdir(), "aimac-task-workbench-api-"));
const statePath = join(runtimeDir, "control-plane-state.json");
const seedPath = join(root, "data", "seed-state.json");
const {digestOf} = await import("../apps/control-plane-ui/lib/digest-utils.mjs");
const {writeStoredState} = await import("../apps/control-plane-ui/lib/state-store.mjs");
const {appendProjectExecutionEvent} = await import("../apps/control-plane-ui/lib/project-event-store.mjs");

const systemToken = randomBytes(24).toString("base64url");
const viewerToken = randomBytes(24).toString("base64url");
const foreignToken = randomBytes(24).toString("base64url");
let output = "";
let baseUrl = "";
let server;

function at(index) {
  return new Date(Date.UTC(2026, 8, 5, 12, 0, 0) - index * 1000).toISOString();
}

function session(sessionId, accountId, token) {
  return {
    schemaVersion: "auth-session/v1",
    sessionId,
    accountId,
    tokenDigest: digestOf(`session:${token}`),
    status: "active",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function account(accountId, organizationId) {
  return {
    schemaVersion: "account/v1",
    accountId,
    accountType: "user_account",
    displayName: accountId,
    email: `${accountId}@local`,
    status: "active",
    organizationId,
    roles: [],
    permissions: [],
    authPolicy: {method: "local_password", mfaRequired: false, passwordSet: false, sessionTtlSeconds: 3600},
    createdAt: at(0),
    updatedAt: at(0)
  };
}

function grant(grantId, accountId, resource, permissions) {
  return {
    schemaVersion: "access-control-grant/v1",
    grantId,
    subjectRef: {subjectType: "account", subjectId: accountId},
    resource,
    role: "api_test",
    permissions,
    status: "active",
    policyDecisionRef: `pd_${grantId}`,
    auditRef: `audit_${grantId}`,
    createdAt: at(0),
    updatedAt: at(0)
  };
}

function workItem(id, index, patch = {}) {
  return {
    id,
    title: `Workbench item ${index}`,
    status: index % 3 === 0 ? "blocked_dependency" : "ready",
    ownerRole: index % 2 === 0 ? "implementer" : "reviewer",
    progress: index % 101,
    createdAt: at(index),
    ...(index % 3 === 0 ? {blockedReason: "waiting_dependency"} : {}),
    ...patch
  };
}

function event(dispatchId, workItemId, index, patch = {}) {
  return {
    schemaVersion: "agent-execution-event/v1",
    eventId: `evt_${dispatchId}_${index}`,
    nodeId: "node_api",
    dispatchId,
    projectId: "prj_workbench_api",
    taskGroupId: "tg_workbench_visible",
    workItemId,
    sessionId: `sess_${dispatchId}`,
    runId: `run_${dispatchId}`,
    eventType: "progress",
    progressPercent: index * 10,
    status: "running",
    summary: `event ${index} for ${workItemId}`,
    eventKey: `event-key-${dispatchId}-${index}`,
    payloadDigest: digestOf({dispatchId, workItemId, index}),
    languagePolicyDigest: null,
    createdAt: at(index),
    ...patch
  };
}

function buildState() {
  const state = JSON.parse(readFileSync(seedPath, "utf8"));
  state.stateVersion = Number(state.stateVersion || 1) + 1;
  state.organizations = [
    ...(state.organizations || []),
    {schemaVersion: "organization/v1", orgId: "org_api_a", name: "API Org A", status: "active", quotas: {}, usage: {}, createdAt: at(0), updatedAt: at(0)},
    {schemaVersion: "organization/v1", orgId: "org_api_b", name: "API Org B", status: "active", quotas: {}, usage: {}, createdAt: at(0), updatedAt: at(0)}
  ];
  state.accounts = [
    ...(state.accounts || []),
    account("acct_api_owner", "org_api_a"),
    account("acct_api_viewer", "org_api_a"),
    account("acct_api_foreign", "org_api_b")
  ];
  state.authSessions = [
    ...(state.authSessions || []),
    session("authsess_api_system", "acct_system_owner", systemToken),
    session("authsess_api_viewer", "acct_api_viewer", viewerToken),
    session("authsess_api_foreign", "acct_api_foreign", foreignToken)
  ];
  state.projects = [
    ...(state.projects || []),
    {
      schemaVersion: "project/v1",
      id: "prj_workbench_api",
      organizationId: "org_api_a",
      name: "Task Workbench API",
      status: "active",
      ownerAccountId: "acct_api_owner",
      members: [{accountId: "acct_api_owner", role: "project_owner"}, {accountId: "acct_api_viewer", role: "viewer"}],
      progress: {percent: 0, phase: "development", health: "ok"},
      createdAt: at(0),
      updatedAt: at(0)
    },
    {
      schemaVersion: "project/v1",
      id: "prj_workbench_foreign",
      organizationId: "org_api_b",
      name: "Foreign Project",
      status: "active",
      ownerAccountId: "acct_api_foreign",
      members: [{accountId: "acct_api_foreign", role: "project_owner"}],
      progress: {percent: 0, phase: "development", health: "ok"},
      createdAt: at(0),
      updatedAt: at(0)
    }
  ];
  const visibleItems = [
    workItem("w_tie_a", 0, {title: "Same timestamp A", status: "ready", ownerRole: "implementer", createdAt: "2026-09-05T13:00:00.000Z"}),
    workItem("w_tie_b", 1, {title: "Same timestamp B", status: "ready", ownerRole: "implementer", createdAt: "2026-09-05T13:00:00.000Z"}),
    ...Array.from({length: 319}, (_, index) => workItem(`w_page_${String(index).padStart(3, "0")}`, index + 2)),
    workItem("w_outside_summary", 400, {title: "Ancient retained detail target", status: "ready", ownerRole: "archivist"}),
    workItem("w_no_events", 401, {title: "Quiet filtered work item", status: "ready", ownerRole: "observer"}),
    workItem("w_concurrent_a", 402, {title: "Concurrent event A", status: "ready", ownerRole: "observer"}),
    workItem("w_concurrent_b", 403, {title: "Concurrent event B", status: "ready", ownerRole: "observer"})
  ];
  state.taskGroups = [
    ...(state.taskGroups || []),
    {
      schemaVersion: "task-group/v1",
      id: "tg_workbench_visible",
      projectId: "prj_workbench_api",
      name: "Release Train Visible",
      status: "development",
      phase: "implementation",
      progress: 42,
      health: "ok",
      goalExecutionStatus: "active_paused_by_control",
      pauseReason: "task_group_pause",
      humanGuidance: Array.from({length: 25}, (_, index) => ({text: `guidance-${index + 1}`, addedAt: at(index + 1)})),
      humanGuidanceDroppedCount: 3,
      workItems: visibleItems,
      createdAt: at(0),
      updatedAt: at(0)
    },
    {
      schemaVersion: "task-group/v1",
      id: "tg_workbench_hidden",
      projectId: "prj_workbench_api",
      name: "Hidden Alpha Group",
      status: "development",
      phase: "implementation",
      progress: 3,
      health: "ok",
      workItems: [workItem("w_hidden", 0, {title: "Hidden task", status: "ready"})],
      createdAt: at(0),
      updatedAt: at(0)
    },
    {
      schemaVersion: "task-group/v1",
      id: "tg_workbench_foreign",
      projectId: "prj_workbench_foreign",
      name: "Foreign Group",
      status: "development",
      phase: "implementation",
      progress: 3,
      health: "ok",
      workItems: [workItem("w_foreign", 0, {title: "Foreign task", status: "ready"})],
      createdAt: at(0),
      updatedAt: at(0)
    }
  ];
  state.accessGrants = [
    ...(state.accessGrants || []),
    grant("grant_api_viewer_project", "acct_api_viewer", {resourceType: "project", resourceId: "prj_workbench_api"}, ["project:view"]),
    grant("grant_api_viewer_tg", "acct_api_viewer", {resourceType: "task_group", resourceId: "tg_workbench_visible"}, ["task_group:read", "task_group:control"]),
    grant("grant_api_foreign_project", "acct_api_foreign", {resourceType: "project", resourceId: "prj_workbench_foreign"}, ["project:view"]),
    grant("grant_api_foreign_tg", "acct_api_foreign", {resourceType: "task_group", resourceId: "tg_workbench_foreign"}, ["task_group:read"])
  ];
  state.agentDispatches = [
    ...(state.agentDispatches || []),
    {dispatchId: "dsp_detail", projectId: "prj_workbench_api", taskGroupId: "tg_workbench_visible", workItemId: "w_outside_summary", sessionId: "sess_dsp_detail", runId: "run_dsp_detail", status: "running", createdAt: at(1), updatedAt: at(1)},
    {dispatchId: "dsp_sibling", projectId: "prj_workbench_api", taskGroupId: "tg_workbench_visible", workItemId: "w_page_001", sessionId: "sess_dsp_sibling", runId: "run_dsp_sibling", status: "running", createdAt: at(1), updatedAt: at(1)}
  ];
  state.workSessions = [
    ...(state.workSessions || []),
    {sessionId: "sess_dsp_detail", projectId: "prj_workbench_api", taskGroupId: "tg_workbench_visible", workItemId: "w_outside_summary", status: "active", createdAt: at(1), updatedAt: at(1)},
    {sessionId: "sess_dsp_sibling", projectId: "prj_workbench_api", taskGroupId: "tg_workbench_visible", workItemId: "w_page_001", status: "active", createdAt: at(1), updatedAt: at(1)}
  ];
  state.repositoryOutputs = [
    ...(state.repositoryOutputs || []),
    {targetId: "rot_detail", projectId: "prj_workbench_api", taskGroupId: "tg_workbench_visible", workItemId: "w_outside_summary", status: "selected", createdAt: at(1), updatedAt: at(1)},
    {targetId: "rot_sibling", projectId: "prj_workbench_api", taskGroupId: "tg_workbench_visible", workItemId: "w_page_001", status: "selected", createdAt: at(1), updatedAt: at(1)}
  ];
  state.checkpoints = [
    ...(state.checkpoints || []),
    {checkpointId: "chk_detail", projectId: "prj_workbench_api", taskGroupId: "tg_workbench_visible", workId: "w_outside_summary", sessionId: "sess_dsp_detail", runId: "run_dsp_detail", summary: "detail checkpoint", createdAt: at(1)},
    {checkpointId: "chk_sibling", projectId: "prj_workbench_api", taskGroupId: "tg_workbench_visible", workId: "w_page_001", sessionId: "sess_dsp_sibling", runId: "run_dsp_sibling", summary: "sibling checkpoint", createdAt: at(1)}
  ];
  return state;
}

async function request(path, token, {status = 200} = {}) {
  const result = await fetch(`${baseUrl}${path}`, {
    headers: {authorization: `Bearer ${token}`},
    signal: AbortSignal.timeout(10000)
  });
  const payload = await result.json();
  assert.equal(result.status, status, `GET ${path}: ${JSON.stringify(payload).slice(0, 200)}`);
  return payload;
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (!baseUrl && Date.now() < deadline) {
    baseUrl = /console: (http:\/\/127\.0\.0\.1:\d+)/u.exec(output)?.[1] || "";
    if (server.exitCode !== null) throw new Error(`server exited during startup: ${output}`);
    if (!baseUrl) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.ok(baseUrl, "server did not start");
}

try {
  writeStoredState(buildState(), {root, runtimeDir, statePath, seedPath, buildInitialState: buildState});
  for (const item of [
    event("dsp_detail", "w_outside_summary", 1),
    event("dsp_sibling", "w_page_001", 1),
    event("dsp_detail", "w_outside_summary", 2),
    event("dsp_detail", "w_outside_summary", 3),
    ...Array.from({length: 5}, (_, index) =>
      event(`dsp_hidden_${index}`, "w_hidden", index + 1, {taskGroupId: "tg_workbench_hidden", sessionId: `sess_hidden_${index}`, runId: `run_hidden_${index}`}))
  ]) {
    appendProjectExecutionEvent(runtimeDir, item);
  }
  writeFileSync(join(runtimeDir, "runtime-config.json"), `${JSON.stringify({
    schemaVersion: "runtime-local-config/v1",
    runtimeDir,
    statePath,
    repositoryRoot: root,
    executionProfile: "production",
    host: "127.0.0.1",
    port: 0,
    publicUrl: null,
    databaseUrl: null,
    stateStore: "runtime_json",
    bootstrapTokenHash: digestOf("unused"),
    bootstrapTokenConfigured: true,
    mcpServiceTokenHash: digestOf("unused"),
    localAccountTokenHashes: {},
    updatedAt: new Date().toISOString()
  })}\n`);

  server = spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {cwd: root,
    env: {...process.env, AIMAC_RUNTIME_DIR: runtimeDir, AIMAC_HOST: "127.0.0.1", AIMAC_PORT: "0",
      AIMAC_PUBLIC_URL: "", AIMAC_ORCHESTRATOR_INTERVAL_MS: "0", AIMAC_EXECUTION_PROFILE: "production",
      AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: "", AIMAC_EXIT_WITH_PARENT: "1", AIMAC_PROJECT_EVENT_FSYNC: "false"},
    stdio: ["ignore", "pipe", "pipe"]});
  const exited = new Promise((resolveExit) => server.once("exit", resolveExit));
  server.stdout.on("data", (chunk) => { output += String(chunk); });
  server.stderr.on("data", (chunk) => { output += String(chunk); });
  await waitForServer();

  const firstPage = await request("/api/projects/prj_workbench_api/work-items?limit=50", viewerToken);
  assert.equal(firstPage.projectId, "prj_workbench_api");
  assert.equal(firstPage.workItems.length, 50);
  assert.equal(firstPage.total, 325);
  assert.ok(firstPage.nextCursor);
  assert.equal(firstPage.hasMore, true);
  assert.deepEqual(firstPage.workItems.slice(0, 2).map((item) => item.id), ["w_tie_a", "w_tie_b"]);
  assert.ok(firstPage.workItems.every((item) => item.taskGroupId === "tg_workbench_visible"));
  assert.ok(!firstPage.workItems.some((item) => item.id === "w_hidden"));

  const secondPage = await request(`/api/projects/prj_workbench_api/work-items?limit=50&cursor=${encodeURIComponent(firstPage.nextCursor)}`, viewerToken);
  assert.equal(secondPage.workItems.length, 50);
  assert.notDeepEqual(secondPage.workItems.map((item) => item.id), firstPage.workItems.map((item) => item.id));

  const groupSearch = await request("/api/projects/prj_workbench_api/work-items?q=release%20train&limit=100", viewerToken);
  assert.equal(groupSearch.total, 325);
  const roleSearch = await request("/api/projects/prj_workbench_api/work-items?q=archivist", viewerToken);
  assert.equal(roleSearch.total, 1);
  assert.equal(roleSearch.workItems[0].id, "w_outside_summary");
  const statusSearch = await request("/api/projects/prj_workbench_api/work-items?status=blocked_dependency&limit=100", viewerToken);
  assert.ok(statusSearch.total > 0);
  assert.ok(statusSearch.workItems.every((item) => item.status === "blocked_dependency"));
  await request("/api/projects/prj_workbench_api/work-items?cursor=not-a-cursor", viewerToken, {status: 400});

  const hiddenGroupList = await request("/api/projects/prj_workbench_api/work-items?taskGroupId=tg_workbench_hidden", viewerToken);
  assert.equal(hiddenGroupList.total, 0);
  await request("/api/task-groups/tg_workbench_hidden/work-items/w_hidden", viewerToken, {status: 403});
  await request("/api/projects/prj_workbench_api/work-items", foreignToken, {status: 403});
  await request("/api/task-groups/tg_workbench_visible/work-items/w_outside_summary", foreignToken, {status: 403});

  const detail = await request("/api/task-groups/tg_workbench_visible/work-items/w_outside_summary?eventLimit=2", viewerToken);
  const groupProgress = await request("/api/task-groups/tg_workbench_visible/progress", viewerToken);
  assert.equal(groupProgress.taskGroup.id, "tg_workbench_visible");
  assert.equal(groupProgress.taskGroup.projectId, "prj_workbench_api");
  assert.equal(groupProgress.taskGroup.canControl, true);
  assert.equal(groupProgress.taskGroup.canReview, false);
  assert.equal(groupProgress.taskGroup.workItemCount, 325);
  assert.equal(groupProgress.taskGroup.humanGuidanceTotal, 25);
  assert.equal(groupProgress.taskGroup.humanGuidance.length, 20);
  assert.equal(groupProgress.taskGroup.humanGuidance[0].text, "guidance-6");
  assert.equal(groupProgress.taskGroup.humanGuidanceDroppedCount, 3);
  assert.ok(!("blockers" in groupProgress.taskGroup), "identity summary must not duplicate top-level blocker detail");
  assert.ok(!("workItems" in groupProgress.taskGroup), "identity summary must not duplicate large task payloads");
  await request("/api/task-groups/tg_workbench_visible/progress", foreignToken, {status: 403});
  await request("/api/task-groups/tg_workbench_hidden/progress", viewerToken, {status: 403});
  assert.equal(detail.projectId, "prj_workbench_api");
  assert.equal(detail.taskGroup.id, "tg_workbench_visible");
  assert.equal(detail.taskGroup.goalExecutionStatus, "active_paused_by_control");
  assert.equal(detail.taskGroup.pauseReason, "task_group_pause");
  assert.equal(detail.taskGroup.canControl, true);
  assert.equal(detail.taskGroup.canReview, false);
  assert.equal(detail.workItem.id, "w_outside_summary");
  assert.deepEqual(detail.agentDispatches.map((item) => item.dispatchId), ["dsp_detail"]);
  assert.deepEqual(detail.workSessions.map((item) => item.sessionId), ["sess_dsp_detail"]);
  assert.deepEqual(detail.repositoryOutputs.map((item) => item.targetId), ["rot_detail"]);
  assert.deepEqual(detail.checkpoints.map((item) => item.checkpointId), ["chk_detail"]);
  assert.equal(detail.eventCount, 3);
  assert.equal(detail.events.length, 2);
  assert.deepEqual(detail.events.map((item) => item.sequence), [1, 3]);
  assert.equal(detail.hasMoreEvents, true);
  assert.equal(detail.nextEventCursor, 3);
  assert.ok(detail.events.every((item) => item.workItemId === "w_outside_summary"));

  const laterEvents = await request(`/api/task-groups/tg_workbench_visible/work-items/w_outside_summary?eventLimit=2&afterSequence=${detail.nextEventCursor}`, viewerToken);
  assert.equal(laterEvents.events.length, 1);
  assert.deepEqual(laterEvents.events.map((item) => item.sequence), [4]);
  assert.equal(laterEvents.hasMoreEvents, false);
  assert.equal(laterEvents.nextEventCursor, 9);
  const quiet = await request("/api/task-groups/tg_workbench_visible/work-items/w_no_events?eventLimit=2", viewerToken);
  assert.deepEqual(quiet.events, []);
  assert.equal(quiet.hasMoreEvents, false);
  assert.equal(quiet.nextEventCursor, 9);
  const latestDetail = await request("/api/task-groups/tg_workbench_visible/work-items/w_outside_summary?eventLimit=2&latest=1", viewerToken);
  assert.deepEqual(latestDetail.events.map((item) => item.sequence), [3, 4]);
  assert.equal(latestDetail.hasMoreEvents, false);
  assert.equal(latestDetail.historyTruncated, true);
  assert.equal(latestDetail.nextEventCursor, 9);
  assert.equal(latestDetail.eventCount, 3);
  const projectLatest = await request("/api/projects/prj_workbench_api/execution-events?latest=1&limit=2", viewerToken);
  assert.deepEqual(projectLatest.events.map((item) => item.sequence), [3, 4]);
  assert.equal(projectLatest.total, 4);
  assert.equal(projectLatest.historyTruncated, true);
  assert.equal(projectLatest.nextCursor, 9);
  assert.ok(!projectLatest.events.some((item) => item.taskGroupId === "tg_workbench_hidden"));
  const taskGroupLatest = await request("/api/task-groups/tg_workbench_visible/execution-events?latest=1&limit=2", viewerToken);
  assert.deepEqual(taskGroupLatest.events.map((item) => item.sequence), [3, 4]);
  assert.equal(taskGroupLatest.total, 4);
  assert.equal(taskGroupLatest.historyTruncated, true);
  const dispatchLatest = await request("/api/agent-dispatches/dsp_detail/events?latest=1&limit=2", viewerToken);
  assert.deepEqual(dispatchLatest.events.map((item) => item.sequence), [3, 4]);
  assert.equal(dispatchLatest.total, 3);
  assert.equal(dispatchLatest.historyTruncated, true);
  const sessionLatest = await request("/api/work-sessions/sess_dsp_detail/execution-events?latest=1&limit=2", viewerToken);
  assert.deepEqual(sessionLatest.events.map((item) => item.sequence), [3, 4]);
  assert.equal(sessionLatest.total, 3);
  assert.equal(sessionLatest.historyTruncated, true);

  const concurrentA = request("/api/task-groups/tg_workbench_visible/work-items/w_concurrent_a?afterSequence=4&eventLimit=5&waitMs=250", viewerToken);
  const concurrentB = request("/api/task-groups/tg_workbench_visible/work-items/w_concurrent_b?afterSequence=4&eventLimit=5&waitMs=250", viewerToken);
  setTimeout(() => {
    appendProjectExecutionEvent(runtimeDir, event("dsp_concurrent_a", "w_concurrent_a", 1));
    appendProjectExecutionEvent(runtimeDir, event("dsp_concurrent_b", "w_concurrent_b", 1));
  }, 25);
  const [concurrentAResult, concurrentBResult] = await Promise.all([concurrentA, concurrentB]);
  assert.deepEqual(concurrentAResult.events.map((item) => item.workItemId), ["w_concurrent_a"]);
  assert.deepEqual(concurrentBResult.events.map((item) => item.workItemId), ["w_concurrent_b"]);
  await request("/api/task-groups/tg_workbench_visible/work-items/w_outside_summary?eventLimit=nope", viewerToken, {status: 400});

  for (let index = 0; index < 90; index += 1) appendProjectExecutionEvent(runtimeDir,
    event("dsp_sibling", "w_page_001", index + 100, {summary: "过程事件记录".repeat(80)}));
  const historyFromStart = await request("/api/task-groups/tg_workbench_visible/work-items/w_page_001?afterSequence=0&eventLimit=1", viewerToken);
  assert.equal(historyFromStart.events[0].sequence, 2, "history starting at zero must not skip records outside the tail window");
  assert.equal(historyFromStart.eventCount, 91);
  assert.equal(historyFromStart.eventTotalExact, true);
  const latestTail = await request("/api/task-groups/tg_workbench_visible/work-items/w_page_001?latest=1&eventLimit=1", viewerToken);
  assert.equal(latestTail.events.length, 1);
  assert.equal(latestTail.eventTotalExact, false);
  assert.equal(latestTail.historyTruncated, true);
  appendProjectExecutionEvent(runtimeDir, event("dsp_hidden_new", "w_hidden", 1000, {taskGroupId: "tg_workbench_hidden"}));
  const quietAfterHidden = await request(`/api/projects/prj_workbench_api/execution-events?afterSequence=${latestTail.nextEventCursor}&limit=1`, viewerToken);
  assert.deepEqual(quietAfterHidden.events, []);
  assert.ok(quietAfterHidden.nextCursor > latestTail.nextEventCursor, "quiet authorized scopes must advance their scan position past filtered records");

  console.log("task workbench api check passed");
  if (server.exitCode === null) server.kill("SIGTERM");
  const killTimer = setTimeout(() => server.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(killTimer);
} catch (error) {
  console.error(`task workbench api check failed: ${error.stack || error.message}`);
  if (server && server.exitCode === null) server.kill("SIGTERM");
  process.exitCode = 1;
} finally {
  rmSync(runtimeDir, {recursive: true, force: true});
}
