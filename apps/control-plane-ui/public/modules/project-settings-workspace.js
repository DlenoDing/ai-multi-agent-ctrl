(function initProjectSettingsWorkspace(global) {
  "use strict";

  function counts(data) {
    return {
      systemRules: data.rulesLoaded ? (data.resolved.systemRules || []).length : "—",
      businessRules: data.rulesLoaded ? (data.resolved.businessRules || []).length : "—",
      roleOverlays: Number(data.roleOverlayCount || 0)
    };
  }

  function summary(project, data, h) {
    const current = counts(data);
    const archivedText = project.status === "archived"
      ? "项目已归档，设置只读"
      : "项目设置影响后续派发和产出落地；Agent 接入在独立页面管理";
    return h.panel("项目设置总览", `
      <div class="metric-grid">
        ${h.summaryMetric("仓库", data.repos.length, "代码与文档产出的 Git 落点")}
        ${h.summaryMetric("基线", data.baselineData.length, "Agent 可引用的现状材料")}
        ${h.summaryMetric("默认角色", data.defaultRoles.length, "任务组未指定时的角色回退")}
        ${h.summaryMetric("待用加入令牌", data.liveTokens, "在“项目管理”→“注册运行节点”签发和使用")}
        ${h.summaryMetric("角色定制", current.roleOverlays, "项目/任务组级 Skill 覆盖")}
        ${h.summaryMetric("系统规则", current.systemRules, "项目层生效的系统规则")}
        ${h.summaryMetric("业务规则", current.businessRules, "项目层生效的业务规则")}
      </div>
      <div class="small muted">${h.esc(archivedText)}。</div>
    `, {wide: true});
  }

  function actionBoard(project, data, h) {
    const current = counts(data);
    const ruleTone = data.rulesLoaded ? "blue" : "orange";
    return h.panel("项目设置操作看板", `
      <div class="module-grid">
        ${h.jumpModuleCard({
          title: "产出仓库", metric: `${data.repos.length}`,
          detail: data.repos.length ? "代码、文档和检查点的 Git 落点" : "未配置时产出无法落地",
          panelTitle: "项目基础配置", tone: data.repos.length ? "blue" : "red", action: "配置仓库"
        })}
        ${h.jumpModuleCard({
          title: "基线数据", metric: `${data.baselineData.length}`,
          detail: data.baselineData.length ? "Agent 可引用的现状材料" : "可选；空着不阻塞执行",
          panelTitle: "基线资料", tone: data.baselineData.length ? "blue" : "gray", action: "管理基线"
        })}
        ${h.jumpModuleCard({
          title: "默认角色", metric: `${data.defaultRoles.length}`,
          detail: data.defaultRoles.length ? "任务组未指定时的角色回退" : "空着时回退到系统内置角色",
          panelTitle: "项目默认角色", tone: data.defaultRoles.length ? "blue" : "gray", action: "管理角色"
        })}
        ${h.projectModuleCard({
          pageId: "proj-agents", title: "智能体入网",
          metric: data.agentStats.aliveNodes.length ? `${data.agentStats.onlineNodes}/${data.agentStats.aliveNodes.length}` : `${data.liveTokens}`,
          detail: data.liveTokens ? "有待用加入令牌；注册脚本只在签发成功弹窗显示" : "需要新节点时进入“注册运行节点”签发",
          tone: data.agentStats.onlineNodes ? "green" : data.liveTokens ? "blue" : "orange", action: "去接入页"
        })}
        ${h.jumpModuleCard({
          title: "角色 Skill 定制", metric: `${current.roleOverlays}`,
          detail: current.roleOverlays ? "已有项目或任务组级角色定制" : "特殊角色要求在这里配置",
          panelTitle: "角色 Skill 定制", tone: current.roleOverlays ? "orange" : "gray", action: "配置定制"
        })}
        ${h.jumpModuleCard({
          title: "系统规则", metric: `${current.systemRules}`,
          detail: data.rulesLoaded ? "项目层可停用或改写默认系统规则" : "规则配置未就绪或本次读取失败",
          panelTitle: "系统规则", tone: ruleTone, action: "查看规则"
        })}
        ${h.jumpModuleCard({
          title: "业务规则", metric: `${current.businessRules}`,
          detail: data.rulesLoaded ? "项目自己的业务约束，可被任务组覆盖" : "规则配置未就绪或本次读取失败",
          panelTitle: "业务规则", tone: ruleTone, action: "查看规则"
        })}
      </div>
      <div class="small muted">处理顺序：先确认仓库凭据、默认角色与规则；Agent 节点到“运行节点”，注册脚本到“注册运行节点”。看板只使用本页已加载数据，不额外请求接口。</div>
    `, {wide: true});
  }

  function boundaryGuide(project, data, h) {
    const current = counts(data);
    return h.panel("项目设置职责分区", `
      <div class="module-grid action-grid">
        ${h.jumpModuleCard({title: "产出与基线", metric: `${data.repos.length}/${data.baselineData.length}`,
          detail: "仓库、访问凭据和基线材料分别维护", panelTitle: "项目基础配置",
          tone: data.repos.length ? "blue" : "red", action: "看仓库"})}
        ${h.jumpModuleCard({title: "角色回退", metric: data.defaultRoles.length,
          detail: "任务组未指定角色时使用项目默认角色或系统内置角色", panelTitle: "项目默认角色",
          tone: data.defaultRoles.length ? "blue" : "gray", action: "看角色"})}
        ${h.jumpModuleCard({title: "Skill 定制", metric: current.roleOverlays,
          detail: "项目或任务组的特殊角色能力要求在“角色 Skill 定制”维护", panelTitle: "角色 Skill 定制",
          tone: current.roleOverlays ? "orange" : "gray", action: "看定制"})}
        ${h.jumpModuleCard({title: "执行规则", metric: `${current.systemRules}/${current.businessRules}`,
          detail: "系统规则管安全和流程边界，业务规则管项目约束", panelTitle: "系统规则",
          tone: data.rulesLoaded ? "blue" : "orange", action: "看规则"})}
        ${h.projectModuleCard({pageId: "proj-agents", title: "Agent 接入",
          metric: data.agentStats.aliveNodes.length ? `${data.agentStats.onlineNodes}/${data.agentStats.aliveNodes.length}` : "项目页",
          detail: "Agent 节点和远程 MCP 状态进入“运行节点”，注册脚本进入“注册运行节点”",
          tone: data.agentStats.onlineNodes ? "green" : "orange", action: "去注册"})}
      </div>
      <div class="small muted">职责分区：项目治理只维护影响派发和产出的配置；Agent 节点、一次性加入令牌、安装脚本、远程 MCP 和 Skill 工作集分别进入“运行节点”和“注册运行节点”。</div>
    `, {wide: true});
  }

  function lifecycleGuide(project, data, h) {
    const current = counts(data);
    const ruleCount = data.rulesLoaded ? Number(current.systemRules) + Number(current.businessRules) : "—";
    return h.panel("项目配置生效流程", `
      <div class="module-grid action-grid">
        ${h.jumpModuleCard({title: "1 产出落点", metric: `${data.repos.length}`,
          detail: "先配置 Git 仓库和项目级访问凭据，所有任务产出仍落到项目仓库", panelTitle: "项目基础配置",
          tone: data.repos.length ? "blue" : "red", action: "看仓库"})}
        ${h.jumpModuleCard({title: "2 角色与 Skill", metric: `${data.defaultRoles.length + current.roleOverlays}`,
          detail: "默认角色和角色 Skill 定制会进入后续派发；任务组特殊要求在详情覆盖", panelTitle: "角色 Skill 定制",
          tone: current.roleOverlays ? "orange" : "blue", action: "看定制"})}
        ${h.jumpModuleCard({title: "3 规则生效", metric: `${ruleCount}`,
          detail: data.rulesLoaded ? "系统规则守执行边界，业务规则守项目约束，任务组可继续覆盖" : "规则配置未加载，先不要提交覆盖",
          panelTitle: "系统规则", tone: data.rulesLoaded ? "blue" : "orange", action: "看规则"})}
        ${h.projectModuleCard({pageId: "tg", title: "4 创建任务组", metric: "任务组",
          detail: "配置不会替你创建任务组；新任务组会引用项目配置并继续按组设语言和角色",
          tone: "blue", action: "去任务组"})}
        ${h.projectModuleCard({pageId: "proj-agents", title: "5 Agent 执行",
          metric: data.agentStats.aliveNodes.length ? `${data.agentStats.onlineNodes}/${data.agentStats.aliveNodes.length}` : "注册",
          detail: "Agent 注册在“注册运行节点”，远程 MCP 和 Skill 工作集状态在“运行节点”",
          tone: data.agentStats.onlineNodes ? "green" : "orange", action: "看智能体"})}
        ${h.projectModuleCard({pageId: "monitor", title: "6 监控回看", metric: "实时",
          detail: "配置调整后看后续派发、事件流、模型选择和仓库产出是否按预期变化",
          tone: "blue", action: "看监控"})}
      </div>
      <div class="small muted">项目配置只影响后续派发和产出落地；已经在执行的会话按其任务契约继续回送，必要时由任务组控制或人工指令调整。</div>
    `, {wide: true});
  }

  function ruleGovernanceOverview(resolved, h) {
    const systemRules = resolved.systemRules || [];
    const businessRules = resolved.businessRules || [];
    const systemDefaultRules = systemRules.filter((rule) => String(rule.source || "").split("+").includes("default")).length;
    const systemProjectRules = systemRules.filter((rule) => h.ruleOwnedAtLayer(rule.source, "project")).length;
    const systemDisabledRules = systemRules.filter((rule) => rule.enabled === false || (rule.status && rule.status !== "active")).length;
    const systemRewrittenDefaults = systemRules.filter((rule) => {
      const source = String(rule.source || "").split("+");
      return source.includes("default") && source.includes("project");
    }).length;
    return h.panel("规则治理概览", `
      <div class="module-grid action-grid">
        ${h.summaryMetric("系统规则", systemRules.length, "执行安全、流程边界和 AI-native 纪律")}
        ${h.summaryMetric("业务规则", businessRules.length, "项目自己的业务约束，可由任务组继续覆盖")}
        ${h.summaryMetric("默认系统规则", systemDefaultRules, "来自系统内置规则集")}
        ${h.summaryMetric("项目级系统规则", systemProjectRules, "本项目新增、停用或改写的系统规则")}
        ${h.summaryMetric("已停用系统规则", systemDisabledRules, "停用后不进入后续派发")}
        ${h.summaryMetric("已改写默认规则", systemRewrittenDefaults, "默认规则在项目层已有内容覆盖")}
        ${h.jumpModuleCard({title: "系统规则明细", metric: systemRules.length,
          detail: "查看、停用或改写执行纪律和安全边界", panelTitle: "系统规则",
          tone: systemRules.length ? "blue" : "red", action: "看系统规则"})}
        ${h.jumpModuleCard({title: "业务规则明细", metric: businessRules.length,
          detail: "新增或维护项目自己的业务约束", panelTitle: "业务规则",
          tone: businessRules.length ? "blue" : "gray", action: "看业务规则"})}
      </div>
      <div class="small muted">规则治理顺序：系统规则先守执行安全、流程边界、证据和 AI-native 纪律；业务规则再表达项目业务约束；任务组特殊要求继续在任务组详情覆盖。这里是概览，完整正文和保存动作仍在对应规则栏目。</div>
    `, {wide: true});
  }

  global.AIMAC_PROJECT_SETTINGS_WORKSPACE = {summary, actionBoard, boundaryGuide, lifecycleGuide, ruleGovernanceOverview};
})(window);
