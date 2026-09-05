(function () {
  "use strict";
  const {esc} = window.AIMAC_CONSOLE_DOM_UTILS;

  function backButton(action, label) {
    return `<button class="secondary-button" data-action="${esc(action)}">${esc(label)}</button>`;
  }

  function identityHeader({eyebrow, title, statusHtml, id, backAction, backLabel}) {
    return `<header class="governance-object-header" data-governance-object-heading tabindex="-1">
      <div>${backButton(backAction, backLabel)}<div class="small muted governance-eyebrow">${esc(eyebrow)}</div>
        <h2>${esc(title)}</h2><div class="record-meta"><span>${statusHtml}</span><span class="mono">${esc(id)}</span></div></div>
    </header>`;
  }

  function organizationDetail({organization: org, initialAdmin, subaccountStats = {}, actionsHtml, helpers: h}) {
    const quotaItems = [
      ["成员（含管理员）", org.usage?.members, org.quotas?.maxMembers],
      ["项目", org.usage?.projects, org.quotas?.maxProjects],
      ["任务组", org.usage?.taskGroups, org.quotas?.maxTaskGroups],
      ["Agent 节点", org.usage?.agents, org.quotas?.maxAgents, org.usage?.agentsReserved]
    ];
    const pressure = quotaItems.filter(([, used, max, reserved]) => Number(max) > 0
      && (Number(used || 0) + Number(reserved || 0)) / Number(max) >= 0.8).length;
    const adminStatus = initialAdmin ? h.statusBadge("account", initialAdmin.status) : h.customBadge("账号缺失", "red");
    return `<div class="governance-object-workspace">
      ${identityHeader({eyebrow: "系统管理 / 组织", title: org.name || org.orgId,
        statusHtml: h.statusBadge("organization", org.status), id: org.orgId,
        backAction: "close-org-detail", backLabel: "返回组织列表"})}
      <section class="governance-object-band" aria-label="组织治理摘要">
        <div class="metric-grid">
          <div class="metric"><span>初始组织管理员</span><strong>${esc(initialAdmin?.displayName || "账号缺失")}</strong><div class="small muted">${adminStatus}</div></div>
          <div class="metric"><span>组织子账户</span><strong>${esc(subaccountStats.total ?? 0)}</strong><div class="small muted">不含初始组织管理员</div></div>
          <div class="metric"><span>配额压力项</span><strong>${pressure}</strong><div class="small muted">使用达到 80% 的资源</div></div>
          <div class="metric"><span>创建时间</span><strong class="metric-time">${h.fmtTime(org.createdAt)}</strong></div>
        </div>
      </section>
      <div class="governance-object-columns">
        ${h.panel("初始组织管理员", `<dl class="kv-list">
          <dt>姓名</dt><dd>${esc(initialAdmin?.displayName || "-")}</dd>
          <dt>登录邮箱</dt><dd>${esc(initialAdmin?.email || "-")}</dd>
          <dt>账号状态</dt><dd>${adminStatus}</dd>
          <dt>登录密码</dt><dd>${initialAdmin?.authPolicy?.passwordSet ? "已设置" : "尚未设置"}</dd>
          <dt>账号编号</dt><dd class="mono">${esc(org.initialAdminAccountId || "-")}</dd>
        </dl><div class="small muted">系统管理员只维护组织的初始管理账号；组织内子账户由该组织管理员维护。</div>
        <div class="button-row governance-actions">${actionsHtml}</div>`, {wide: true})}
        ${h.panel("配额与用量", `<div class="governance-quota-list">${quotaItems.map(([label, used, max, reserved]) =>
          `<div><div class="record-title"><strong>${esc(label)}</strong><span>${esc(Number(used || 0) + Number(reserved || 0))}/${esc(max ?? "-")}</span></div>
            ${h.quotaLine(used, max, reserved)}</div>`).join("")}</div>`, {wide: true})}
      </div>
      ${h.panel("组织子账户概况", `<div class="metric-grid">
        <div class="metric"><span>子账户总数</span><strong>${esc(subaccountStats.total ?? 0)}</strong></div>
        <div class="metric"><span>已启用</span><strong>${esc(subaccountStats.active ?? 0)}</strong></div>
        <div class="metric"><span>待接受邀请</span><strong>${esc(subaccountStats.invited ?? 0)}</strong></div>
        <div class="metric"><span>已停用</span><strong>${esc(subaccountStats.suspended ?? 0)}</strong></div>
        <div class="metric"><span>已注销</span><strong>${esc(subaccountStats.retired ?? 0)}</strong></div>
      </div><div class="small muted">系统管理员只核对数量、配额和异常构成；子账户的创建、授权、停用与注销由组织管理员在组织空间处理。</div>`, {wide: true})}
      ${h.panel("治理边界", `<div class="notice">此处只处理组织启停、四类配额和初始组织管理员。子账户、项目、任务组、Agent、审核与执行数据不在系统管理空间跨组织操作。</div>`, {wide: true})}
    </div>`;
  }

  function grantRows(items, emptyText, h) {
    if (!items.length) return `<div class="notice">${esc(emptyText)}</div>`;
    return `<div class="governance-grant-list">${items.map((item) => `<div class="governance-grant-row">
      <div><strong>${esc(item.name)}</strong><div class="small muted mono">${esc(item.id)}</div></div>
      <div>${esc(item.role)}${item.statusHtml ? `<div class="small muted">${item.statusHtml}</div>` : ""}</div>${item.actionHtml ? `<div>${item.actionHtml}</div>` : ""}</div>`).join("")}</div>`;
  }

  function memberDetail({member, project, projectMemberships, taskGroupGrants, accountActionsHtml,
    projectGrantFormHtml, taskGroupGrantFormHtml, projectSelectorHtml, helpers: h}) {
    const projectItems = projectMemberships.map(({project: item, role}) => ({
      id: item.id, name: item.name || item.id, role: h.grantRoleLabel(role),
      actionHtml: h.projectLink(item, "打开项目", {page: "proj-members", workspace: "list", accountId: member.accountId})
    }));
    const groupItems = taskGroupGrants.map((grant) => ({
      id: grant.resource?.resourceId || "-", name: h.taskGroupNameOf(grant.resource?.resourceId), role: h.grantRoleLabel(grant.role),
      statusHtml: h.statusBadge("grant", grant.status)
    }));
    return `<div class="governance-object-workspace">
      ${identityHeader({eyebrow: "组织管理 / 成员", title: member.displayName || member.email || member.accountId,
        statusHtml: h.statusBadge("account", member.status), id: member.accountId,
        backAction: "close-member-detail", backLabel: "返回成员列表"})}
      <section class="governance-object-band" aria-label="成员摘要">
        <div class="metric-grid">
          <div class="metric"><span>账号类型</span><strong>${esc(h.t(member.accountType))}</strong></div>
          <div class="metric"><span>项目角色</span><strong>${projectMemberships.length}</strong></div>
          <div class="metric"><span>任务组角色</span><strong>${taskGroupGrants.length}</strong></div>
          <div class="metric"><span>额外账号能力</span><strong>${(member.permissions || []).length}</strong></div>
        </div>
      </section>
      <div class="governance-object-columns">
        ${h.panel("账号资料与生命周期", `<dl class="kv-list">
          <dt>显示名</dt><dd>${esc(member.displayName || "-")}</dd>
          <dt>登录邮箱</dt><dd>${esc(member.email || "-")}</dd>
          <dt>状态</dt><dd>${h.statusBadge("account", member.status)}${h.retiredNote(member)}</dd>
          <dt>组织角色</dt><dd>${esc((member.roles || []).map((role) => h.t(role)).join("、") || "普通成员")}</dd>
          <dt>默认项目</dt><dd>${esc(member.defaultProjectId ? h.projectNameOf(member.defaultProjectId) : "未指定")}</dd>
        </dl><div class="button-row governance-actions">${accountActionsHtml || `<span class="small muted">当前账号没有可执行的生命周期操作。</span>`}</div>`, {wide: true})}
        ${h.panel("账号能力", `<div class="record-meta">${(member.permissions || []).length
          ? (member.permissions || []).map((permission) => `<span>${esc(h.permLabel(permission))}</span>`).join("")
          : `<span>没有额外账号能力</span>`}</div>
          <div class="small muted">账号能力只决定组织层入口；项目与任务组实际权限以右侧角色授权为准。</div>`, {wide: true})}
      </div>
      ${h.panel("项目与任务组权限", `<div class="member-grant-focus"><label for="member-detail-project">当前授权项目</label>${projectSelectorHtml || `<span class="muted">当前组织没有可授权项目</span>`}</div>
        <div class="governance-permission-columns">
          <section><h3>已有项目角色</h3>${grantRows(projectItems, "尚未分配项目角色。", h)}</section>
          <section><h3>已有任务组角色</h3>${grantRows(groupItems, "尚未分配任务组角色。", h)}</section>
        </div>`, {wide: true})}
      ${project ? `<div class="governance-object-columns">
        ${h.panel(`分配项目角色 · ${esc(project.name || project.id)}`, projectGrantFormHtml, {wide: true})}
        ${h.panel(`分配任务组角色 · ${esc(project.name || project.id)}`, taskGroupGrantFormHtml, {wide: true})}
      </div>` : ""}
    </div>`;
  }

  function projectMemberDetail({project, membership, account, taskGroupGrants, roleFormHtml, taskGroupFormHtml,
    removeActionHtml, helpers: h}) {
    const isOwner = membership.role === "project_owner" || project.ownerAccountId === membership.accountId;
    const groupRows = taskGroupGrants.map((grant) => ({
      id: grant.resource?.resourceId || "-",
      name: h.taskGroupNameOf(grant.resource?.resourceId),
      role: h.grantRoleLabel(grant.role),
      statusHtml: h.statusBadge("grant", grant.status),
      actionHtml: h.canGrant
        ? `<button class="danger-button" data-action="revoke-grant" data-grant="${esc(grant.grantId)}">撤销任务组角色</button>` : ""
    }));
    return `<div class="governance-object-workspace">
      ${identityHeader({eyebrow: `项目成员 / ${project.name || project.id}`,
        title: account?.displayName || account?.email || membership.accountId,
        statusHtml: account?.status ? h.statusBadge("account", account.status) : h.customBadge("项目成员", "blue"),
        id: membership.accountId, backAction: "close-project-member-detail", backLabel: "返回项目成员列表"})}
      <section class="governance-object-band" aria-label="项目成员权限摘要">
        <div class="metric-grid">
          <div class="metric"><span>项目角色</span><strong>${esc(h.grantRoleLabel(membership.role))}</strong></div>
          <div class="metric"><span>任务组角色</span><strong>${taskGroupGrants.length}</strong></div>
          <div class="metric"><span>账号状态</span><strong>${account?.status ? h.statusBadge("account", account.status) : esc("可用")}</strong></div>
          <div class="metric"><span>成员类型</span><strong>${isOwner ? "项目负责人" : "项目成员"}</strong></div>
        </div>
      </section>
      <div class="governance-object-columns">
        ${h.panel("当前项目角色", `<dl class="kv-list">
          <dt>项目</dt><dd>${esc(project.name || project.id)}</dd>
          <dt>成员</dt><dd>${esc(account?.displayName || membership.accountId)}</dd>
          <dt>角色</dt><dd>${esc(h.grantRoleLabel(membership.role))}</dd>
          <dt>角色影响</dt><dd>${esc(h.roleImpact(membership.role))}</dd>
        </dl>${isOwner ? `<div class="notice">项目负责人是创建项目的人，不能通过普通成员授权降级或移出。</div>` : ""}
        ${removeActionHtml ? `<div class="button-row governance-actions">${removeActionHtml}</div>` : ""}`, {wide: true})}
        ${h.panel("变更项目角色", roleFormHtml, {wide: true})}
      </div>
      ${h.panel("当前任务组角色", grantRows(groupRows,
        "尚未分配任务组角色。只有需要控制、审核或观察具体任务组时才需要补充。", h), {wide: true})}
      ${h.panel("分配任务组角色", taskGroupFormHtml, {wide: true})}
    </div>`;
  }

  window.AIMAC_GOVERNANCE_WORKSPACE = {organizationDetail, memberDetail, projectMemberDetail};
})();
