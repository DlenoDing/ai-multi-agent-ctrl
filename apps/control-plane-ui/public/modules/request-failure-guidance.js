(function initRequestFailureGuidance(global) {
  "use strict";

  function pathList(paths, label) {
    if (!Array.isArray(paths) || !paths.length) return "";
    return `${label}：${paths.slice(0, 8).join("、")}`
      + `${paths.length > 8 ? `（共 ${paths.length} 条，此处显示前 8 条）` : ""}`;
  }

  function hint(payload, helpers) {
    const {accountName, fmtTime, t, explainCoded, grantRoleLabel} = helpers;
    let output = "";
    if (payload.requiredPermission) {
      const scope = payload.resourceScope
        ? `${payload.resourceScope.resourceType || "?"}:${payload.resourceScope.resourceId || "?"}`
        : "";
      output = `（需要 ${payload.requiredPermission}${scope ? ` @ ${scope}` : ""}`
        + `${String(payload.requiredPermission).startsWith("task_group:")
          ? "；这类权限只能在「项目管理」→「任务组权限」按角色授予，写在账号上的直接权限不生效"
          : ""}）`;
    }
    if (Array.isArray(payload.permissions) && payload.permissions.length) {
      output += `（涉及：${payload.permissions.join("、")}）`;
    }

    if (payload.decidedBy || payload.decidedAction) {
      const who = payload.decidedBy ? accountName(payload.decidedBy) : "另一个人";
      const what = payload.decidedAction === "finalize"
        ? "定稿"
        : payload.decidedAction === "reject"
          ? "打回返工"
          : payload.decidedAction === "revise"
            ? "提交了修改意见"
            : "处理";
      output += `（${who} 已在 ${fmtTime(payload.decidedAt)} ${what}`
        + `${payload.decidedOption ? `：${payload.decidedOption}` : ""}；刷新即可看到结果，重复提交不会生效）`;
    } else if (payload.currentRound !== undefined) {
      output += `（当前轮次已是第 ${payload.currentRound} 轮，你看到的是更早的一轮 —— `
        + "AI 在你点击前修订过候选方案，请刷新后重新查看再决定）";
    }

    if (payload.quota !== undefined && payload.usage !== undefined) {
      const kindLabel = {members: "成员", projects: "项目", taskGroups: "任务组", agents: "智能体"}[payload.kind] || "该资源";
      const freeUp = payload.kind === "agents"
        ? "或吊销一台不再用的节点（关停、停用档案都不减用量；未签发出去用掉的加入令牌也占着额度）"
        : "或先关掉/归档不再需要的";
      const breakdown = payload.outstandingJoinTokens
        ? `（其中 ${payload.nodes} 台节点 + ${payload.outstandingJoinTokens} 张未使用的加入令牌）`
        : "";
      output += `（${kindLabel} ${payload.usage}/${payload.quota} 已满${breakdown}：到「组织管理」页调高这一项配额，`
        + `${freeUp}，再重试）`;
      if (payload.projectedUsage !== undefined) {
        output += `（本次操作完成后预计用量：${payload.projectedUsage}/${payload.quota}）`;
      }
    }

    const guidance = [
      payload.message,
      payload.reason,
      Array.isArray(payload.required) ? payload.required.join("；") : payload.required,
      Array.isArray(payload.supported) && payload.supported.length
        ? `可用的取值：${payload.supported.join("、")}` : "",
      payload.retryAfterSeconds ? `${payload.retryAfterSeconds} 秒后可再试` : "",
      payload.closedBy ? `已由 ${payload.closedBy} 关闭${payload.closedAt ? `（${payload.closedAt}）` : ""}` : "",
      payload.hint,
      payload.received ? `收到的是：${payload.received}` : "",
      Array.isArray(payload.openTaskGroupIds) && payload.openTaskGroupIds.length
        ? `还没关掉的任务组：${payload.openTaskGroupIds.join("、")}` : "",
      payload.minLength ? `至少需要 ${payload.minLength} 位` : "",
      payload.pauseReason ? `停因：${t(payload.pauseReason)}` : "",
      payload.currentStatus ? `当前状态：${payload.currentStatus}` : "",
      Array.isArray(payload.allowedStatuses) && payload.allowedStatuses.length
        ? `可以转到：${payload.allowedStatuses.join("、")}` : "",
      pathList(payload.deniedPaths, "踩到禁区的路径"),
      pathList(payload.unknownRoles, "不在词表里的账号角色"),
      pathList(payload.unknownOwnerRoles, "未登记的执行角色"),
      Array.isArray(payload.invalid) && payload.invalid.length
        ? `填错的项：${payload.invalid.map((item) => `${item.key}=${JSON.stringify(item.received)}`).join("、")}` : "",
      payload.limits && payload.limits.min !== undefined
        ? `允许范围：${payload.limits.min} 到 ${payload.limits.max}` : "",
      pathList(payload.unknownPermissions, "不在词表里的权限"),
      pathList(payload.unknownKeys, "认不出的键"),
      pathList(payload.outsidePaths, "落在允许范围之外的路径"),
      pathList(payload.trespassedPaths, "踩进了方案禁区的路径"),
      pathList(payload.forbiddenPaths, "人批准的方案里划为禁区的路径"),
      pathList(payload.changedPaths, "这次实际改动的路径"),
      pathList(payload.approvedPaths, "人批准的方案允许改的路径"),
      payload.holderRef ? `当前持有者：${payload.holderRef}` : "",
      payload.activeLeaseRef ? `还生效的租约：${payload.activeLeaseRef}` : "",
      payload.maxBytes ? `上限 ${payload.maxBytes} 字节` : "",
      payload.mismatchedField ? `对不上的字段：${payload.mismatchedField}` : "",
      payload.resourceType ? `作用域类型：${explainCoded(payload.resourceType)}` : "",
      payload.role ? `角色：${grantRoleLabel(payload.role)}` : "",
      payload.taskGroupStatus ? `任务组当前状态：${t(payload.taskGroupStatus)}` : "",
      payload.assessment ? `评估结论：${explainCoded(payload.assessment)}` : "",
      payload.dispositionClass ? `处置类别：${explainCoded(payload.dispositionClass)}` : "",
      payload.expected !== undefined && payload.actual !== undefined
        ? `应为 ${payload.expected}，实际 ${payload.actual}` : "",
      payload.commit ? `涉及的提交：${payload.commit}` : "",
      payload.directiveType ? `你发的指令类型：${payload.directiveType}` : "",
      payload.roleSkillRef ? `指定的角色 Skill：${payload.roleSkillRef}` : "",
      payload.subjectRef ? `这张卡管的是：${payload.subjectRef}` : "",
      payload.cause === "path_allowlist_invalid"
        ? "原因：允许路径清单本身不合法（这是配置问题，不是你填的那条路径）" : "",
      payload.cause === "manifest_path_not_git_trackable" ? "原因：产出清单那条路径 git 跟不住" : "",
      payload.path ? `涉及的路径：${payload.path}` : "",
      payload.branch ? `你填的分支名：${payload.branch}` : "",
      payload.remote ? `你填的 remote 名：${payload.remote}` : "",
      Array.isArray(payload.allowedPaths) && payload.allowedPaths.length
        ? `当前允许的路径：${payload.allowedPaths.join("、")}` : "",
      payload.file ? `涉及的文件：${payload.file}` : "",
      payload.kind && payload.quota === undefined ? `故障类型：${t(payload.kind)}` : "",
      payload.code && typeof payload.code === "string" ? `系统错误码：${payload.code}` : "",
      payload.requiredRuntimeVersion
        ? `需要的运行时版本：${payload.requiredRuntimeVersion}（该节点当前 ${payload.nodeRuntimeVersion || "未知"}）`
        : "",
      payload.presented !== undefined && payload.claimEpoch !== undefined
        ? `你带的认领代次 ${payload.presented}，当前是 ${payload.claimEpoch}` : ""
    ].map((item) => String(item || "").trim()).filter(Boolean);
    if (guidance.length) output += `：${[...new Set(guidance)].join("；")}`;
    return output;
  }

  global.AIMAC_REQUEST_FAILURE_GUIDANCE = {hint, pathList};
})(window);
