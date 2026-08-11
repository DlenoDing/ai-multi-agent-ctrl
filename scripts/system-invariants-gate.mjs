// 不再逐条猜"哪里可能坏"，而是让系统跑一段真实序列，每一步之后检查一组全局不变式。
// 目的是撞出没人想到过的组合，而不是复验已知的那些。
import {readFileSync, mkdtempSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";

import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.AIMAC_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "aimac-inv-"));
const core = await import(root + "/apps/control-plane-ui/lib/control-plane-core.mjs");
const gw = await import(root + "/apps/control-plane-ui/lib/agent-gateway.mjs");

const TERMINAL_DISPATCH = new Set(["completed", "failed", "cancelled"]);
const SETTLED_SESSION = new Set(["completed_objective", "recycled", "failed", "aborted"]);

// 每条不变式都要说清"坏了会怎样"，否则报出来也不知道严不严重。
const INVARIANTS = [
  {
    name: "终态派发不得还挂在节点的活跃集里",
    why: "节点吊销/下线的收尾会把活跃集里的派发重新入队 —— 终态的被复活，等于重复执行",
    check: (state) => (state.agentRuntimeNodes || []).flatMap((node) =>
      (node.activeDispatchIds || []).filter((id) => {
        const dispatch = (state.agentDispatches || []).find((item) => item.dispatchId === id);
        return dispatch && TERMINAL_DISPATCH.has(dispatch.status);
      }).map((id) => `${node.nodeId} 仍持有终态派发 ${id}`))
  },
  {
    name: "同一个资源同一时刻只能有一份活跃租约",
    why: "写锁失效：两个会话会同时往同一个写入目标提交",
    check: (state) => {
      const byResource = new Map();
      for (const lease of state.leases || []) {
        if (lease.status !== "active") continue;
        const seen = byResource.get(lease.resourceRef);
        if (seen) return [`${lease.resourceRef} 上有两份活跃租约：${seen} 与 ${lease.leaseId}`];
        byResource.set(lease.resourceRef, lease.leaseId);
      }
      return [];
    }
  },
  {
    name: "阻塞中的派发必须写明原因",
    why: "监控页只显示一列原因；空原因＝人看到一个卡住的东西却不知道卡在哪",
    check: (state) => (state.agentDispatches || [])
      .filter((item) => item.status === "blocked" && !item.blockedReason)
      .map((item) => `${item.dispatchId} 阻塞但没有原因`)
  },
  {
    name: "活跃会话必须指向存在的工作项",
    why: "指向不存在的工作项的会话永远了结不了，会一直挡着关闭门",
    check: (state) => (state.workSessions || [])
      .filter((session) => !SETTLED_SESSION.has(session.status))
      .filter((session) => {
        const taskGroup = (state.taskGroups || []).find((item) => item.id === session.taskGroupId);
        return !taskGroup || !(taskGroup.workItems || []).some((item) => item.id === session.workItemId);
      })
      .map((session) => `${session.sessionId} 指向不存在的工作项 ${session.taskGroupId}/${session.workItemId}`)
  },
  {
    name: "每个非终态派发都要有对得上的契约",
    why: "acceptAgentCheckpoint 按 sessionId+runId 找契约，找不到就永远报 contract_mismatch，派发再也终结不了",
    check: (state) => (state.agentDispatches || [])
      .filter((item) => !TERMINAL_DISPATCH.has(item.status))
      .filter((item) => !(state.agentTaskContracts || []).some((contract) =>
        contract.sessionId === item.sessionId && contract.runId === item.runId))
      .map((item) => `${item.dispatchId}（${item.status}）没有对应契约`)
  },
  {
    name: "工作项不得既已验收又被阻塞",
    why: "两种口径同时成立时，界面与关闭门会给出互相矛盾的结论",
    check: (state) => (state.taskGroups || []).flatMap((taskGroup) =>
      (taskGroup.workItems || [])
        .filter((item) => ["verified", "closed"].includes(item.status) && item.blockedReason)
        .map((item) => `${taskGroup.id}/${item.id} 状态 ${item.status} 却带着阻塞原因 ${item.blockedReason}`))
  },
  {
    name: "关闭门列出的阻塞对象必须真实存在",
    why: "指向已被裁剪掉的对象时，人按提示去处置会扑空，而门永远满足不了",
    check: (state) => {
      // 存在性必须在【关闭门之外】的地方找。第一版拿整份 state 做 includes ——
      // 而阻塞项自己就在 state 里，于是这条判据恒为真（自证一注入破坏就抓到了）。
      const {closeBarriers, ...rest} = state;
      const haystack = JSON.stringify(rest);
      const problems = [];
      for (const barrier of closeBarriers || []) {
        for (const blocker of barrier.blockingObjects || []) {
          const id = String(blocker.objectId || "");
          if (!id) continue;
          if (!haystack.includes(id)) problems.push(`${barrier.taskGroupId} 的阻塞项 ${blocker.objectType}:${id} 已不存在`);
        }
      }
      return problems;
    }
  }
];

