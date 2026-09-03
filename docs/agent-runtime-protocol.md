# Agent Runtime 协议

## 1. 目标

Agent Runtime 是公网或内网 Agent 节点上的轻量执行进程，负责节点入网、心跳、资源/模型/工具探测、远程 MCP 访问、dispatch claim、按任务同步 Skill 工作集、模型 Agent 启动、checkpoint 提交和断线恢复。MCP server、Agent Gateway、Skill Registry、Scheduler、Policy Engine、数据库和管理服务全部集中运行在系统服务器；Agent 主机禁止启动本地 MCP server。

Runtime 不是无限远程 shell。所有副作用都必须由控制平面授权，并绑定 project、taskGroup、work、session、command、lease 和 audit。Runtime 的所有控制入口都面向 AI Agent 和系统服务，不依赖非系统执行路径处理项目工作。

## 2. 自动加入流程

系统管理员或具有项目 `agent:activate` 权限的账号登录管理界面，在目标项目的「项目管理」→「项目设置」→「智能体接入」中生成一次性 join token。join token 必须绑定 project、expected node、allowed roles、MCP tool allowlist、ttl、maxUses 和创建者审计记录；管理界面返回 direct/verified 两条加入命令。常规 Agent 入网不得要求用户在服务器命令行单独执行 token 生成脚本。

受信执行环境的自动加入命令模板：

```bash
umask 077; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT HUP INT TERM; \
cat > "$tmp/aimac.join" <<'AIMAC_JOIN_TOKEN'
<one_time_join_token>
AIMAC_JOIN_TOKEN
curl -fsSL https://control.example.com/install-agent.sh | sh -s -- \
  --server https://control.example.com \
  --join-token-file "$tmp/aimac.join" \
  --node-name "$(hostname)" \
  --work-dir "$HOME/.local/share/aimac-agent"
```

高信任要求环境必须使用校验版：

```bash
umask 077; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT HUP INT TERM; \
cat > "$tmp/aimac.join" <<'AIMAC_JOIN_TOKEN'
<one_time_join_token>
AIMAC_JOIN_TOKEN
cd "$tmp" && \
curl -fsSLO https://control.example.com/install-agent.sh && \
curl -fsSLO https://control.example.com/install-agent.sh.sha256 && \
( if command -v sha256sum >/dev/null 2>&1; then sha256sum -c install-agent.sh.sha256; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -c install-agent.sh.sha256; else printf '%s\n' 'sha256sum or shasum is required' >&2; exit 1; fi ) || { printf '%s\n' '安装脚本校验失败：下载可能被篡改或不完整 —— 别继续装；重新执行这条命令，仍失败就找控制面管理员' >&2; exit 1; } && \
sh install-agent.sh \
  --server https://control.example.com \
  --join-token-file "$tmp/aimac.join" \
  --node-name "$(hostname)" \
  --work-dir "$HOME/.local/share/aimac-agent"
```

全部参数（`sh install-agent.sh --help` 之外，这里是完整清单）：

| 参数 | 作用 |
| --- | --- |
| `--server` | 控制面地址 |
| `--join-token` / `--join-token-file` | 一次性入网令牌（优先用 `--join-token-file`，命令行参数会进 shell 历史与进程列表） |
| `--node-name` | 节点名，默认 `hostname` |
| `--work-dir` | 节点数据根目录 |
| `--roles` | 这个节点承接哪些角色（逗号分隔），不给则由控制面按派发决定 |
| `--executor-command` | **自定义模型执行器命令**。不给时节点自动探测 `codex` / `claude` / `gemini` / `ollama` 四个命令；四个都没有、也没给这个参数，节点就没有可用执行器 —— 派发会卡在 `agent_runtime_executor_required`，控制台上那条阻塞提示写的也是这句 |
| `--configure-clients` / `--no-configure-clients` | 是否改写这台机器上 codex/claude/cursor 的 MCP 客户端配置（项目级） |
| `--configure-global-clients` / `--no-configure-global-clients` | 同上，但改写用户全局配置 |
| `--no-daemon` | 只安装、不起常驻进程 |

## 让它常驻（开机自启 + 崩了自动重启）

