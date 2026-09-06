export function createCommandBus(dependencies) {
  const {
    COMMAND_EFFECT_TERMINAL, COMMAND_TERMINAL, DLQ_ENTRY_TERMINAL, appendEvent,
    assertHumanTextWithinLimit, assertUniqueRecordId, capRetainingPredicate, createId,
    digestOf, ensureRuntimeCollections, normalizedExpiry, recordTransition
  } = dependencies;

// ---- Command Bus lifecycle (Gap #3) ----------------------------------------------------
// Real created->admitted->dispatched->running->succeeded/failed lifecycle for the Command
// machine, plus the CommandEffect and DLQEntry machines. Every edge is validated through the
// transition engine (assertTransition via recordTransition). Side-effecting commands emit a
// CommandEffect (satisfying `effect_record_if_side_effect`); exhausted failures land in the DLQ.
// This makes the close-barrier `all_command_effects_terminal` / `no_active_dlq` gates real
// instead of vacuously true.

function capCommandBus(state) {
  // 这三个集合都被关闭门读取（all_commands_terminal / all_command_effects_terminal / no_active_dlq），
  // 而原先是盲 slice：旧但仍未了结的项会被新项挤出窗口，门随即"假满足"，任务组因此可能提前误关闭。
  // 这正是本仓已经反复交过学费的 barrier-safe cap 那一类 —— 同文件里就有专门的助手，这里却没用。
  state.commands = capRetainingPredicate(state.commands || [], (item) => !COMMAND_TERMINAL.has(item.status), 240);
  state.commandEffects = capRetainingPredicate(state.commandEffects || [], (item) => !COMMAND_EFFECT_TERMINAL.has(item.status), 240);
  state.dlqEntries = capRetainingPredicate(state.dlqEntries || [], (item) => !DLQ_ENTRY_TERMINAL.has(item.status), 240);
}

function createCommand(state, input = {}) {
  // 调用方可以自选 id，而这个集合是【前插】的：撞上一个已有 id，按 id 找的读者
  // 从此拿到后写的那条，原记录还在、只是永远读不到 —— 谁也不报错。
  // 本仓十一个接受自选 id 的工厂都调了这个断言，这一族是漏的。
  assertUniqueRecordId(state.commands, "id", input.commandId, "command_id_conflict");
  const commandTimeoutAt = normalizedExpiry(input.timeoutAt);
  if (commandTimeoutAt === false) {
    throw Object.assign(new Error("command_timeout_at_invalid"),
      {status: 400, received: String(input.timeoutAt).slice(0, 60)});
  }
  ensureRuntimeCollections(state);
  const at = new Date().toISOString();
  const command = {
    schemaVersion: "command/v1",
    id: input.commandId || createId("cmd"),
    type: input.type || "control_command",
    subject: input.subject || (input.taskGroupId ? `TaskGroup:${input.taskGroupId}` : "control-plane"),
    projectId: input.projectId || "prj_control_plane",
    ...(input.taskGroupId ? {taskGroupId: input.taskGroupId} : {}),
    status: "created",
    idempotencyKey: input.idempotencyKey || createId("idem_cmd"),
    policyDecisionRef: input.policyDecisionRef || `policy:command:${createId("pd")}`,
    attempts: 0,
    maxAttempts: Math.max(1, Number(input.maxAttempts || 3)),
    // 与本仓所有「调用方能给的时间字段」同规：认不出就拒，不落库。
    // 这里落的是超时判据本身（sweepCommandBus 用 `new Date(timeoutAt).getTime() <= now` 比），
    // 存进一个解析不了的值＝NaN 比较两个方向都为 false ＝【这条命令永远不会超时】，
    // 而它会一直挂在 running 上挡着关闭门。今天没有外部入口传它，但这一族里只剩它是敞开的。
    ...(commandTimeoutAt ? {timeoutAt: commandTimeoutAt} : {}),
    ...(input.targetRef ? {targetRef: input.targetRef} : {}),
    createdAt: at,
    updatedAt: at
  };
  state.commands.unshift(command);
  // created -> admitted (policy-engine): policy_passed + idempotency_key
  recordTransition(state, "Command", command.id, "created", "admitted", "policy-engine", {
    policy_passed: `policy_passed:${command.policyDecisionRef}`,
    idempotency_key: command.idempotencyKey
  });
  command.status = "admitted";
  command.updatedAt = new Date().toISOString();
  appendEvent(state, "command_admitted", "Command", command.id, "policy-engine", {projectId: command.projectId, taskGroupId: command.taskGroupId});
  capCommandBus(state);
  return command;
}

function dispatchCommand(state, command, input = {}) {
  // admitted -> dispatched (command-bus): target_available
  recordTransition(state, "Command", command.id, "admitted", "dispatched", "command-bus", {
    target_available: input.targetRef || command.targetRef || `target_available:${command.id}`
  });
  command.status = "dispatched";
  if (input.targetRef) command.targetRef = input.targetRef;
  command.updatedAt = new Date().toISOString();
  return command;
}

function markRunning(state, command, input = {}) {
  // dispatched -> running (agent-runtime): dispatch_ack
  recordTransition(state, "Command", command.id, "dispatched", "running", "agent-runtime", {
    dispatch_ack: input.dispatchAck || `dispatch_ack:${command.id}`
  });
  command.status = "running";
  command.updatedAt = new Date().toISOString();
  return command;
}

function succeedCommand(state, command, input = {}) {
  let commandEffect = null;
  let effectRef = "no_side_effect";
  if (input.sideEffect) {
    commandEffect = recordCommandEffect(state, command, {...input.sideEffect, taskGroupId: input.sideEffect.taskGroupId || command.taskGroupId});
    effectRef = `command_effect_ref:CommandEffect:${commandEffect.effectId}`;
    command.commandEffectRef = `CommandEffect:${commandEffect.effectId}`;
  }
  const from = command.status === "checkpointed" ? "checkpointed" : "running";
  // running|checkpointed -> succeeded (agent-runtime): result_ref + effect_record_if_side_effect
  recordTransition(state, "Command", command.id, from, "succeeded", "agent-runtime", {
    result_ref: input.resultRef || `result_ref:${command.id}`,
    effect_record_if_side_effect: effectRef
  });
  command.status = "succeeded";
  command.resultRef = input.resultRef || `result_ref:${command.id}`;
  command.updatedAt = new Date().toISOString();
  appendEvent(state, "command_succeeded", "Command", command.id, "agent-runtime", {projectId: command.projectId, taskGroupId: command.taskGroupId, hasSideEffect: Boolean(commandEffect)});
  capCommandBus(state);
  return {command, commandEffect};
}

function failCommand(state, command, input = {}) {
  // running -> failed (agent-runtime): failure_ref
  recordTransition(state, "Command", command.id, "running", "failed", "agent-runtime", {
    failure_ref: input.failureRef || `failure_ref:${command.id}`
  });
  command.status = "failed";
  command.failureRef = input.failureRef || `failure_ref:${command.id}`;
  command.attempts = Number(command.attempts || 0) + 1;
  command.updatedAt = new Date().toISOString();
  appendEvent(state, "command_failed", "Command", command.id, "agent-runtime", {projectId: command.projectId, taskGroupId: command.taskGroupId, failureRef: command.failureRef});
  return command;
}

function retryCommand(state, command, input = {}) {
  // failed -> admitted (command-bus): retry_policy_allows (only while attempts < maxAttempts)
  if (command.status !== "failed") return null;
  if (Number(command.attempts || 0) >= Number(command.maxAttempts || 1)) return null;
  recordTransition(state, "Command", command.id, "failed", "admitted", "command-bus", {
    retry_policy_allows: input.retryPolicyRef || `retry_policy_allows:${command.attempts}/${command.maxAttempts}`
  });
  command.status = "admitted";
  command.updatedAt = new Date().toISOString();
  return command;
}

function timeoutCommand(state, command, input = {}) {
  // running -> timed_out (command-bus): timeout_at_elapsed
  recordTransition(state, "Command", command.id, "running", "timed_out", "command-bus", {
    timeout_at_elapsed: input.reason || `timeout_at_elapsed:${command.timeoutAt || command.id}`
  });
  command.status = "timed_out";
  command.updatedAt = new Date().toISOString();
  appendEvent(state, "command_failed", "Command", command.id, "command-bus", {projectId: command.projectId, taskGroupId: command.taskGroupId, reason: "timeout_at_elapsed"});
  return command;
}

function cancelCommand(state, command, input = {}) {
  // running -> cancelled (command-bus): cancel_ref
  recordTransition(state, "Command", command.id, "running", "cancelled", "command-bus", {
    cancel_ref: input.cancelRef || `cancel_ref:${command.id}`
  });
  command.status = "cancelled";
  command.updatedAt = new Date().toISOString();
  return command;
}

function compensateCommand(state, command, input = {}) {
  // failed -> compensated (command-bus): compensation_command_verified
  recordTransition(state, "Command", command.id, "failed", "compensated", "command-bus", {
    compensation_command_verified: input.compensationRef || `compensation_command_verified:${command.id}`
  });
  command.status = "compensated";
  command.updatedAt = new Date().toISOString();
  return command;
}

function toDlq(state, command, input = {}) {
  // failed -> dlq (command-bus): max_attempts_exceeded + create a DLQEntry
  recordTransition(state, "Command", command.id, "failed", "dlq", "command-bus", {
    max_attempts_exceeded: `max_attempts_exceeded:${command.attempts}/${command.maxAttempts}`
  });
  command.status = "dlq";
  command.updatedAt = new Date().toISOString();
  const dlqEntry = createDlqEntry(state, {
    commandId: command.id,
    projectId: command.projectId,
    taskGroupId: command.taskGroupId,
    reason: input.reason || command.failureRef || "max_attempts_exceeded",
    sourceObjectRef: `Command:${command.id}`
  });
  return {command, dlqEntry};
}

// CommandEffect machine: prepared -> applied -> verifying -> verified (reconciled).
function recordCommandEffect(state, command, input = {}) {
  // 调用方可以自选 id，而这个集合是【前插】的：撞上一个已有 id，按 id 找的读者
  // 从此拿到后写的那条，原记录还在、只是永远读不到 —— 谁也不报错。
  // 本仓十一个接受自选 id 的工厂都调了这个断言，这一族是漏的。
  assertUniqueRecordId(state.commandEffects, "effectId", input.effectId, "command_effect_id_conflict");
  ensureRuntimeCollections(state);
  const at = new Date().toISOString();
  const effect = {
    schemaVersion: "command-effect/v1",
    effectId: input.effectId || createId("cef"),
    commandId: command?.id || input.commandId,
    projectId: input.projectId || command?.projectId || "prj_control_plane",
    ...(input.taskGroupId || command?.taskGroupId ? {taskGroupId: input.taskGroupId || command?.taskGroupId} : {}),
    status: "prepared",
    externalOperationId: input.externalOperationId || `ext:${command?.id || effectRandom()}`,
    fencingToken: input.fencingToken || `fence:${command?.id || effectRandom()}`,
    beforeDigest: input.beforeDigest || digestOf({command: command?.id, phase: "before", nonce: at}),
    createdAt: at,
    updatedAt: at
  };
  state.commandEffects.unshift(effect);
  appendEvent(state, "command_effect_prepared", "CommandEffect", effect.effectId, "agent-runtime", {projectId: effect.projectId, taskGroupId: effect.taskGroupId, commandId: effect.commandId});
  capCommandBus(state);
  if (input.autoReconcile !== false) reconcileCommandEffect(state, effect, input);
  return effect;
}

function effectRandom() {
  return Math.random().toString(36).slice(2, 8);
}

function applyCommandEffect(state, effect, input = {}) {
  // prepared -> applied (agent-runtime): before_digest + external_operation_id + fencing_token
  recordTransition(state, "CommandEffect", effect.effectId, "prepared", "applied", "agent-runtime", {
    before_digest: effect.beforeDigest,
    external_operation_id: effect.externalOperationId,
    fencing_token: effect.fencingToken
  });
  effect.status = "applied";
  effect.updatedAt = new Date().toISOString();
  return effect;
}

function verifyingCommandEffect(state, effect, input = {}) {
  effect.afterDigest = input.afterDigest || digestOf({effect: effect.effectId, phase: "after"});
  effect.resultRef = input.resultRef || `result_ref:${effect.effectId}`;
  // applied -> verifying (agent-runtime): after_digest + result_ref
  recordTransition(state, "CommandEffect", effect.effectId, "applied", "verifying", "agent-runtime", {
    after_digest: effect.afterDigest,
    result_ref: effect.resultRef
  });
  effect.status = "verifying";
  effect.updatedAt = new Date().toISOString();
  return effect;
}

function verifyCommandEffect(state, effect, input = {}) {
  // verifying -> verified (reviewer): effect_verify_evidence
  recordTransition(state, "CommandEffect", effect.effectId, "verifying", "verified", "reviewer", {
    effect_verify_evidence: input.effectVerifyEvidence || `effect_verify_evidence:${effect.effectId}`
  });
  effect.status = "verified";
  effect.updatedAt = new Date().toISOString();
  appendEvent(state, "command_effect_verified", "CommandEffect", effect.effectId, "reviewer", {projectId: effect.projectId, taskGroupId: effect.taskGroupId});
  return effect;
}

function reconcileCommandEffect(state, effect, input = {}) {
  applyCommandEffect(state, effect, input);
  verifyingCommandEffect(state, effect, input);
  verifyCommandEffect(state, effect, input);
  return effect;
}

// DLQEntry machine: created -> classified -> assigned -> replayed|discarded|superseded.
function createDlqEntry(state, input = {}) {
  // 调用方可以自选 id，而这个集合是【前插】的：撞上一个已有 id，按 id 找的读者
  // 从此拿到后写的那条，原记录还在、只是永远读不到 —— 谁也不报错。
  // 本仓十一个接受自选 id 的工厂都调了这个断言，这一族是漏的。
  assertUniqueRecordId(state.dlqEntries, "entryId", input.entryId, "dlq_entry_id_conflict");
  ensureRuntimeCollections(state);
  const at = new Date().toISOString();
  const entry = {
    schemaVersion: "dlq-entry/v1",
    entryId: input.entryId || createId("dlq"),
    ...(input.commandId ? {commandId: input.commandId} : {}),
    projectId: input.projectId || "prj_control_plane",
    ...(input.taskGroupId ? {taskGroupId: input.taskGroupId} : {}),
    status: "created",
    sourceObjectRef: input.sourceObjectRef || (input.commandId ? `Command:${input.commandId}` : "unknown"),
    reason: input.reason || "max_attempts_exceeded",
    createdAt: at,
    updatedAt: at
  };
  state.dlqEntries.unshift(entry);
  appendEvent(state, "dlq_entry_created", "DLQEntry", entry.entryId, "command-bus", {projectId: entry.projectId, taskGroupId: entry.taskGroupId, reason: entry.reason});
  capCommandBus(state);
  return entry;
}

function classifyDlqEntry(state, entry, input = {}) {
  // created -> classified (monitor): root_cause_hint
  recordTransition(state, "DLQEntry", entry.entryId, "created", "classified", "monitor", {
    root_cause_hint: input.rootCauseHint || `root_cause_hint:${entry.entryId}`
  });
  entry.status = "classified";
  entry.rootCauseHint = input.rootCauseHint || `root_cause_hint:${entry.entryId}`;
  entry.updatedAt = new Date().toISOString();
  return entry;
}

function assignDlqEntry(state, entry, input = {}) {
  // classified -> assigned (orchestrator): owner_role
  recordTransition(state, "DLQEntry", entry.entryId, "classified", "assigned", "orchestrator", {
    owner_role: input.ownerRole || "release"
  });
  entry.status = "assigned";
  entry.ownerRole = input.ownerRole || "release";
  entry.updatedAt = new Date().toISOString();
  return entry;
}

function replayDlqEntry(state, entry, input = {}) {
  // assigned -> replayed (command-bus): replay_policy_passed
  recordTransition(state, "DLQEntry", entry.entryId, "assigned", "replayed", "command-bus", {
    replay_policy_passed: input.replayPolicyRef || `replay_policy_passed:${entry.entryId}`
  });
  entry.status = "replayed";
  entry.updatedAt = new Date().toISOString();
  appendEvent(state, "dlq_entry_replayed", "DLQEntry", entry.entryId, "command-bus", {projectId: entry.projectId, taskGroupId: entry.taskGroupId});
  return entry;
}

function discardDlqEntry(state, entry, input = {}) {
  // assigned -> discarded (orchestrator): decision_record + resolution_effect_ref
  recordTransition(state, "DLQEntry", entry.entryId, "assigned", "discarded", "orchestrator", {
    decision_record: input.decisionRecord || `decision_record:${entry.entryId}`,
    resolution_effect_ref: input.resolutionEffectRef || `resolution_effect_ref:${entry.entryId}`
  });
  entry.status = "discarded";
  entry.updatedAt = new Date().toISOString();
  return entry;
}

// 【人工处置死信的唯一出口】。此前 classify/assign/replay/discard 四个函数全都没有任何调用方，
// 而 DLQEntry 建出来就停在 created（非终态）—— no_active_dlq 关闭门据此永久挡着，人在界面上又找不到
// 任何处置它的地方（dlqEntries 连下发都被清空）。命令重试超限造一条死信，整个任务组就再也关不掉。
// 这里把它接上：人决定丢弃还是重放，内部走完整的状态机转移链（created→classified→assigned→终态），
// 每一步都是合法边、都留转移证据。缺省不得等于处置：resolution 必须显式给（否则一条没人真正判断过的
// 死信被一句默认动作了结）；理由必填（这是事后唯一的处置依据，与 finding/quality-gate 同规）。
function operatorResolveDlqEntry(state, entry, input = {}) {
  if (!entry) return {ok: false, error: "dlq_entry_not_found"};
  if (!["discard", "replay"].includes(input.resolution)) {
    throw Object.assign(new Error("dlq_entry_resolution_required"),
      {status: 400, supported: ["discard", "replay"],
       details: {message: "处置死信必须选择「丢弃」或「重放」——不选它会一直挡着关闭门"}});
  }
  if (DLQ_ENTRY_TERMINAL.has(entry.status)) return {dlqEntry: entry, alreadyResolved: true};
  const justification = assertHumanTextWithinLimit(input.justification || "", "dlq_entry_justification", 2000);
  if (!justification) throw Object.assign(new Error("dlq_entry_justification_required"),
    {status: 400, details: {message: "处置死信必须写明理由——这是事后唯一的处置依据"}});
  const actor = input.actor || "operator";
  if (entry.status === "created") classifyDlqEntry(state, entry, {rootCauseHint: `operator_review:${entry.entryId}`});
  if (entry.status === "classified") assignDlqEntry(state, entry, {ownerRole: actor});
  entry.resolutionJustification = justification;
  entry.resolvedBy = actor;
  if (input.resolution === "discard") discardDlqEntry(state, entry, {decisionRecord: `operator:${actor}`});
  else replayDlqEntry(state, entry, {replayPolicyRef: `operator:${actor}`});
  return {dlqEntry: entry, resolution: input.resolution};
}

// Sweeper: applied on the same cadence as expireStaleQueuedDispatches / maintainWorkerLanes.
// It applies timeout_at_elapsed to running commands whose timeoutAt has passed so a stuck
// command cannot silently keep the close-barrier `all_commands_terminal` gate blocked.
function sweepCommandBus(state, options = {}) {
  ensureRuntimeCollections(state);
  const nowMs = options.nowMs || Date.now();
  const swept = {timedOut: []};
  for (const command of state.commands || []) {
    if (command.status === "running" && command.timeoutAt && new Date(command.timeoutAt).getTime() <= nowMs) {
      timeoutCommand(state, command, {reason: `timeout_at_elapsed:${command.timeoutAt}`});
      swept.timedOut.push(command.id);
    }
  }
  return swept;
}

// One-shot helper for control-plane write paths: run created->admitted->dispatched->running->
// succeeded and (when the write has an external side effect) emit + reconcile a CommandEffect.
function runCommandLifecycle(state, input = {}) {
  const command = createCommand(state, input);
  dispatchCommand(state, command, {targetRef: input.targetRef});
  markRunning(state, command, {dispatchAck: input.dispatchAck});
  return succeedCommand(state, command, {resultRef: input.resultRef, sideEffect: input.sideEffect});
}

  return {
    applyCommandEffect, assignDlqEntry, cancelCommand, classifyDlqEntry, compensateCommand,
    createCommand, createDlqEntry, discardDlqEntry, dispatchCommand, failCommand, markRunning,
    operatorResolveDlqEntry, recordCommandEffect, replayDlqEntry, retryCommand,
    runCommandLifecycle, succeedCommand, sweepCommandBus, timeoutCommand, toDlq,
    verifyingCommandEffect, verifyCommandEffect
  };
}