const state = JSON.parse(readFileSync(join(root, "data/seed-state.json"), "utf8"));
core.ensureRuntimeCollections(state, {root});
const taskGroup = state.taskGroups.find((item) => item.id === "tg_runtime_management");
taskGroup.workItems = Array.from({length: 12}, (_, index) => ({
  id: `w_inv_${index}`, title: `单元${index}`, status: "draft", ownerRole: "agent-runtime", progress: 0}));

const nodes = [];
for (const name of ["inv-node-a", "inv-node-b"]) {
  const issued = gw.createAgentJoinToken(state, {projectId: taskGroup.projectId, nodeName: name, allowedRoles: ["*"]},
    {publicUrl: "https://control.example.test"});
  gw.registerAgentNode(state, {nodeName: name, requestedRoles: ["*"], runtimeVersion: "probe",
    profile: {platform: "test", arch: "test", tools: [], models: [{providerClass: "custom", available: true}]}},
    {joinToken: issued.joinToken, publicUrl: "https://control.example.test"});
  const node = state.agentRuntimeNodes.find((item) => item.nodeName === name);
  gw.selfCheckAgentNode(state, node, {checks: ["runtime", "gateway", "filesystem", "git", "remote_mcp", "model_executor"]
    .map((checkId) => ({checkId, status: "ok"}))});
  nodes.push(node);
}

const violations = [];
const checkAll = (step) => {
  for (const invariant of INVARIANTS) {
    let found = [];
    try { found = invariant.check(state) || []; } catch (error) { found = [`检查自身抛错：${error.message}`]; }
    for (const detail of found.slice(0, 3)) {
      const key = `${invariant.name}｜${detail}`;
      if (violations.some((item) => item.key === key)) continue;
      violations.push({key, step, name: invariant.name, why: invariant.why, detail});
    }
  }
};

// 一段有代表性的真实序列：编排 → 认领 → 进度 → 一部分失败、一部分暂停、一部分节点吊销。
let step = 0;
const advance = (label, fn) => { step += 1; try { fn(); } catch (error) { /* 被判据拒绝是正常的 */ } checkAll(`${step}:${label}`); };

for (let round = 0; round < 6; round += 1) {
  advance(`编排#${round}`, () => core.runAutonomousCycle(state, {root, mode: "all", autoSyncSkills: false}));
  for (const node of nodes) {
    advance(`认领#${round}:${node.nodeName}`, () => {
      const claimed = gw.claimNextDispatch(state, node, {});
      const dispatch = claimed.dispatch?.dispatch;
      if (!dispatch) return;
      gw.submitAgentExecutionEvent(state, node, {dispatchId: dispatch.dispatchId, eventType: "progress",
        eventKey: `inv-${round}-${node.nodeId}`, payload: {progressPercent: 40}});
    });
  }
  const running = (state.agentDispatches || []).filter((item) => item.status === "running");
  if (running[0]) {
    advance(`报失败#${round}`, () => {
      const node = nodes.find((item) => item.nodeId === running[0].assignedNodeId) || nodes[0];
      gw.reportAgentDispatchFailure?.(state, node, running[0].dispatchId, {reason: "probe"})
        ?? gw.finishNodeDispatch?.(state, node, running[0].dispatchId, false);
    });
  }
  if (running[1]) {
    advance(`暂停#${round}`, () => {
      const node = nodes.find((item) => item.nodeId === running[1].assignedNodeId) || nodes[0];
      gw.createAgentControlCommand(state, node, {commandType: "pause_dispatch", dispatchId: running[1].dispatchId},
        {actor: "acct_workspace_owner", idempotencyKey: `inv-pause-${round}`});
    });
  }
  if (round === 3) {
    advance("吊销节点B", () => {
      const revoke = gw.requestAgentNodeRevocation(state, nodes[1], {}, {actor: "acct_workspace_owner", idempotencyKey: "inv-revoke"});
      gw.ackAgentControlCommand(state, nodes[1], revoke.command.commandId, {status: "completed", result: {stopped: true}});
    });
  }
}