安装脚本用 `nohup` 起进程，**宿主重启或它自己崩掉之后不会回来**。节点一失联，排给它的活就停在队列里
（控制台上那个节点会显示没有心跳，但不会有人被主动通知）。要常驻，用系统自带的服务管理器 ——
安装脚本有意不碰它们（不用 sudo、不改任何系统文件）。常驻进程应由部署编排或系统外管理员策略安装；
Agent 注册脚本只完成入网、初始化、自检和可选客户端配置。

Linux（systemd 用户级，不需要 root）：

```ini
# ~/.config/systemd/user/aimac-agent.service
[Unit]
Description=AIMAC Agent Runtime
After=network-online.target

[Service]
ExecStart=/usr/bin/env node %h/.local/share/aimac-agent/bin/aimac-agent-runtime.mjs run --work-dir %h/.local/share/aimac-agent
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now aimac-agent
loginctl enable-linger "$USER"   # 没有这一句，用户登出之后服务会被停掉
```

macOS（launchd 用户级）：

```xml
<!-- ~/Library/LaunchAgents/local.aimac.agent.plist -->
<plist version="1.0"><dict>
  <key>Label</key><string>local.aimac.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string><string>node</string>
    <string>/Users/YOU/.local/share/aimac-agent/bin/aimac-agent-runtime.mjs</string>
    <string>run</string><string>--work-dir</string>
    <string>/Users/YOU/.local/share/aimac-agent</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
</dict></plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.aimac.agent.plist
```

加入成功回显：

```text
AGENT_JOINED
nodeId=node_...
nodeName=...
agentProfileDigest=sha256:...
schedulerAdmission=read_only|limited|full
remoteMcp=https://control.example.com/mcp
skills=on_demand
已接入控制面 https://control.example.com（节点 ...）。下一步：agentctl run 让这台节点开始领活；agentctl status 随时看它的状态；要装成常驻服务见 docs/agent-runtime-protocol.md
```

## 3. 初始化握手

```text
install_runtime
-> node_register
-> resource_probe
-> model_probe
-> tool_probe
-> remote_mcp_initialize
-> local_cache_init
-> self_check
-> scheduler_admission
```

### 3.1 node_register

`runtimeVersion` 必须不低于 **0.3.0**（控制平面里的 `REQUIRED_AGENT_RUNTIME_VERSION`）。
低于它、或者版本号读不出来（缺失、空串、`0.3` 这种位数不够的），控制平面会把这个节点标记为
「运行时版本过旧」并在控制台上提示运维升级 —— 因为 0.3.0 才引入**带认领代次提交**这条契约：
更早的实现不发 `claimEpoch`，它的派发一旦被重新认领，提交就会卡在 `checkpoint_claim_epoch_required`，
那一轮的活白干。控制平面不会因此拒绝注册或不派活，但那台机器随时可能白跑一轮。

请求：

```json
{
  "nodeName": "builder-01",
  "runtimeVersion": "0.3.0",
  "profile": {
    "platform": "darwin",
    "arch": "arm64",
    "cpuCount": 12,
    "memoryBytes": 34359738368,
    "tools": [],
    "models": []
  }
}
```

响应：

```json
{
  "node": {
    "nodeId": "node_...",
    "projectIds": ["prj_..."],
    "allowedRoles": ["backend", "reviewer"]
  },
  "nodeToken": "aimac_node_...",
  "gateway": {
    "serverUrl": "https://control.example.com",
    "mcpUrl": "https://control.example.com/mcp",
    "skillWorksetBaseUrl": "https://control.example.com/api/agent/v1/skill-worksets"
  },
  "heartbeatIntervalSeconds": 30,
  "pollIntervalSeconds": 5
}
```

### 3.2 probe payload

Runtime 必须上报：

| 类别 | 字段 |
| --- | --- |
| resource | cpu、memory、disk、load、network、docker、browser、workspace |
| model | provider、modelId、alias、reasoningLevels、contextWindow、speed、quality、quotaState |
| tool | shell、git、node、npm、docker、Codex、Claude、Gemini、Ollama 等本机执行工具；不包含本地 MCP server |
| permission | OS、browser、credential helper、OAuth、network、Git、DB、Keychain/sudo |
| integrity | runtime digest、installer digest、config digest、sandbox mode |

