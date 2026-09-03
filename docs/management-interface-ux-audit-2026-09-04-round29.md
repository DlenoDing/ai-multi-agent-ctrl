# 第 29 轮管理界面复验与改进记录

日期：2026-09-04

## 本轮复验目标

继续从普通中文管理员的真实操作链路复验系统管理、组织管理、项目管理、Agent 注册、节点控制、执行监控和故障处置提示。重点检查“页面提示的下一步”是否真的存在对应入口和服务端动作，避免 AI-native 自动执行链路出问题时，人只能看到提示却找不到控制杆。

## 本轮发现

### P1：Agent 故障处置提示指向组织页的「刷新」，但组织级节点操作没有刷新入口

派发卡住原因 `agent_runtime_executor_required` 的中文出口提示要求组织管理员进入「组织管理」→「AI 智能体」，对节点点「刷新」以重新采集自检。后端和 Agent Runtime 已支持 `refresh_profile` 控制命令：控制面入队、Agent 长轮询取走、重新探测 profile、通过心跳回写、最终 ACK。

问题在界面层：

- 任务组详情的「运行时节点」表已有 `refresh_profile` 按钮。
- 组织级和项目级「AI 智能体」页复用的节点操作 `agentActions()` 只有暂停、恢复、关停、吊销、立即切断。
- 故障提示指向组织页，但组织页没有这个按钮，中文用户会照着提示进入正确页面后仍找不到下一步。

这不是单纯文案问题，而是节点能力重新采集的管理闭环缺失：模型执行器安装、凭据补齐、MCP 客户端配置更新之后，管理员需要一个明确、低风险、可审计的按钮触发节点重做 profile/自检。

## 改进方案

1. 在组织级和项目级 Agent 节点操作中增加「刷新自检」，下发 `refresh_profile` 控制命令。
2. 将任务组详情里的节点刷新按钮也统一命名为「刷新自检」，让同一控制动作在不同入口保持相同语义。
3. 将阻塞提示从「刷新」调整为「刷新自检」，减少与右上角页面刷新按钮混淆。
4. 行为门补充断言：组织级 Agent 页、项目级 Agent 页和项目 Agent 卡片视图都必须渲染 `data-command="refresh_profile"`。
5. 修正文档和 Agent Runtime 失败指路：join token 的常规签发入口是目标项目「项目管理」→「AI 智能体」→「注册 agent」，组织/系统页只做审计和治理。
6. 将「吊销」与「立即切断」拆成两个独立按钮项，并用行为门防止危险操作文字粘连。
7. 将执行器缺失的阻塞出口改成双路径：有项目 agent 管理权限时走当前项目「AI 智能体」点「刷新自检」；没有项目控制权时再找组织管理员进入组织页处理。

## 验证计划

- `node --check apps/control-plane-ui/public/app.js`
- `node --check apps/agent-runtime/runtime.mjs`
- `node --check scripts/console-behaviour-check.mjs`
- `node --check scripts/contract-check.mjs`
- `npm run console-behaviour-gate`
- 本地浏览器桌面/移动视口走查组织级 AI 智能体、项目级 AI 智能体、任务组详情运行时节点。
- `npm run validate`
- `npm run docker:doctor`

## 已实施结果

1. 组织级和项目级 Agent 节点操作已补齐「刷新自检」，统一下发 `refresh_profile` 控制命令。
2. 执行监控的「运行时节点」表同步使用「刷新自检」命名，避免与右上角页面刷新混淆。
3. 派发卡住原因 `agent_runtime_executor_required` 已指向真实可操作入口，并同时覆盖项目负责人和组织管理员两种权限视角。
4. 「吊销」与「立即切断」已拆成两个独立按钮项，危险操作不再粘连成一段。
5. Agent Runtime 的 join token 失败指路已统一回到目标项目「项目管理」→「AI 智能体」→「注册 agent」。
6. 行为门新增 3 类防回归：组织/项目 Agent 页必须有 `refresh_profile`，项目卡片视图必须有刷新自检，危险按钮不得显示成「吊销立即切断」。

## 已完成验证

- `node --check apps/control-plane-ui/public/app.js`：通过。
- `node --check apps/agent-runtime/runtime.mjs`：通过。
- `node --check scripts/console-behaviour-check.mjs`：通过。
- `node --check scripts/contract-check.mjs`：通过。
- `node --check scripts/mutation-gate.mjs`：通过。
- `npm run console-behaviour-gate`：590 条断言通过。
- `npm run validate`：通过，覆盖规格、变异锚点、契约、权限放置、关闭门活性、控制台行为、人机边界、系统不变式、崩溃一致性、并发写入和空转循环。
- `npm run docker:doctor`：通过，覆盖 compose 配置、镜像构建、健康检查、集中 MCP、安装脚本产物和 PostgreSQL 状态存储。首次重跑时因本地 `npm start` 占用 4317 导致 doctor 请求打到本地服务并返回 401；停止本地服务后重跑通过。
- 应用内浏览器桌面走查：系统级「账号与授权」页只显示「智能体入网审计」，无 join token 签发表单，明确提示常规注册进入目标项目。
- 应用内浏览器桌面走查：项目级「AI 智能体」页显示「项目智能体总览 → 项目智能体操作看板 → Agent 注册流程 → 项目智能体节点 → 注册 agent」；节点操作包含「刷新自检 暂停 恢复 关停 吊销 立即切断」，危险按钮已分开，无横向溢出。
- 应用内浏览器 390px 走查：项目级「AI 智能体」页无横向溢出，注册流程、远程 MCP 说明和「刷新自检」按钮可见。
- 应用内浏览器桌面走查：执行监控页仍显示控制通道与实时执行事件流，「运行时节点」入口包含「刷新自检」，无横向溢出。

## 外部互审结论

只读互审确认本轮 diff 无阻塞问题：`refresh_profile` 已在组织/项目 Agent 节点入口真实暴露，阻塞提示指向真实按钮，「吊销」与「立即切断」走不同处理路径，Agent Runtime 的 join token 失败指路已回到项目级注册入口，行为门和变异锚点同步。互审提出“项目权限用户看到组织路径可能仍需补项目路径”的残余风险，本轮已采纳为双路径提示。
