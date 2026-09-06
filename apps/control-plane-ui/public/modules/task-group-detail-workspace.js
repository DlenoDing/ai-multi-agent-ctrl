(function initTaskGroupDetailWorkspace(global) {
  "use strict";

function render(taskGroup, context, helpers) {
  const {tgDetail, state, dispatchRuleSummaries = {}} = context;
  const {
    WORK_ITEM_OWNER_ROLE_CHOICES, badge, blockerGuide, customBadge, esc, explainCoded,
    findWorkItemDispatches, fmtTime, guideBundle, hasGroupPerm, humanTraceHtml, kindLabel,
    languageLabel, languageSelectOptions, orchestratorCadenceText, percentCell, progressBar,
    progressLine, repositoryFailureAction, roleSkillOverlayForm, roleSkillOverlayTable,
    ruleEditorForm, ruleSummaryHtml, sectionBlock, taskGroupRoleSkillOverlays,
    workItemExitHint, workItemResultHtml, renderTaskGroupExecutionTimeline, jumpModuleCard, t
  } = helpers;
  if (!tgDetail || tgDetail.taskGroupId !== taskGroup.id) {
    return `<div class="notice">正在加载任务组详情…</div>`;
  }
  if (tgDetail.loadFailed) {
    return `<div class="notice warn-notice">这个任务组的详情没能加载出来（原因写在页面顶部的横幅里）——`
      + "上面那行概要是刚取到的，可以照常看；点一下右上角的刷新可以再试一次。</div>";
  }
  const progressData = tgDetail.progress || {};
  const analysis = progressData.taskAnalysis;
  const analysisCount = (analysis?.items || []).length;
  const analysisHtml = analysis && analysisCount
    ? `<div class="tree">${(analysis.items || []).map((item) => `
        <div class="tree-item">
          <div class="tree-head">${customBadge(kindLabel(item.kind), "gray")} <strong>${esc(item.title)}</strong> ${badge(item.status)} <em class="small muted">${item.progress ?? 0}%</em></div>
          ${progressBar(item.progress)}
          ${item.note ? `<div class="tree-note">${esc(item.note)}</div>` : ""}
          ${(item.children || []).length ? `<div class="tree-children">${item.children.map((child) => `
            <div class="tree-item minor">
              <div class="tree-head">${customBadge(kindLabel(child.kind), "gray")} ${esc(child.title)} ${badge(child.status)} <em class="small muted">${child.progress ?? 0}%</em></div>
              ${child.note ? `<div class="tree-note">${esc(child.note)}</div>` : ""}
            </div>
          `).join("")}</div>` : ""}
        </div>
      `).join("")}</div>`
    : `<div class="notice">事项清单尚未生成。控制面会按固定周期自动跑编排（${orchestratorCadenceText()}），
        生成后会出现在这里 —— 你不需要点任何按钮。若长时间没有变化，多半是这个任务组还缺前置条件
        （例如项目尚未登记仓库、或角色 Skill 未同步），到“阻塞处置”查看。</div>`;

  // 只读进度接口那份：视图里的任务组【不再带整份 roles】（列表只用 roleCount）。
  // 留着 `|| taskGroup.roles` 那截兜底会骗人 —— 它永远是 undefined，看代码的人以为还有第二个来源。
  const roleCount = (progressData.roles || []).length;
  const roles = (progressData.roles || []).map((role) => `
    <div class="record">
      <div class="record-title">
        <strong>${esc(t(role.roleId))}</strong><span class="mono small muted">${esc(role.roleId)}</span>
        ${badge(role.status)}
        ${role.addedBy === "auto" ? customBadge("自动加入", "orange") : role.addedBy === "inherited" ? customBadge("继承项目", "gray") : customBadge("手动添加", "blue")}
      </div>
      ${role.addedAt ? `<div class="record-meta"><span>加入时间：${fmtTime(role.addedAt)}</span></div>` : ""}
    </div>
  `).join("") || `<div class="notice">暂无角色记录。</div>`;

  const config = tgDetail.config;
  // 这一页只对着一个任务组，按它判权（并集会让只在别的组上有权的人看到按不动的按钮）。
  const canControl = hasGroupPerm(taskGroup.id, "task_group:control") && taskGroup.status !== "closed" && taskGroup.status !== "aborted";
  const canReviewWork = hasGroupPerm(taskGroup.id, "task_group:review");
  const editDisabled = canControl ? "" : "disabled";
  const configUnavailable = `<div class="notice">暂时无法读取任务组配置（${esc(tgDetail.configLoadError || "配置接口没取回来")}）：请点击右上角刷新重试；若一直取不回来，多半是这一台服务端有问题，配置本身没丢。</div>`;
  const configSourceHtml = config ? `
    <div class="stack">
      <div class="record-title">
        <strong>配置来源：</strong>
        ${config.configSource === "customized" ? customBadge("已自定义", "orange") : customBadge("继承项目", "green")}
        ${config.configSource === "customized" && canControl ? `<button class="danger-button" data-action="tg-config-reset" data-task="${esc(taskGroup.id)}">重置为继承项目</button>` : ""}
      </div>
      ${canControl ? "" : `<div class="notice warn-notice">当前账号无“任务组控制”权限，配置为只读。</div>`}
      <form class="form-grid" data-form="tg-config" data-task="${esc(taskGroup.id)}">
        <div class="form-row"><label>默认角色（逗号分隔角色 ID）</label>
          <input name="defaultRoles" list="config-role-options" data-orig="${esc((config.defaultRoles || []).map((role) => role.roleId || role).join(","))}" value="${esc((config.defaultRoles || []).map((role) => role.roleId || role).join(","))}" ${editDisabled}>
          <datalist id="config-role-options">${WORK_ITEM_OWNER_ROLE_CHOICES.map((roleId) => `<option value="${esc(roleId)}">${esc(t(roleId))}</option>`).join("")}</datalist>
        </div>
        <div class="record-meta">
          <span>仓库配置：${(config.repositories || []).length} 条（在「项目设置」页维护，任务组可覆盖）</span>
          <span>基线数据：${(config.baselineData || []).length} 条</span>
        </div>
        <button class="primary-button" type="submit" ${editDisabled}>保存默认角色</button>
      </form>
    </div>
  ` : configUnavailable;
  const skillConfigHtml = `
    <div class="notice">这里只处理本任务组的特殊角色能力要求。项目级定制会显示为“项目级继承”，任务组级定制会优先生效；下一次派发时由服务端同步到 Agent。</div>
    ${roleSkillOverlayTable(taskGroupRoleSkillOverlays(taskGroup.id, taskGroup.projectId), {showScope: true})}
    ${roleSkillOverlayForm({scope: "task_group", projectId: taskGroup.projectId, taskGroupId: taskGroup.id, readOnly: !canControl})}
  `;
  const systemRulesHtml = config ? ruleEditorForm({
    rules: config.systemRules || [],
    listId: "tg-system-rules",
    category: "system",
    layer: "task_group",
    task: taskGroup.id,
    readOnly: !canControl,
    note: "展示解析结果：徽标标明来自默认、项目、任务组。可在任务组层停用、改写或新增。"
  }) : configUnavailable;
  const businessRulesHtml = config ? ruleEditorForm({
    rules: config.businessRules || [],
    listId: "tg-business-rules",
    category: "business",
    layer: "task_group",
    task: taskGroup.id,
    readOnly: !canControl,
    note: "任务组层可覆盖项目业务规则，或新增仅本任务组生效的规则。"
  }) : configUnavailable;

  const languagePolicy = taskGroup.languagePolicy || {languageTag: "zh-CN"};
  const controlHtml = canControl ? `
    <div class="stack">
      <div class="button-row">
        <button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="pause">暂停执行</button>
        <button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="resume">恢复执行</button>
        <button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="request_review">请求评审</button>
      </div>
      <form class="form-grid" data-form="language-policy" data-language-policy-form data-task="${esc(taskGroup.id)}">
        <div class="form-row"><label>任务组统一语言</label><select name="languageTag">${languageSelectOptions(languagePolicy.languageTag || "zh-CN")}</select></div>
        <button class="primary-button" type="submit">保存语言策略</button>
      </form>
    </div>
  ` : `<div class="notice">当前账号无“任务组控制”权限，仅可查看。当前统一语言：${esc(languageLabel(languagePolicy))}。</div>`;

  // 视图里嵌的工作项是截断过的（真实总数在 workItemCount）。明细页优先用专用端点的完整列表；
  // 只有它没加载出来时才回落到这份截断的，而那时必须说清楚"这不是全部"。
  const embeddedTruncated = !progressData.workItems && taskGroup.workItemsTruncated === true;
  // 任务按时间线倒序：最新建的排最前（服务端下发的是插入序＝最旧在前）。两条数据路径（进度接口/列表内嵌）经同一个排序；slice 不改原数组。
  const workItems = (progressData.workItems || taskGroup.workItems || []).slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).map((workItem) => {
    return `
      <details class="record task-item">
        <summary class="record-title"><strong>${esc(workItem.title)}</strong>${badge(workItem.status)}
          <button class="secondary-button" data-open-work="${esc(workItem.id)}" data-work-group="${esc(taskGroup.id)}">查看任务</button></summary>
        ${progressLine(workItem.progress)}
        <div class="record-meta"><span>执行角色：${esc(t(workItem.ownerRole))}</span>${workItem.pinnedModelId ? `<span>指定模型：<span class="mono">${esc(workItem.pinnedModelId)}</span></span>` : ""}${workItem.blockedReason ? `<span>受阻原因：${esc(explainCoded(workItem.blockedReason))}</span>` : ""}${humanTraceHtml(workItem)}</div>
        <!-- 被阻塞的工作项：屏幕上要么给出【出口】，要么明说【系统会自清】。只写一句"受阻原因"
             等于把人留在原地 —— 后端有杠杆而界面没入口，等于这个杠杆不存在；而系统自清的也必须
             说出来，否则人会去找一个并不需要的操作。每一条都按代码里真实的清除路径写：
             blocked_dependency 由下一轮编排自动放行，其余两种都要人先动手（已核实过产生它们的分支）。 -->
        ${workItemExitHint(workItem)}
        <!-- 决定"这件事算不算需要人定稿的方案"的分类器是字面匹配：它认不出架构与选型这类决策。
             机器判不了的事，判断权归人 —— 这里给出那个杠杆，并说清分类器的局限，
             免得"没被要求定稿"被读成"系统判断过、认为不必"。 -->
        ${workItem.requiresPlanFinalization === true
          ? `<div class="notice warn-notice">已由 ${esc(workItem.planFinalizationDecidedBy || "?")} 指定：必须先有人工定稿的执行方案才能开跑${workItem.planFinalizationJustification ? `（${esc(workItem.planFinalizationJustification)}）` : ""}。
              ${/* 这句话原先只说事实、不说出口。而编排在这种情况下【不改工作项状态、也留不下任务组阻塞】
                    （没有工作项被标成受阻时，本轮结算会把阻塞面整体清空），所以除了这一句，屏幕上再没有
                    别的地方会讲它在等什么 —— 实测拉完杠杆连推三轮，单元一直停在原地。 */""}
              等 agent 提出执行方案后，到「人工审核」页定稿它；没有在线 agent 时不会有人提方案。
              不再需要这项要求时，在下面把它改回「不强制」。</div>`
          : ""}
        ${canReviewWork ? `
          ${/* 这张表单每张工作项卡都整套渲染（说明 + 下拉 + 理由 + 保存），卡片被撑得很高，而它是偶尔才动一次的杠杆。
                默认收起，摘要写明当前取值；上面那条「必须先定稿」的警示不受影响，仍然常显。 */""}
          <details class="guide-bundle plan-finalization-toggle"><summary class="guide-bundle-summary">执行方案定稿要求：当前「${workItem.requiresPlanFinalization === true ? "必须先由人定稿方案" : "不强制（按系统判断）"}」—— 点开可改</summary>
          <form class="form-grid" data-form="plan-finalization" data-task="${esc(taskGroup.id)}" data-work="${esc(workItem.id)}" style="margin-top:8px;">
            <div class="record-meta"><span>系统靠关键词判断这件事要不要人工定稿方案，它认不出架构选型这类决策 —— 你可以直接指定。</span></div>
            <div class="form-row"><label>是否必须先定稿执行方案</label><select name="requiresPlanFinalization">
              <option value="false"${workItem.requiresPlanFinalization === true ? "" : " selected"}>不强制（按系统判断）</option>
              <option value="true"${workItem.requiresPlanFinalization === true ? " selected" : ""}>必须先由人定稿方案</option>
            </select></div>
            <div class="form-row"><label>理由（必填）</label><input name="justification" placeholder="例如：这涉及存储选型，做错了后面全要返工"></div>
            <button class="secondary-button" type="submit">保存</button>
          </form></details>` : ""}
        ${(() => {
          // 执行历史：这个任务先后交给了哪些 agent、每次用什么角色/模型、结果如何——全部派发按时间倒序，最新在前。
          // 节点只展示 id：tg 页取的是 tasks 视图，里面没有 agentRuntimeNodes，不为一个名字多拉一份集合。
          const history = findWorkItemDispatches(taskGroup.id, workItem.id);
          if (!history.length) return "";
          return `<div class="stack" style="margin-top:6px;">
            <div class="small muted">执行历史（共 ${esc(history.length)} 次派发，最新在前）</div>
            ${history.map((item) => `
              <div class="record-meta">
                <span>${esc(fmtTime(item.createdAt || item.updatedAt))}</span>
                <span>${badge(item.status)} ${percentCell(item.progressPercent)}</span>
                <span>节点：<span class="mono">${esc(item.assignedNodeId || "未分配")}</span></span>
                <span>角色：${esc(t(item.roleId) || item.roleId || "-")}</span>
                <span>模型：${esc(item.model || "自动")}</span>
                ${Number(item.attempts) > 1 ? `<span>第 ${esc(item.attempts)} 次尝试</span>` : ""}
                ${item.failureReason ? `<span>失败：${esc(explainCoded(item.failureReason))}</span>` : ""}
                ${item.blockedReason ? `<span>受阻：${esc(explainCoded(item.blockedReason))}</span>` : ""}
                ${repositoryFailureAction(item)}
                <span>派发：<span class="mono">${esc(item.dispatchId)}</span></span>
                <button class="secondary-button" data-action="show-dispatch-events" data-dispatch-id="${esc(item.dispatchId)}">实时事件</button>
                <button class="secondary-button" data-action="show-dispatch-rules" data-dispatch-id="${esc(item.dispatchId)}">${dispatchRuleSummaries[item.dispatchId] ? "收起规则" : "规则"}</button>
              </div>
              ${dispatchRuleSummaries[item.dispatchId] ? ruleSummaryHtml(dispatchRuleSummaries[item.dispatchId]) : ""}`).join("")}
          </div>`;
        })()}
        ${workItemResultHtml(taskGroup.id, workItem.id)}
      </details>
    `;
  }).join("");

  // 这一节原先只看提示型 blockers（S0/S1/S2），与"这个任务组能不能关闭"完全无关：
  // 关闭门禁只存在于"执行监控"页。于是人在任务组页看到"无阻塞"，却关不掉它 ——
  // 界面给出的是与事实相反的结论。把关闭门的判定接进来，并说清下一步该去哪。
  const groupBarrier = (state.closeBarriers || []).find((item) => item.taskGroupId === taskGroup.id);
  const barrierBlockers = groupBarrier && !groupBarrier.satisfied ? (groupBarrier.blockingObjects || []) : [];
  const advisoryBlockerItems = progressData.blockers || taskGroup.blockers || [];
  const advisoryBlockers = advisoryBlockerItems.map((blocker) => `
    <div class="record"><div class="record-title">${badge(blocker.severity || "attention")} <span>${esc(blocker.summary)}</span></div></div>
  `).join("") + (Number(taskGroup.blockersDroppedCount || 0) > 0
    // 提示有上限，超出的会被丢掉。悄悄丢等于让人以为问题只有屏幕上这几个。
    ? `<div class="record"><div class="record-title">${badge("attention")} <span>另有 ${esc(taskGroup.blockersDroppedCount)} 条较早的提示因数量上限已不再保留 —— 不要据此认为问题只有上面这些</span></div></div>`
    : "");
  const barrierSummary = !groupBarrier
    ? `<div class="record"><div class="record-title">关闭门禁：<strong>尚未计算</strong></div><div class="record-meta">进入“关闭门禁”重算，或等下一次编排周期，才会知道这个任务组能不能关闭。</div></div>`
    : groupBarrier.satisfied
      ? `<div class="record"><div class="record-title">关闭门禁：${customBadge("可关闭", "green")}</div></div>`
      : `<div class="record">
          <div class="record-title">关闭门禁：${customBadge("存在阻塞", "red")}（${barrierBlockers.length} 项）</div>
          <div class="chip-row">${barrierBlockers.slice(0, 12).map((obj) => customBadge(`${t(obj.objectType) || obj.objectType}${obj.gate ? `·${t(obj.gate) || obj.gate}` : ""}`, "red")).join(" ")}</div>
          ${[...new Map(barrierBlockers.slice(0, 12)
            .map((obj) => [`${obj.objectType}:${obj.gate || ""}`, obj])).values()].map((obj) => {
            const guide = blockerGuide(obj.objectType, obj.gate);
            const label = obj.gate ? `${t(obj.gate) || obj.gate}` : `${t(obj.objectType) || obj.objectType}`;
            return guide ? `<div class="record-meta"><span>${esc(label)}：${esc(guide)}</span></div>` : "";
          }).join("")}
        </div>`;
  const blockers = `${barrierSummary}${advisoryBlockers || (barrierBlockers.length ? "" : `<div class="record">无其它提示型阻塞</div>`)}`;

  const guard = taskGroup.singleCellEscalationGuard;
  const cellIds = (ids) => (ids || []).length ? (ids || []).map((id) => esc(id)).join("、") : "—";
  const admissionHtml = guard ? `
      <div class="record-meta">
        <span>可执行 cell：${(guard.executableCells || []).length}</span>
        <span>等待 cell：${(guard.waitingCells || []).length}</span>
        <span>阻塞 cell：${(guard.blockedCells || []).length}</span>
        <span>整体阻断：${guard.overallBlockedPermitted ? customBadge("允许", "red") : customBadge("不允许（仍有可推进项）", "green")}</span>
      </div>
      <div class="small muted">可执行：${cellIds(guard.executableCells)}</div>
      <div class="small muted">等待（不升格）：${cellIds(guard.waitingCells)}</div>
      <div class="small muted">真实阻断：${cellIds(guard.escalatableBlockedCells)}</div>
    ` : `<div class="notice">暂无准入分类（编排运行后自动生成）。</div>`;

  // 署名由服务端从已认证主体派生（account:… / agent_node:…），报文里自报的发送者一律不采信 ——
  // 否则这块面板会把 agent 自己署的名当成人说的话展示给人看，比不展示更糟。
  const roomMessages = tgDetail.roomMessages;
  const roomHtml = roomMessages === null
    ? `<div class="notice warn-notice">${tgDetail.roomLoadDenied
        ? "当前账号无权查看这个任务组的协作记录 —— 要看的话，请让项目负责人给你这个任务组的查看权限。"
        : `协作记录没能取回来（${esc(tgDetail.roomLoadError || "服务端没有给出这一块")}）：`
          + "点右上角的 ↻ 刷新再试一次 —— 这不是「没有协作记录」。"}</div>`
    : !roomMessages.length
      ? `<div class="notice">暂无协作记录。agent 之间若通过房间协商方案，过程会显示在这里。</div>`
      : `<div class="stack">
          <div class="small muted">这些是 agent 之间实际交换的消息。送到你面前的方案可能是在这里谈成的 ——
            定稿前值得看一眼过程，而不只是结论。发送者由服务端按已认证身份署名，不是消息自报的。</div>
          ${/* 这一屏取的是【最近】的若干条：按游标从头取会正好错过谈成结论的那一段。
                被截掉的部分必须说出来，否则 50 条和"只有 50 条"在屏幕上长得一模一样。 */""}
          ${tgDetail.roomMessagesTruncated
            ? `<div class="small muted">共 ${esc(String(tgDetail.roomMessageTotal ?? "?"))} 条，这里显示最近 ${roomMessages.length} 条。</div>`
            : ""}
          ${roomMessages.map((message) => {
            const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
            const text = typeof payload.text === "string" && payload.text ? payload.text : JSON.stringify(payload, null, 2);
            return `
              <div class="record">
                <div class="record-title">
                  <span class="mono small">#${esc(String(message.sequence ?? ""))}</span>
                  <strong>${esc(String(message.senderRef || "unattributed"))}</strong>
                  ${message.senderRef === "unattributed" ? customBadge("无署名", "orange") : ""}
                </div>
                <div class="record-meta"><span>${fmtTime(message.createdAt)}</span></div>
                <pre class="small" style="white-space:pre-wrap;word-break:break-word;margin:6px 0 0;">${esc(String(text).slice(0, 4000))}</pre>
              </div>
            `;
          }).join("")}
        </div>`;
  const workItemCount = Number(progressData.workItemCount ?? taskGroup.workItemCount ?? (progressData.workItems || taskGroup.workItems || []).length);
  const blockerCount = barrierBlockers.length + advisoryBlockerItems.length + Number(taskGroup.blockersDroppedCount || 0);
  const roomCount = Array.isArray(roomMessages) ? roomMessages.length : null;
  const detailPathHtml = global.AIMAC_TASK_GROUP_INSIGHTS.detailPath({
    analysisCount,
    roleCount,
    configLabel: config ? (config.configSource === "customized" ? "自定义" : "继承") : "未加载",
    skillCount: taskGroupRoleSkillOverlays(taskGroup.id, taskGroup.projectId).length,
    systemRuleCount: (config?.systemRules || []).length,
    businessRuleCount: (config?.businessRules || []).length,
    canControl,
    workItemCount: Number.isFinite(workItemCount) ? workItemCount : 0,
    hasAdmission: Boolean(guard),
    blockerCount,
    roomCount
  }, {jumpModuleCard, sectionBlock});

  return `
    <div class="stack" style="margin-top:8px;">
      ${guideBundle("详情阅读路径", [detailPathHtml], ["任务组详情阅读路径（12 项）"])}
      ${sectionBlock("事项清单", analysisHtml)}
      ${sectionBlock("角色列表", `<div class="stack">${roles}</div>`)}
      ${sectionBlock("配置继承", configSourceHtml)}
      ${sectionBlock("角色 Skill 定制", skillConfigHtml)}
      ${sectionBlock("系统规则", systemRulesHtml)}
      ${sectionBlock("业务规则", businessRulesHtml)}
      ${sectionBlock("执行控制", controlHtml)}
      ${sectionBlock(`工作项${progressData.workItemsTruncated
        ? `（共 ${esc(progressData.workItemCount)} 个，当前展示 ${(progressData.workItems || []).length} 个）` : ""}`,
        `<div class="stack">${progressData.workItemsTruncated
        ? `<div class="notice">工作项很多，这里只加载了最新的 ${(progressData.workItems || []).length} 个（共 ${esc(progressData.workItemCount)} 个）—— 下面的筛选只在已加载的这些里找。</div>`
        : ""}${embeddedTruncated
        ? `<div class="notice warn-notice">进度接口没有加载出来，这里回落到列表视图里嵌的最新的 ${(taskGroup.workItems || []).length} 个（共 ${esc(taskGroup.workItemCount ?? "?")} 个）—— 不要据此判断"只有这些"。请刷新重试。</div>`
        : ""}${workItems || `<div class="notice">暂无工作项。</div>`}</div>`)}
      ${sectionBlock("准入与阻断分类", admissionHtml)}
      ${sectionBlock("阻塞", `<div class="stack">${blockers}</div>`)}
      ${sectionBlock("任务执行时间线", renderTaskGroupExecutionTimeline(taskGroup, progressData))}
      ${sectionBlock("协作记录（agent 之间的房间消息）", roomHtml)}
    </div>
  `;
}


  global.AIMAC_TASK_GROUP_DETAIL_WORKSPACE = {render};
})(window);