### 3.3 remote MCP client config

安装脚本和 Runtime 必须在 Agent 工作目录下自动生成并持续维护：

```text
$AIMAC_AGENT_WORK_DIR/mcp-client-configs/mcp-server.json
$AIMAC_AGENT_WORK_DIR/mcp-client-configs/codex_config.toml
$AIMAC_AGENT_WORK_DIR/mcp-client-configs/claude_desktop_config.json
$AIMAC_AGENT_WORK_DIR/mcp-client-configs/cursor_mcp.json
```

这些配置只指向控制平面公网 `/mcp` Streamable HTTP endpoint，并携带服务端签发的 node token。node token 轮换后 Runtime 必须刷新这些文件。默认不得改写 Agent 主机上的 Codex/Claude/Cursor 用户全局配置；只有安装命令显式携带 `--configure-global-clients` 时，才把同一远程 MCP endpoint 合并到全局客户端配置。Agent 主机禁止安装或启动本地 MCP server。

## 4. 心跳协议

Runtime 每 10 到 30 秒发送 heartbeat。控制平面可按项目策略调整频率。

```json
{
  "nodeId": "agent_...",
  "sequence": 128,
  "status": "online",
  "activeSessions": ["sess_..."],
  "resourceDelta": {
    "cpuLoad": 0.42,
    "memoryFreeMb": 8192,
    "diskFreeMb": 120000
  },
  "outboxBacklog": 0,
  "lastRoomCursor": {
    "room_...": 120
  },
  "capturedAt": "2026-07-23T08:00:00Z"
}
```

控制平面响应：

```json
{
  "accepted": true,
  "serverTime": "2026-07-23T08:00:01Z",
  "commandsAvailable": true,
  "minRuntimeVersion": "1.0.0",
  "requestedProbes": ["resource", "permission"]
}
```

### 4.1 实时控制通道

服务端不反连 Agent 主机。Runtime 使用 node token 长轮询控制面：

```text
GET /api/agent/v1/control?afterSequence=<cursor>&waitMs=25000
POST /api/agent/v1/control/:commandId/ack
```

控制命令是持久化 `AgentControlCommand`，绑定 node、project、taskGroup、session、dispatch 和 idempotency。支持 `refresh_profile`、`pause_dispatch`、`cancel_dispatch`、`resume_dispatch`、`shutdown`、`revoke`。命令被 Runtime 拉取后进入 `delivered`；Runtime 必须先 ACK `received`，然后执行命令副作用，最终 ACK `completed`、`failed` 或 `rejected`。对 pause/cancel/revoke/shutdown，服务端在入队时先冻结 dispatch/session/work item 并撤销 dispatch MCP grant，Runtime 侧仍必须终止执行器进程组，确认停止后再完成 ACK；只有收到完成 ACK 后服务端才释放重派，失败或拒绝 ACK 会保持节点隔离并排队控制重试。断线恢复时从上次 cursor 重放未确认命令。

### 4.2 执行过程事件流

Runtime 不能等到最终 checkpoint 才回送结果。每个 dispatch 执行过程中必须持续提交 `AgentExecutionEvent`：

```text
POST /api/agent/v1/events
GET /api/agent-dispatches/:dispatchId/events?afterSequence=<cursor>&waitMs=25000
GET /api/task-groups/:taskGroupId/execution-events?afterSequence=<cursor>&waitMs=25000
```

事件覆盖 `dispatch_received`、`skill_synced`、`executor_started`、`executor_output`、`repository_changed`、`git_committed`、`git_pushed`、`checkpoint_prepared`、`checkpoint_submitted`、`blocked`、`drift_signal`、`failed`、`heartbeat`（长任务的保活心跳，带 `progressPercent: 0`）。事件只提交阶段、摘要、进度、digest、`eventKey` 和 evidence refs，不上传大段原始 stdout；`eventKey` 是必填幂等键，持久去重作用域为 `dispatchId + eventKey`。服务端把完整事件追加到 `.runtime/project-db/p_<projectId_sha256>.execution-events.jsonl` 当前段，超过阈值后轮转为 `.runtime/project-db/p_<projectId_sha256>.execution-events.<firstSeq>-<lastSeq>.<sealedAt>.jsonl`，并维护 `.execution-events.manifest.json`、按 `dispatchId + eventKey` 作用域的 KV 索引和 tail-window 读取；旧 eventKey-only 索引首次触碰项目时会在项目事件锁内重建为 v5。中央 state 只保留最近轻量索引和进度摘要，并在 CAS 冲突时重读最新状态重放事件投影。管理界面默认展示汇总，点击任务组详情、work session 或 dispatch 后长轮询项目级事件库。

