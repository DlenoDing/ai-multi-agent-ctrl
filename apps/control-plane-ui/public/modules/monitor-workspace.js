(function initMonitorWorkspace(global) {
  "use strict";
  const {esc} = global.AIMAC_CONSOLE_DOM_UTILS;

  function progress(value) {
    const percent = Math.max(0, Math.min(100, Number(value) || 0));
    return `<div class="monitor-scope-progress"><span style="width:${percent}%"></span></div>`;
  }

  function metric(label, value) {
    return `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }

  function scopeHeader({project, group = null, stats = {}, activeSessions = 0, activeDispatches = 0,
    latestEvent = null, blockingObjects = 0, helpers: h} = {}) {
    const groupScope = Boolean(group);
    const name = groupScope ? group.name || group.id : project?.name || project?.id || "当前项目";
    const status = groupScope ? group.goalExecutionStatus || group.status : project?.status;
    const progressValue = groupScope ? group.progress : project?.progress?.percent;
    const hasProgress = progressValue !== undefined && progressValue !== null && progressValue !== ""
      && Number.isFinite(Number(progressValue));
    return `<section class="monitor-scope-header wide" aria-label="${groupScope ? "任务组执行监控" : "项目执行总览"}">
      <div class="monitor-scope-heading"><div><span class="governance-eyebrow">${groupScope ? "任务组执行监控" : "项目执行总览"}</span>
        <h2>${esc(name)}</h2><div class="record-meta">${h.badge(status)}<span>${hasProgress ? `${esc(progressValue)}%` : "进度 —"}</span>${latestEvent ? `<span>最近事件 ${h.fmtTime(latestEvent.createdAt)}</span>` : `<span>尚无执行事件</span>`}</div></div>
        <div class="button-row">${groupScope ? `<button class="secondary-button" data-action="monitor-project-scope">返回项目监控</button><button class="primary-button" data-focus-group="${esc(group.id)}" data-focus-page="tg">任务组详情</button>` : ""}</div></div>
      ${hasProgress ? progress(progressValue) : ""}
      <div class="monitor-scope-metrics">
        ${metric(groupScope ? "任务" : "任务组", groupScope ? stats.tasks ?? 0 : stats.groups ?? 0)}
        ${metric("活跃会话", activeSessions)}
        ${metric("执行派发", activeDispatches)}
        ${metric("待审核", stats.reviews ?? 0)}
        ${metric("受阻", groupScope ? stats.blocked ?? 0 : blockingObjects)}
      </div>
      <div class="small muted">${groupScope
        ? "本页只显示这个任务组的会话、派发、节点、事件和门禁；任务组级审核与观察不会混入同项目其它任务组。"
        : "本页汇总当前项目内你有权查看的任务组；进入具体任务组或执行对象后再查看完整过程与控制。"}</div>
    </section>`;
  }

  global.AIMAC_MONITOR_WORKSPACE = {scopeHeader};
})(window);
