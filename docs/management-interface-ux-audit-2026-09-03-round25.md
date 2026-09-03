# 第二十五轮管理界面与功能闭环复验

## 复验范围

- 系统管理与项目管理是否继续保持分离，不把项目 agent 入网、任务组控制等操作塞回系统设置。
- 项目、任务组、Agent、Skill、角色定制等关键能力是否都有自然的中文图形化入口。
- 高并发与高流量场景下，新增界面能力是否避免把大对象反复下发。
- AI-native 执行链路是否保持：服务端集中管理 MCP、Skill 和调度，Agent 端只注册、自检、执行和回送状态。

## 当前结论

前二十四轮已经补齐系统/项目空间分离、项目 AI 智能体页、一次性 join token、注册脚本、任务组详情阅读路径、实时事件查看、规则编辑折叠和系统设置操作看板。继续从“能力是否只能 API 操作”角度复验后，发现仍有一个管理闭环缺口：

1. 后端已实现 `/api/role-skill-overlays`，可创建项目级或任务组级 role skill overlay，并会进入 Skill Registry、任务契约和 Agent 下发工作集。
2. 系统设置页只读展示“角色技能叠加”，且文字说明“由人经 API 创建，控制台只读”。
3. 这与目标要求不一致：项目维度或任务组维度应能重新设置或修改角色 Skill，以满足特殊需求；普通中文用户不应离开管理界面去构造 API 请求。
4. 角色 Skill 正文体积较大，不能为了下拉选择把 `roleSkills` 正文放进 5 秒轮询视图；应使用轻量摘要索引。

## 优化方案

1. `/api/skill-registry` 增加 `roleSkillIndex`，只下发 `roleSkillId/sourceId/sourcePath/name/category/status/capabilities` 等摘要，不下发正文。
2. 项目设置页增加“角色 Skill 定制”模块：
   - 展示当前项目内生效的 overlay。
   - 提供项目级 overlay 创建表单。
   - 在操作看板和职责分区里显示入口与数量。
3. 任务组详情增加“本任务组角色 Skill 定制”模块：
   - 展示项目级继承和任务组级生效 overlay。
   - 提供任务组级 overlay 创建表单。
4. 表单用中文字段表达能力放开、能力禁用、附加说明引用和模型要求补丁引用，提交时转换为既有 `patch` 结构。
5. 控制台仍不新增本地文件管理、不在 Agent 端安装 MCP 服务；overlay 由服务端持久化，下一次任务契约构建时同步到 Agent。

## 预期验证

- `node --check apps/control-plane-ui/public/app.js`
- `node --check apps/control-plane-ui/server.mjs`
- `npm run console-behaviour-gate`
- `npm run validate`
- `npm run docker:doctor`
- 本地浏览器走查项目设置和任务组详情，确认入口可见、文案清晰、无横向溢出。

## 已实施

1. `/api/skill-registry` 已增加 `roleSkillIndex`，只返回角色 Skill 摘要索引，不返回正文。
2. 项目设置页已增加“角色 Skill 定制”：
   - 总览增加“角色定制”指标。
   - 操作看板和职责分区增加“角色 Skill 定制”跳转卡片。
   - 页面主体展示当前项目下生效 overlay，并提供项目级 overlay 创建表单。
3. 任务组详情已增加“本任务组角色 Skill 定制”：
   - 同时展示项目级继承和任务组级生效 overlay。
   - 提供任务组级 overlay 创建表单。
4. 系统设置页仍只做全局只读追踪，但文案已改为指向项目设置或任务组详情，不再提示只能经 API 创建。
5. `console-behaviour-gate` 已增加断言，覆盖项目设置入口、任务组详情入口和 overlay 提交路径。

## 快速验证

- `node --check apps/control-plane-ui/public/app.js`：通过。
- `node --check apps/control-plane-ui/server.mjs`：通过。
- `node --check scripts/console-behaviour-check.mjs`：通过。
- `npm run console-behaviour-gate`：通过，580 条断言全部通过。