## 5. dispatch 与 Skill 工作集

控制平面启动 session 时必须传最小任务契约。

```json
{
  "contractVersion": "agent-task-contract/v1",
  "commandId": "cmd_...",
  "sessionId": "sess_...",
  "runId": "run_...",
  "idempotencyKey": "session-start-work-1-run-1",
  "protocolVersion": "agent-runtime/v1",
  "schemaDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "contractDigest": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  "issuedAt": "2026-07-23T08:00:00Z",
  "expiresAt": "2026-07-23T09:00:00Z",
  "projectId": "prj_...",
  "taskGroupId": "tg_...",
  "taskId": "task_...",
  "workId": "work_...",
  "roleId": "backend-owner",
  "roleSkill": {
    "roleSkillRef": "role-skill://agency-agents-zh/engineering/backend-owner",
    "roleSkillDigest": "sha256:7777777777777777777777777777777777777777777777777777777777777777",
    "selectedAgentSkillRef": "agent-skill://backend-owner/runtime",
    "sourceId": "agency-agents-zh",
    "overlayRefs": ["role-skill-overlay://overlay_..."],
    "worksetId": "skillset_0123456789abcdef01234567",
    "synchronizationMode": "server_managed_on_demand",
    "usageDirective": "Load this exact workset before execution and bind a separately issued workset for every child role.",
    "modelSelectionDecisionRef": "model-selection://msd_..."
  },
  "roomId": "room_...",
  "placementDecisionRef": "session-placement://spd_...",
  "stateVersion": 12,
  "rulesetDigest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  "effectiveInstructionPacketRef": "effective-instruction://eip_...",
  "actionBasis": {
    "effectiveInstructionPacketRef": "effective-instruction://eip_...",
    "sourceKind": "orchestrator_plan",
    "sourceRef": "decision://dr_...",
    "nextActionDraftDigest": "sha256:8888888888888888888888888888888888888888888888888888888888888888",
    "activeRuleRefs": ["ruleset://rule_..."],
    "nonActiveMaterialRefs": [{"materialRef": "review://advisory_...", "classification": "advisory"}],
    "contextIntakeRefs": ["context-intake://ci_..."],
    "validationRequirements": ["unit", "contract", "independent_review"],
    "forbiddenActions": ["rewrite_role_mission", "expand_scope_without_decision"],
    "deferredDecisions": []
  },
  "roleFocus": {
    "roleDriftGuardRef": "role-drift-guard://rdg_...",
    "objectiveBoundaryDigest": "sha256:9999999999999999999999999999999999999999999999999999999999999999",
    "roleMissionDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "taskContractDigest": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "allowedActionScopeRefs": ["scope://allowed/backend-owner/work-1"],
    "forbiddenActionScopeRefs": ["scope://forbidden/backend-owner/work-1"],
    "maxAllowedDriftScore": 0.1
  },
  "inputLocators": ["repo://service/path", "doc://..."],
  "inputDigests": {
    "rules": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    "contract": "sha256:2222222222222222222222222222222222222222222222222222222222222222"
  },
  "readScope": [
    {
      "access": "read",
      "resourceType": "repo_path",
      "resourceKey": "service/src"
    }
  ],
  "writeScope": [
    {
      "access": "write",
      "resourceType": "file_path",
      "resourceKey": "service/src/foo.ts",
      "leaseId": "lease_...",
      "fencingToken": 77,
      "leaseExpiresAt": "2026-07-23T09:00:00Z",
      "resourceDigestBefore": "git-tree:abc123"
    }
  ],
  "mcpGrants": [
    {
      "grantId": "grant_...",
      "projectId": "prj_...",
      "taskGroupId": "tg_...",
      "workId": "work_...",
      "sessionId": "sess_...",
      "agentNodeId": "agent_...",
      "serverId": "resource-mcp",
      "toolName": "lease_release",
      "resource": "lease:lease_...",
      "action": "release",
      "schemaDigest": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      "policyDecisionRef": "policy-decision://pd_...",
      "approvalRequestRef": "approval://not-required/pd_...",
      "paramPolicyRef": "policy://mcp/lease-release/work-1",
      "paramPolicyDigest": "sha256:5555555555555555555555555555555555555555555555555555555555555555",
      "resultFilterRef": "filter://mcp/default-redaction",
      "resultFilterDigest": "sha256:6666666666666666666666666666666666666666666666666666666666666666",
      "leaseRef": "lease://lease_...",
      "idempotencyKey": "mcp-lease-release-work-1-run-1",
      "riskLevel": "L1",
      "issuedAt": "2026-07-23T08:00:00Z",
      "expiresAt": "2026-07-23T09:00:00Z",
      "maxTtl": "PT1H",
      "grantStatus": "issued",
      "revocationRef": "revoke://grant/grant_...",
      "auditRef": "audit://grant/grant_...",
      "grantDigest": "sha256:4444444444444444444444444444444444444444444444444444444444444444"
    }
  ],
	  "model": {
	    "model": "provider/model",
    "modelId": "provider/model",
    "alias": "balanced",
    "providerClass": "openai|anthropic|google|xai|deepseek|qwen|ollama|custom",
    "taskExecutionClass": "deep_analysis|implementation|verification|short_execution|mixed_analysis_implementation",
    "reasoning": "medium",
    "reasoningLevel": "medium",
    "modelDecision": "modelDecision: fixed writeSet implementation; no architecture裁决 -> provider/model / medium",
	    "selectionMode": "auto_best",
	    "modelSelectionDecisionRef": "model-selection://msd_..."
	  },
	  "languagePolicy": {
	    "schemaVersion": "language-policy/v1",
	    "languageTag": "zh-CN",
	    "languageName": "Chinese",
	    "scope": ["role_interaction", "dispatch_instruction", "room_message", "execution_event", "checkpoint", "repository_output", "review_material"],
	    "enforcement": "required",
	    "fallback": "return_blocked_for_language_mismatch"
	  },
	  "languagePolicyDigest": "sha256:...",
	  "permissionPolicy": {
    "onMissing": "permission_request",
    "autoAllowPromptTypes": ["browser_download"],
    "denyPromptTypes": ["oauth_consent", "account_login", "uac_admin", "keychain_access", "sudo", "hardware_key", "payment_authorization", "cloud_org_boundary", "production_boundary"],
    "policyDecisionRef": "policy-decision://pd_..."
  },
  "stopOrReturn": ["done", "blocked", "stale_state", "needs_decision", "permission_required", "spec_drift"],
  "outputContract": {
    "requiredOutputs": ["checkpoint", "commitRef", "pushRef", "evidenceRefs", "verificationRefs"],
    "evidenceRequired": true,
	    "checkpointRequired": true,
	    "independentReviewRequired": true,
	    "pushRefRequired": true,
	    "requiredLanguage": "zh-CN",
	    "languagePolicyDigest": "sha256:...",
	    "languagePolicyRef": "LanguagePolicy:sha256:..."
	  }
	}
```