// 自证：逐条往最终状态里注入一处对应的破坏，那一条必须报出来。
// "没发现违反"只有在检查器本身能发现违反时才有意义。
const corruptions = [
  ["终态派发不得还挂在节点的活跃集里", (s) => {
    const dispatch = (s.agentDispatches || []).find((item) => TERMINAL_DISPATCH.has(item.status)) || (s.agentDispatches || [])[0];
    dispatch.status = "completed";
    s.agentRuntimeNodes[0].activeDispatchIds = [...(s.agentRuntimeNodes[0].activeDispatchIds || []), dispatch.dispatchId];
  }],
  ["同一个资源同一时刻只能有一份活跃租约", (s) => {
    const lease = (s.leases || []).find((item) => item.status === "active");
    s.leases.push({...lease, leaseId: `${lease.leaseId}_dup`});
  }],
  ["阻塞中的派发必须写明原因", (s) => {
    const dispatch = (s.agentDispatches || [])[0];
    dispatch.status = "blocked"; delete dispatch.blockedReason;
  }],
  ["活跃会话必须指向存在的工作项", (s) => {
    const session = (s.workSessions || []).find((item) => !SETTLED_SESSION.has(item.status)) || s.workSessions[0];
    session.status = "active"; session.workItemId = "w_不存在";
  }],
  ["每个非终态派发都要有对得上的契约", (s) => {
    const dispatch = (s.agentDispatches || []).find((item) => !TERMINAL_DISPATCH.has(item.status)) || s.agentDispatches[0];
    dispatch.status = "queued"; dispatch.runId = "run_不存在";
  }],
  ["工作项不得既已验收又被阻塞", (s) => {
    const group = s.taskGroups.find((item) => (item.workItems || []).length);
    group.workItems[0].status = "verified"; group.workItems[0].blockedReason = "credential_required";
  }],
  ["关闭门列出的阻塞对象必须真实存在", (s) => {
    s.closeBarriers = [...(s.closeBarriers || []), {taskGroupId: taskGroup.id, satisfied: false,
      blockingObjects: [{objectType: "WorkItem", objectId: "obj_绝不存在_zzz"}]}];
  }]
];
const selfTestFailures = [];
for (const [name, corrupt] of corruptions) {
  const copy = structuredClone(state);
  try { corrupt(copy); } catch (error) { selfTestFailures.push(`${name}: 注入破坏时抛错 ${error.message}`); continue; }
  const invariant = INVARIANTS.find((item) => item.name === name);
  const found = invariant.check(copy) || [];
  if (!found.length) selfTestFailures.push(`${name}: 注入了对应破坏，这条不变式却没有报出来 —— 它在空转`);
}
console.log(`自证：${corruptions.length} 条注入破坏，${selfTestFailures.length ? "有漏网" : "逐条都被检出"}`);
for (const failure of selfTestFailures) console.log(`  ${failure}`);

console.log(`system invariants gate: 跑了 ${step} 步真实序列，检查了 ${INVARIANTS.length} 条不变式`);
if (selfTestFailures.length) process.exit(1);
if (!violations.length) { console.log("system invariants gate ok: 真实序列里没有违反，且每条不变式都能检出对应的注入破坏"); process.exit(0); }
console.log(`system invariants gate failed: 发现 ${violations.length} 处违反：`);
for (const violation of violations) {
  console.log(`  [${violation.step}] ${violation.name}`);
  console.log(`      ${violation.detail}`);
  console.log(`      后果：${violation.why}`);
}
process.exit(1);
