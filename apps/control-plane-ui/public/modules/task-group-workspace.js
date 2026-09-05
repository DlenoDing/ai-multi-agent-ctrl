(function () {
  "use strict";
  const {esc} = window.AIMAC_CONSOLE_DOM_UTILS;

  function list(groups, h) {
    const rows = groups.map((group) => h.row([
      `<button class="object-name-link" data-action="tg-detail" data-task="${esc(group.id)}">${esc(group.name || group.id)}</button>${group.humanGuidanceDroppedCount ? `<div class="small warn-text">另有 ${esc(group.humanGuidanceDroppedCount)} 条更早的补充要求已超出保留上限</div>` : ""}`,
      `${h.badge(group.goalExecutionStatus || "active")} ${h.badge(group.status)}${group.pauseReason ? `<div class="small muted">${esc(h.t(group.pauseReason))}</div>` : ""}`,
      h.progressLine(group.progress),
      `<span data-field="task-count">${group.workItemCount ?? (group.workItems || []).length}</span>`,
      `<span data-field="role-count">${group.roleCount ?? 0}</span>`,
      `<span data-field="group-language">${esc(h.languageLabel(group.languagePolicy))}</span>`,
      h.fmtTime(group.updatedAt),
      `<div class="button-row"><button class="secondary-button" data-action="tg-detail" data-task="${esc(group.id)}">查看详情</button>${h.quickControl(group)}${h.groupLink(group, "任务", "tasks")}${h.groupLink(group, "监控", "monitor")}</div>`
    ])).join("");
    return h.table(["任务组", "执行状态", "进度", {label: "任务数", c: "num nowrap"}, {label: "角色数", c: "num nowrap"}, "语言", {label: "更新时间", c: "nowrap"}, "操作"], rows, {emptyText: "当前项目暂无任务组。"});
  }

  function detail(group, body, h) {
    const guidance = group.humanGuidance || [];
    const guidanceTotal = Number(group.humanGuidanceTotal ?? guidance.length);
    return `<section class="task-group-object wide" aria-label="任务组工作区">
      <header class="task-group-object-header"><div><button class="secondary-button" data-action="tg-list">返回任务组列表</button>
        <h2>${esc(group.name || group.id)}</h2><div class="record-meta">${h.badge(group.status)} ${h.badge(group.phase)} ${h.badge(group.health)} ${h.badge(group.goalExecutionStatus || "active")}</div>
        ${group.objective ? `<p class="task-group-object-objective">${esc(group.objective)}</p>` : ""}</div>
        <div class="task-group-object-progress">${h.progressLine(group.progress)}<span class="small muted">${group.workItemCount ?? 0} 项任务 · ${group.roleCount ?? 0} 个角色 · <span data-field="group-language">${esc(h.languageLabel(group.languagePolicy))}</span></span></div></header>
      ${group.pauseReason ? `<div class="notice warn-notice">${esc(h.t(group.pauseReason))}</div>` : ""}
      <div class="task-group-object-actions">${h.controls(group)}${h.groupLink(group, "任务工作台", "tasks")}${h.groupLink(group, "监控", "monitor")}${h.groupLink(group, "审核", "review")}${h.groupLink(group, "指令", "directives")}${h.projectLink(h.project, "AI 智能体", {page: "proj-agents", workspace: "nodes"})}</div>
      ${guidance.length ? `<details><summary>人工补充要求（${guidance.length < guidanceTotal ? `最近 ${guidance.length} / 共 ${guidanceTotal} 条` : `${guidanceTotal} 条`}${group.humanGuidanceDroppedCount ? `，另有 ${esc(group.humanGuidanceDroppedCount)} 条更早的已超出保留上限` : ""}）</summary>${guidance.slice().reverse().map((item) => `<div class="record-meta"><span>${h.fmtTime(item.addedAt)}</span><span>${esc(item.text || "")}</span></div>`).join("")}</details>` : ""}
      ${body}
    </section>`;
  }

  window.AIMAC_TASK_GROUP_WORKSPACE = {list, detail};
})();