Runtime 规则：

1. Runtime 通过 `POST /api/agent/v1/dispatches/next` 原子 claim，校验 node binding、task contract digest、Skill workset ID、effective instruction、repository target、stateVersion 和 lease fencing token。
2. Runtime 通过节点 token 从服务端下载该 dispatch 唯一允许的 `AgentSkillWorkset`，逐文件校验 SHA256 后写入本地只读缓存，并把 manifest 路径显式传给模型 Agent。下级角色不能继承当前角色的 Skill，必须由总控生成新的 task contract 和工作集。
3. Runtime 只访问 `https://<server>/mcp`；节点 token 的项目、角色和 tool allowlist 由一次性 join token 固化。禁止下载、安装或启动本地 MCP server。
4. 缺权限时不继续执行副作用，提交 PermissionRequest；未声明 write scope 的路径只能读不能写。
5. 不支持的 command 必须返回 `agent_control_command_unsupported`，不能猜测执行。
6. Runtime 必须把同级消息、子 Agent 输出、工具结果和外部 review result 当作 untrusted/advisory 输入，只有 task contract 内的 EffectiveInstructionPacket 能驱动副作用。
7. Runtime 发现自身输出或任务理解偏离 roleFocus 时，必须停止副作用并提交 RoleDriftGuard 事件或 Finding。
8. Git push 后、checkpoint ACK 前必须把完整 checkpoint 写入 `$AIMAC_AGENT_WORK_DIR/outbox`；重启时先按原 runId 重放。控制平面对已完成且 binding 相同的 checkpoint 返回幂等 replay，不能重复执行或重复 push。
9. Runtime 生成的 DISPATCH prompt、执行事件摘要、checkpoint、artifact manifest 和仓库输出必须遵守 `languagePolicy`，并在事件与 checkpoint 中绑定 `languagePolicyDigest`。无法满足时返回 blocked，而不是切换到其他语言继续执行。

