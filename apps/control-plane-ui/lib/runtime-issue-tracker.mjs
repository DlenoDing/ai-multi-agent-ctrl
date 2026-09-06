export function createRuntimeIssueTracker(dependencies) {
  const {appendEvent, capCentralCollection, capRetainingPredicate, createId, digestOf, ensureRuntimeCollections, unique} = dependencies;

function settleRuntimeIssuePatternForCandidate(state, candidate, candidateStatus) {
  const disposition = {dismissed: "suppressed", closed: "closed"}[candidateStatus];
  if (!disposition || !candidate) return null;
  const pattern = (state.runtimeIssuePatterns || []).find((item) =>
    item.patternId === candidate.issuePatternId || item.candidateRef === candidate.candidateId);
  if (!pattern || ["suppressed", "closed"].includes(pattern.status)) return null;
  pattern.status = disposition;
  pattern.settledBy = candidate.resolvedBy;
  pattern.settledReason = `system_upgrade_candidate_${candidateStatus}`;
  pattern.updatedAt = new Date().toISOString();
  appendEvent(state, "decision", "RuntimeIssuePattern", pattern.patternId, "monitor",
    {status: disposition, candidateId: candidate.candidateId});
  return pattern;
}

function collectRuntimeIssue(state, request = {}) {
  ensureRuntimeCollections(state);
  const at = new Date().toISOString();
  const fingerprint = request.issueFingerprint || digestOf({issueClass: request.issueClass, summary: request.summary}).slice(7, 23);
  // 指纹是【内容】算出来的，天然会在不同租户之间撞上。按它查找时必须连归属一起比，
  // 否则别的租户报一个相同的指纹就会被并进这条记录里：计数被改、样本被塞进来，
  // 回执还把这条记录的内容原样带回去（HTTP 探针实测过）。
  const sameOwner = (item) => (item.taskGroupId || null) === (request.taskGroupId || null);
  const matchingSamples = state.runtimeIssueSamples
    .filter((sample) => sample.issueFingerprint === fingerprint && sameOwner(sample));
  // 人已经判过"这个不用管"的模式，不该再被同一件事顶起来：静默计数，不重开、不再升级。
  // （复活一个终态是另一类缺陷 —— 终态之所以是终态，就是因为人已经在它上面做过决定。）
  const suppressed = state.runtimeIssuePatterns.find((item) =>
    item.issueFingerprint === fingerprint && item.status === "suppressed" && sameOwner(item));
  if (suppressed) {
    suppressed.suppressedOccurrences = Number(suppressed.suppressedOccurrences || 0) + 1;
    suppressed.updatedAt = at;
    return suppressed;
  }
  // 已收尾的也不复活：它又出现了就是一件新事（人以为修好了却回来了），另起一条模式如实反映。
  let pattern = state.runtimeIssuePatterns.find((item) =>
    item.issueFingerprint === fingerprint && item.status !== "closed" && sameOwner(item));
  if (!pattern) {
    if (matchingSamples.length === 0 && !request.forcePattern) {
      const sample = {
        schemaVersion: "runtime-issue-sample/v1",
        sampleId: createId("ris"),
        status: "sample_recorded",
        issueClass: request.issueClass || "repeated_failure_fingerprint",
        issueFingerprint: fingerprint,
        affectedComponents: request.affectedComponents || ["orchestrator"],
        evidenceRefs: request.evidenceRefs || [`issue:${fingerprint}`],
        sampleRefs: request.sampleRefs || [`sample:${fingerprint}:1`],
        createdAt: at
      };
      state.runtimeIssueSamples.unshift(sample);
      capCentralCollection(state, "runtimeIssueSamples", 2000, null);
      return sample;
    }
    pattern = {
      schemaVersion: "runtime-issue-pattern/v1",
      patternId: createId("rip"),
      projectId: request.projectId,
      taskGroupId: request.taskGroupId,
      status: "clustered",
      issueClass: request.issueClass || "repeated_failure_fingerprint",
      issueFingerprint: fingerprint,
      recurrenceCount: Math.max(2, Number(request.recurrenceCount || matchingSamples.length + 1)),
      affectedComponents: request.affectedComponents || ["orchestrator"],
      evidenceRefs: request.evidenceRefs || [`issue:${fingerprint}`],
      sampleRefs: request.sampleRefs || [`sample:${fingerprint}:1`],
      collectionPolicy: {mode: "collect_only", forbidsRuntimeAutoUpgrade: true, externalUpgradePackageRequired: true},
      auditRef: `audit:runtime-issue:${fingerprint}`,
      createdAt: at,
      updatedAt: at
    };
    state.runtimeIssuePatterns.unshift(pattern);
    // 被压制的模式不许被容量裁掉：它在原位不动（压制只是就地改状态，不会被重新 unshift），
    // 够多新指纹之后就会掉出窗口 —— 于是同一件事重新聚类、重新升级，而人明明判过"不用管"。
    // 人的判断不能被容量悄悄撤销，这与升级候选那边的保留式裁剪是同一条规矩。
    // 保留式裁剪在这里是错的：它会无条件留下整类，压制一多就成了无界增长（规范门当场抓到）。
    // 正确的做法是【在同一个 2000 的额度里排优先级】：压制过的排到前面，再照旧硬裁。
    capCentralCollection(state, "runtimeIssuePatterns", 2000, (item) => item.status === "suppressed");
  } else {
    pattern.recurrenceCount += 1;
    pattern.status = pattern.recurrenceCount >= 2 ? "clustered" : "observed";
    pattern.evidenceRefs = unique([...pattern.evidenceRefs, ...(request.evidenceRefs || [])]);
    pattern.sampleRefs = unique([...pattern.sampleRefs, ...(request.sampleRefs || [`sample:${fingerprint}:${pattern.recurrenceCount}`])]);
    pattern.updatedAt = at;
  }
  if (pattern.recurrenceCount >= 3 && !pattern.candidateRef) {
    const candidate = {
      schemaVersion: "system-upgrade-candidate/v1",
      candidateId: createId("suc"),
      issuePatternId: pattern.patternId,
      projectId: pattern.projectId,
      taskGroupId: pattern.taskGroupId,
      status: "candidate_created",
      issueFingerprint: pattern.issueFingerprint,
      recurrenceCount: pattern.recurrenceCount,
      affectedComponents: pattern.affectedComponents,
      evidenceRefs: pattern.evidenceRefs,
      sampleRefs: pattern.sampleRefs,
      runtimeMutationPolicy: {
        mode: "collect_only",
        forbidActiveExecutionMutation: true,
        forbiddenActions: ["mutate_active_ruleset", "self_patch_control_plane", "change_scheduler_policy", "auto_publish_role_skill_overlay", "auto_change_permission_policy", "auto_expand_mcp_grant", "create_runtime_self_upgrade_task_group", "execute_system_upgrade_during_project_run"]
      },
      externalMaintenancePolicy: {requiresExternalMaintenance: true, forbidsRuntimeAutoUpgrade: true, forbidsAutoUpgradeTaskGroup: true, exportPackageRequired: true},
      auditRef: `audit:system-upgrade:${pattern.patternId}`,
      createdAt: at,
      updatedAt: at
    };
    state.systemUpgradeCandidates.unshift(candidate);
    state.systemUpgradeCandidates = capRetainingPredicate(state.systemUpgradeCandidates, (item) => item.status === "candidate_created", 2000);
    pattern.status = "candidate_created";
    pattern.candidateRef = candidate.candidateId;
  }
  appendEvent(state, "blocker", "RuntimeIssuePattern", pattern.patternId, "monitor", pattern);
  return pattern;
}

  return {collectRuntimeIssue, settleRuntimeIssuePatternForCandidate};
}

