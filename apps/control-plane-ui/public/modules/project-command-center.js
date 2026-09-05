(function initProjectCommandCenter(global) {
  "use strict";
  const {esc} = global.AIMAC_CONSOLE_DOM_UTILS;

  function actionButton(project, action) {
    if (action.kind === "workspace") {
      return `<button class="primary-button" data-workspace-page="${esc(action.page)}" data-workspace="${esc(action.workspace)}"${action.groupId ? ` data-create-for-group="${esc(action.groupId)}"` : ""}>${esc(action.label)}</button>`;
    }
    if (action.kind === "group") {
      return `<button class="primary-button" data-focus-group="${esc(action.groupId)}" data-focus-page="${esc(action.page)}">${esc(action.label)}</button>`;
    }
    if (action.kind === "control") {
      return `<button class="primary-button" data-action="task-control" data-task="${esc(action.groupId)}" data-task-action="${esc(action.control)}">${esc(action.label)}</button>`;
    }
    return `<button class="primary-button" data-action="open-project-page" data-project="${esc(project.id)}" data-target-menu="${esc(action.page)}"${action.workspace ? ` data-target-workspace="${esc(action.workspace)}"` : ""}>${esc(action.label)}</button>`;
  }

  function decide({project, groups = [], fleet = {}, repositories = [], todos = {}, statsFor, canControl = false} = {}) {
    const activeGroups = groups.filter((group) => !["closed", "aborted", "archived", "cancelled", "superseded"].includes(group.status));
    const groupStats = activeGroups.map((group) => ({group, stats: statsFor(group)}));
    const tasks = groupStats.reduce((sum, item) => sum + Number(item.stats.tasks || 0), 0);
    const runs = groupStats.reduce((sum, item) => sum + Number(item.stats.runs || 0), 0);
    const blocked = groupStats.reduce((sum, item) => sum + Number(item.stats.blocked || 0), 0);
    const reviews = Number(todos.review?.count || 0);
    const rechecks = Number(todos.monitor?.count || 0);
    const credentialMissing = repositories.some((repo) => {
      const mode = repo.credentialMode || repo.credential?.mode || "none";
      return mode !== "none" && !(repo.credential?.passwordSet || repo.credential?.apiKeySet || repo.credential?.sealedSecret);
    });
    if (project.status === "archived") return {title: "查看归档结果", detail: "项目已归档，只保留任务、执行记录和 Git 证据。",
      action: {kind: "page", page: "tasks", label: "查看任务结果"}, metrics: {groups: groups.length, tasks, runs, reviews: reviews + rechecks}};
    if (!repositories.length || credentialMissing) return {title: credentialMissing ? "补全仓库凭证" : "配置项目仓库",
      detail: credentialMissing ? "已有仓库选择了凭证模式，但密钥尚未保存。" : "Agent 产出必须写入项目 Git 仓库。",
      action: {kind: "page", page: "proj-settings", workspace: "repositories", label: "打开仓库设置"}, metrics: {groups: groups.length, tasks, runs, reviews: reviews + rechecks}};
    if (!Number(fleet.total || 0)) return {title: "注册 Agent 节点", detail: "当前项目没有可执行任务的运行节点。",
      action: {kind: "page", page: "proj-agents", workspace: "register", label: "生成注册命令"}, metrics: {groups: groups.length, tasks, runs, reviews: reviews + rechecks}};
    if (!Number(fleet.online || 0)) return {title: "恢复 Agent 节点", detail: `已登记 ${Number(fleet.total || 0)} 台节点，但当前没有在线容量。`,
      action: {kind: "page", page: "proj-agents", workspace: "nodes", label: "检查运行节点"}, metrics: {groups: groups.length, tasks, runs, reviews: reviews + rechecks}};
    if (!groups.length) return {title: "创建任务组", detail: "用任务组定义目标、统一语言、角色和执行边界。",
      action: {kind: "workspace", page: "tg", workspace: "create", label: canControl ? "创建任务组" : "查看任务组权限"}, metrics: {groups: 0, tasks: 0, runs, reviews: reviews + rechecks}};
    const empty = groupStats.find((item) => !item.stats.tasks);
    if (empty) return {title: "创建任务", detail: `“${empty.group.name || empty.group.id}”还没有可派发的任务。`,
      action: {kind: "workspace", page: "tasks", workspace: "create", groupId: empty.group.id, label: canControl ? "创建任务" : "查看任务组"}, metrics: {groups: groups.length, tasks, runs, reviews: reviews + rechecks}};
    const paused = groupStats.find((item) => String(item.group.goalExecutionStatus || "").startsWith("active_paused"));
    if (paused) return {title: "启动任务组", detail: `“${paused.group.name || paused.group.id}”已有任务，当前仍处于暂停状态。`,
      action: canControl ? {kind: "control", groupId: paused.group.id, control: "resume", label: "启动执行"}
        : {kind: "group", page: "tg", groupId: paused.group.id, label: "查看任务组"}, metrics: {groups: groups.length, tasks, runs, reviews: reviews + rechecks}};
    if (reviews) {
      const target = groupStats.find((item) => item.stats.reviews)?.group || activeGroups[0];
      return {title: "处理人工审核", detail: `${reviews} 项定稿、授权或审批正在等待当前账号处理。`,
        action: {kind: "group", page: "review", groupId: target?.id || "", label: "进入审核"}, metrics: {groups: groups.length, tasks, runs, reviews: reviews + rechecks}};
    }
    if (blocked || rechecks) {
      const target = groupStats.find((item) => item.stats.blocked)?.group || activeGroups[0];
      return {title: "处理执行阻塞", detail: `${blocked + rechecks} 项执行、复核或关闭门问题尚未收口。`,
        action: {kind: "group", page: "monitor", groupId: target?.id || "", label: "查看阻塞"}, metrics: {groups: groups.length, tasks, runs, reviews: reviews + rechecks}};
    }
    if (runs) {
      const target = groupStats.find((item) => item.stats.runs)?.group || activeGroups[0];
      return {title: "查看实时执行", detail: `${runs} 个会话正在排队或执行，过程事件会持续回送。`,
        action: {kind: "group", page: "monitor", groupId: target?.id || "", label: "打开执行监控"}, metrics: {groups: groups.length, tasks, runs, reviews: reviews + rechecks}};
    }
    const target = activeGroups[0] || groups[0];
    return {title: activeGroups.length ? "查看任务进展" : "查看任务结果", detail: activeGroups.length ? "当前没有待人工处理项，AI 总控会继续按阶段门推进。" : "任务组已结束，可核对任务结果和 Git 证据。",
      action: {kind: "group", page: "tasks", groupId: target?.id || "", label: activeGroups.length ? "打开任务工作台" : "查看结果"}, metrics: {groups: groups.length, tasks, runs, reviews: reviews + rechecks}};
  }

  function render(project, decision) {
    const metrics = decision.metrics || {};
    return `<section class="project-command-center wide" aria-label="项目当前主操作">
      <div class="project-command-main"><span>当前下一步</span><strong>${esc(decision.title)}</strong><small>${esc(decision.detail)}</small></div>
      <div class="project-command-metrics"><span>任务组 <strong>${esc(metrics.groups || 0)}</strong></span><span>任务 <strong>${esc(metrics.tasks || 0)}</strong></span><span>运行 <strong>${esc(metrics.runs || 0)}</strong></span><span>待处理 <strong>${esc(metrics.reviews || 0)}</strong></span></div>
      <div class="project-command-action">${actionButton(project, decision.action)}</div>
    </section>`;
  }

  global.AIMAC_PROJECT_COMMAND_CENTER = {decide, render};
})(window);