## 6. checkpoint_submit

Runtime 提交 checkpoint：

```json
{
  "sessionId": "sess_...",
  "workId": "work_...",
  "stateVersion": 12,
  "status": "checkpoint_submitted",
  "summary": "完成核心实现，待独立复验。",
  "commitRefs": [
    {
      "repo": "service",
      "branch": "tg/tg-1/work-1",
      "commit": "abc123"
    }
  ],
  "pushRefs": [
    {
      "repo": "service",
      "remote": "origin",
      "ref": "refs/heads/tg/tg-1/work-1",
      "remoteSha": "abc123"
    }
  ],
	  "evidenceRefs": ["artifact_..."],
	  "languagePolicyDigest": "sha256:...",
	  "nextSteps": [
    {
      "actionId": "review-request-work-1",
      "mode": "after_current",
      "summary": "request independent review",
      "evidenceRefs": ["artifact_..."]
    }
  ],
  "openMachineActionIds": [],
  "derivedWorkRequests": [],
  "returnPointRef": "return://work-1/checkpoint-1"
}
```

控制平面返回新 stateVersion。Runtime 必须保存 ACK。

## 7. evidence_artifact_register

Evidence/artifact 登记分两步。该流程只用于日志、截图、测试报告、HAR、trace、DB dump 摘要和 artifact manifest 等证据，不用于保存项目交付文件。项目任务产出文件必须写入 `RepositoryOutputTarget` 指定的 Git 仓库、分支和路径。

```text
artifact_prepare -> register locator/digest -> artifact_commit
```

登记前 Runtime 必须做基础脱敏：

1. authorization header。
2. cookie。
3. token、secret、private key。
4. 生产用户敏感数据。
5. 内部高敏 URL。

`artifact_commit` payload：

```json
{
  "runId": "run_...",
  "type": "test_report",
  "uri": "artifact://prj/tg/run/test_report/sha256...",
  "digest": "sha256:...",
  "sizeBytes": 12000,
  "sensitivity": "internal",
  "metadata": {
    "command": "npm test",
    "exitCode": 0
  }
}
```

## 8. permission_report

Runtime 捕获权限阻断后提交：

```json
{
  "projectId": "prj_...",
  "taskGroupId": "tg_...",
  "workItemId": "work_...",
  "sessionId": "sess_...",
  "agentNodeId": "agent_...",
  "promptType": "oauth_login_required",
  "requestedCapability": "github_push",
  "requestedResource": "repo:org/service",
  "riskLevel": "L2",
  "artifactRef": "artifact_screenshot_or_log",
  "safeRetryPoint": {
    "commandId": "cmd_...",
    "step": "before_git_push",
    "sideEffectsPaused": true
  },
  "suggestedActions": ["grant_credential", "capability_exchange_required", "reassign", "abort"]
}
```

Runtime 进入 `permission_required`，只允许继续上传日志、截图、checkpoint 和 outbox。

收到 `permission_resolution` 后：

| resolution | Runtime 行为 |
| --- | --- |
| grant_issued | 刷新 profile，从 safe retry point 重试 |
| external_capability_available | 重新 probe，对比外部能力变化后重试 |
| reassign | 停止当前 session，提交 handoff checkpoint |
| rejected | 标记 work blocked 或 aborted |
| scope_reduced | 重新读取 work contract 后继续 |

