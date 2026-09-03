# 第二十六轮中文管理界面与操作路径复验

## 复验范围

- 从普通中文用户进入后台后的第一屏推演系统管理、组织管理、项目管理三条路径。
- 检查是否仍有“只有报表、没有下一步”的页面。
- 检查新增的 Agent、Skill、角色定制能力是否已经进入项目/任务组自然路径。
- 保持 AI-native 原则：人只做后台管理、入口总控、定稿和权限控制；执行、调度、MCP 和 Skill 同步仍由服务端与 Agent 自动完成。

## 当前结论

前二十五轮已经把多数高密度页面改成“总览 → 操作看板 → 明细 / 表单”的中文后台结构，并补齐项目 Agent 注册、注册脚本、任务组详情阅读路径和角色 Skill 定制入口。

本轮继续按“第一次打开能不能知道下一步”复验，发现两个仍可优化的点：

1. **组织概览仍偏只读报表**：顶部已有组织管理总览 Hub，但后续直接进入“配额用量、组织运行统计、项目一览”。普通组织管理员看完指标后，不容易按“先管成员/节点，再管项目，再进入项目空间”的顺序操作。
2. **项目操作路径文案漏掉角色 Skill 定制**：上一轮新增项目/任务组级 Skill 定制后，项目概览“配置调整”仍只写仓库、基线、默认角色、系统规则和业务规则，容易让用户以为 Skill 定制不属于项目配置链路。

## 优化方案

1. 在组织概览页增加“组织操作路径”面板，放在组织管理总览之后、配额用量之前：
   - “1 成员与权限”：进入成员管理。
   - “2 Agent 节点”：进入组织 AI 智能体管理。
   - “3 项目与授权”：进入组织项目列表和授权。
   - “4 项目执行”：进入当前项目空间。
2. 在组织项目表增加“操作”列，提供“进入项目”和“项目授权”两个明确按钮，避免项目列表只读。
3. 更新项目概览“配置调整”文案，把角色 Skill 定制纳入项目设置说明。
4. 增加行为门断言，要求组织概览必须先显示组织操作路径，再显示配额和项目表，并要求项目表具备图形化操作按钮。

## 验证计划

- `node --check apps/control-plane-ui/public/app.js`
- `node --check scripts/console-behaviour-check.mjs`
- `npm run console-behaviour-gate`
- `npm run validate`
- `npm run docker:doctor`
- 本地浏览器桌面和 390px 移动端走查组织概览、项目概览，确认新增路径和按钮可见、无横向溢出、无浏览器 error/warn。

## 已实施

1. 组织概览页已新增“组织操作路径”面板，按中文管理顺序串起成员权限、Agent 节点、项目授权和项目执行四个入口。
2. 组织概览“项目一览”已增加“操作”列，项目行可直接进入目标项目或跳到项目授权入口。
3. 新增 `open-project-page` 点击动作，先切换 `currentProjectId`，再跳到目标页面，避免多项目时打开上一个项目。
4. 项目概览“配置调整”说明已补上角色 Skill 定制，和项目设置页新增能力保持一致。
5. `console-behaviour-gate` 已增加组织概览顺序、入口覆盖、项目表动作和项目切换处理器断言。

## 二次推演修正

按钮事件路径复验发现：项目表按钮如果同时带 `data-action` 和 `data-menu`，会先被通用菜单点击处理器截走，导致 `open-project-page` 不能先切换 `currentProjectId`。已将按钮目标页字段改为 `data-target-menu`，点击只进入 `open-project-page` 分支，再由该分支完成“切项目 → 跳页 → 加载”的完整流程。

## 快速验证

- `node --check apps/control-plane-ui/public/app.js`：通过。
- `node --check scripts/console-behaviour-check.mjs`：通过。
- `npm run console-behaviour-gate`：通过，585 条断言全部通过。

## 三次视觉与交互走查修正

本轮在本地浏览器真实登录后，继续按桌面和 390px 移动端复验系统管理、项目管理和 Agent 注册路径：

- 系统管理首屏已明确分成“系统概览 / 组织管理 / 系统设置 / 账号与授权”，项目操作不再混在系统运行指标里。
- 项目管理首屏已明确分成“项目概览 / AI 智能体 / 任务组 / 执行监控 / 人工审核 / 人工指令 / 项目设置”，Agent 注册不再藏在项目设置里。
- “账号与授权”里的“项目 Agent 注册”跨区入口可正确切到项目侧“AI 智能体”页，并保留当前项目上下文。
- 项目“AI 智能体”页已能直接看到注册流程、节点列表、待用加入令牌、异常节点、一次性命令只显示一次、服务端集中 MCP 与 Skill 同步、agent 端轻量 bootstrap 的说明。
- 390px 移动端未撑开 `body` 或 `documentElement` 宽度；横向导航和宽表停留在局部滚动区域内，整体页面不产生全局横向滚动。

浏览器日志复验发现 4 个真实漏译警告：`gateway`、`filesystem`、`git`、`remote_mcp`。这些值来自运行时健康检查标签，属于页面当前会碰到的枚举值。已补齐中文映射，并把它们加入 `console-behaviour-gate`，防止以后只在浏览器控制台才发现。

## 完整验证

- `node --check apps/control-plane-ui/public/i18n-zh.js`：通过。
- `node --check apps/control-plane-ui/public/app.js`：通过。
- `node --check scripts/console-behaviour-check.mjs`：通过。
- `npm run console-behaviour-gate`：通过，586 条断言全部通过。
- `npm run validate`：通过，规格、契约、权限、人机边界、MCP、实时事件、崩溃一致性、并发写入、空转不落盘等门全部通过。
- `npm run docker:doctor`：通过，Compose、镜像构建、健康检查、集中式 MCP、安装器产物和 PostgreSQL 状态存储通过。
- 本地浏览器桌面 / 390px 移动端走查：系统/项目入口清晰，Agent 注册入口可达，冷启动新标签无 warn/error。