## 9. 断线恢复

轻量 Runtime 的本地持久状态位于权限为 `0600` 的配置和 JSON outbox；它不运行数据库服务：

| 表 | 用途 |
| --- | --- |
| `agent-config.json` | server URL、node ID、节点 token、目录和 executor adapter |
| `skill-worksets/<digest>` | 当前任务实际使用的最小 Skill 文件和 manifest 缓存 |
| `repositories/<repositoryId>` | 被 dispatch 授权的项目 Git checkout |
| `tasks/<dispatchId>` | task contract、有效指令包和模型执行 prompt |
| `outbox/<dispatchId>.json` | push 已完成但尚未得到控制平面 ACK 的 checkpoint |

恢复流程：

```text
runtime_start
-> load agent-config and checkpoint outbox
-> heartbeat reconnect
-> replay checkpoint outbox by runId/commit
-> claim queued or expired dispatch
-> continue|stale_state|recover_required
```

如果崩溃发生在 Git push 成功但 checkpoint ACK 之前，Runtime 必须先读取远端 ref，确认 `remoteSha`、`providerOperationId` 和 `CommandEffect`。已成功副作用只能补交 checkpoint 或 command effect，不能重复 push；远端状态不一致时进入 `recover_required`，由 Command Bus 决定 retry、compensate 或 DLQ。

## 10. 安全边界

1. Runtime 不持有长期项目密钥，只持有短期 token 或 credential helper 引用。
2. Worker Session 与 Control Agent 分离。
3. session 结束、取消或隔离时清理临时凭据、临时文件、子进程和 shell history。
4. 默认不允许访问其它项目目录、全局 SSH key、宿主敏感路径和未授权网络。
5. 默认不自动批准 OS、Keychain、sudo、UAC、Screen Recording、Accessibility 权限弹窗；这些场景只能建模为外部能力边界、预授权能力、改派或中止。
6. 所有 command、MCP 写操作、Git 写操作和权限处理都必须进入 audit。

## 11. 节点环境变量

节点侧的旋钮都是环境变量（部分也有同名命令行参数，参数优先）。控制面侧的旋钮见仓库 README 的环境变量表。

### 11.1 接入

| 变量 | 默认 | 它决定什么 | 改错了的表现 |
| --- | --- | --- | --- |
| `AIMAC_AGENT_JOIN_TOKEN` | 无 | 一次性入网令牌（也可用 `--join-token`） | 没给就无法注册 |
| `AIMAC_AGENT_NODE_NAME` | 主机名 | 节点名（也可用 `--node-name`）；票上指定了名字时必须一致 | 不一致被拒：join_token_node_name_mismatch |
| `AIMAC_AGENT_REGION` | 无 | 上报给控制面的地区标签，只用于展示 | — |
| `AIMAC_AGENT_DATA_ROOT` / `AIMAC_AGENT_WORK_DIR` | 平台默认数据目录 | 节点工作根目录（也可用 `--work-dir`）：配置、仓库、技能缓存、任务目录、发件箱都在它之下 | 换目录等于换了一台节点 |
| `AIMAC_AGENT_CONFIGURE_CLIENTS` | `false` | 注册后把远程 MCP 配置写进本机 codex / claude / cursor 的配置文件 | 开了会改用户自己的配置文件（原子写） |
| `AIMAC_AGENT_CONFIGURE_GLOBAL_CLIENTS` | `false` | 同上，但写全局配置而非项目级 | 同上 |
| `AIMAC_AGENT_ALLOW_INSECURE_HTTP` | `false` | 允许用 http 连非本机控制面 | 节点凭据明文走网络 |

### 11.2 执行

| 变量 | 默认 | 它决定什么 | 改错了的表现 |
| --- | --- | --- | --- |
| `AIMAC_AGENT_EXECUTOR_COMMAND` | 按本机可用的 CLI 自动选 | 模型执行器命令（也可用 `--executor-command`） | 命令不存在时派发全部失败 |
| `AIMAC_AGENT_EXECUTION_TIMEOUT_MS` | `7200000` | 单次执行器运行上限（2 小时；0＝不限） | 超时的派发判失败 |
| `AIMAC_AGENT_EXECUTION_KEEPALIVE_MS` | `60000` | 执行期间给控制面发心跳的间隔（最低 15 秒，且不超过控制面的心跳阈值）（下限 15000，更小的值按它生效） | 过长会被控制面判离线 |
| `AIMAC_AGENT_STOP_TIMEOUT_MS` | `10000` | 取消时等执行器优雅退出多久再强杀 | — |
| `AIMAC_AGENT_OUTPUT_CAPTURE_MAX_CHARS` | `33554432`（32 MiB；最低 1024） | 执行器输出截留上限，超过的部分不进证据 | 太小会截掉关键报错 |
| `AIMAC_AGENT_SANDBOX_MODE` | 自动探测（容器→`container`） | 上报的沙箱模式标签 | 只影响展示与准入判断 |
| `AIMAC_AGENT_LIBRARY_MAX_MB` | `2048` | 本机内容库（技能/规则文件）总大小上限（最低 64） | 超过后同步被拒 |
| `AIMAC_AGENT_SESSION_TTL_HOURS` | `72` | 任务会话目录保留时长，过期由清扫回收（下限 1，更小的值按它生效） | — |
| `AIMAC_AGENT_KEEP_SESSION_DIRS` | `false` | 不清扫会话目录（排障用） | 盘会一直涨 |
| `AIMAC_AGENT_SWEEP_INTERVAL_MS` | `3600000` | 清扫间隔（最低 5 分钟）（下限 300000，更小的值按它生效） | — |

### 11.3 网络与重试

> 轮询间隔（多久去领一次活、断线后多久重试一次）由控制面在注册时下发（`pollIntervalSeconds`，默认 5 秒），节点侧没有对应的环境变量；要改，改控制面那边。

| 变量 | 默认 | 它决定什么 | 改错了的表现 |
| --- | --- | --- | --- |
| `AIMAC_AGENT_REQUEST_TIMEOUT_MS` | `30000` | 单个控制面请求超时（最低 1 秒） | — |
| `AIMAC_AGENT_GIT_TIMEOUT_MS` | `600000` | 命中网络的操作（内容传输 git fetch、派发仓库 git clone、技能包 curl 下载）单次墙钟超时（10 分钟；下限 60000，更小的值按它生效） | 太小会让大仓克隆超时；不设则挂死的远端会无限阻塞整台节点 |
| `AIMAC_AGENT_RETRY_ATTEMPTS` | `4`（最低 1） | 可重试请求的尝试次数 | — |
| `AIMAC_AGENT_REPLAY_MAX_ATTEMPTS` | `30` | 发件箱里一条检查点最多重放多少次，超过挪进恢复区并上报（最低 3） | 太小会把暂时性故障当成永久失败 |
| `AIMAC_AGENT_PERMISSION_POLL_ATTEMPTS` | `240` | 等人处置权限申请时轮询多少次（最低 1） | 与间隔相乘就是等待上限（默认约 4 分钟） |
| `AIMAC_AGENT_PERMISSION_POLL_INTERVAL_MS` | `1000` | 上述轮询间隔（最低 200 毫秒） | — |

### 11.4 排障与仿真（生产不要开）

| 变量 | 默认 | 它决定什么 | 改错了的表现 |
| --- | --- | --- | --- |
| `AIMAC_AGENT_DEBUG` | 无 | 设为 `1` 时失败打完整堆栈 | — |
| `AIMAC_AGENT_ONCE` | `false` | 只领一件活就退出（也可用 `--once`；e2e 用） | 常驻服务开了会不断退出重启 |
| `AIMAC_AGENT_VERIFICATION_DEFER_CHECKPOINT` | `false` | 干完活但不提交检查点（验证用）。开着时会向控制面上报一条 attention 事件说明是它干的 | 派发永远停在「进行中」 |
| `AIMAC_AGENT_SIMULATE_PERMISSION_BLOCK` | 无 | 仿真一次权限阻塞（e2e 用） | 真实派发会被假阻塞 |
| `AIMAC_AGENT_SIMULATE_PERMISSION_PROMPT_TYPE` | `oauth_login_required` | 仿真阻塞的提示类型 | — |
| `AIMAC_AGENT_SIMULATE_PERMISSION_RISK` | `L2` | 仿真阻塞的风险等级 | — |
