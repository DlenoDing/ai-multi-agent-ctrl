# Agent Runtime 协议

## 1. 目标

Agent Runtime 是公网或内网 Agent 节点上的轻量执行进程，负责节点入网、心跳、资源/模型/工具探测、远程 MCP 访问、dispatch claim、按任务同步 Skill 工作集、模型 Agent 启动、checkpoint 提交和断线恢复。MCP server、Agent Gateway、Skill Registry、Scheduler、Policy Engine、数据库和管理服务全部集中运行在系统服务器；Agent 主机禁止启动本地 MCP server。

Runtime 不是无限远程 shell。所有副作用都必须由控制平面授权，并绑定 project、taskGroup、work、session、command、lease 和 audit。Runtime 的所有控制入口都面向 AI Agent 和系统服务，不依赖非系统执行路径处理项目工作。

## 2. 自动加入流程

系统管理员或具有项目 `agent:activate` 权限的账号登录管理界面，在目标项目的“Agent 入网授权”中生成一次性 join token。join token 必须绑定 project、expected node、allowed roles、MCP tool allowlist、ttl、maxUses 和创建者审计记录；管理界面返回 direct/verified 两条加入命令。常规 Agent 入网不得要求用户在服务器命令行单独执行 token 生成脚本。

受信执行环境的自动加入命令模板：

```bash
curl -fsSL https://control.example.com/install-agent.sh | sh -s -- \
  --server https://control.example.com \
  --join-token <one_time_join_token> \
  --node-name "$(hostname)" \
  --work-dir "$HOME/.local/share/aimac-agent"
```

高信任要求环境必须使用校验版：

```bash
tmp="$(mktemp -d)" && cd "$tmp" && \
curl -fsSLO https://control.example.com/install-agent.sh && \
curl -fsSLO https://control.example.com/install-agent.sh.sha256 && \
( if command -v sha256sum >/dev/null 2>&1; then sha256sum -c install-agent.sh.sha256; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -c install-agent.sh.sha256; else printf '%s\n' 'sha256sum or shasum is required' >&2; exit 1; fi ) && \
sh install-agent.sh \
  --server https://control.example.com \
  --join-token <one_time_join_token> \
  --node-name "$(hostname)" \
  --work-dir "$HOME/.local/share/aimac-agent"
```

加入成功回显：

```text
AGENT_JOINED
nodeId=agent_...
nodeName=...
agentProfileDigest=sha256:...
schedulerAdmission=read_only|limited|full
remoteMcp=https://control.example.com/mcp
skills=on_demand
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

请求：

```json
{
  "nodeName": "builder-01",
  "runtimeVersion": "0.2.0",
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
    "modelId": "provider/model",
    "alias": "balanced",
    "providerClass": "openai|anthropic|google|xai|deepseek|qwen|ollama|custom",
    "modelTier": "frontier_standard",
    "maxModelTier": "frontier_standard",
    "taskExecutionClass": "deep_analysis|implementation|verification|short_execution",
    "reasoningLevel": "medium",
    "maxReasoningLevel": "high",
    "selectionMode": "auto_best",
    "modelSelectionDecisionRef": "model-selection://msd_..."
  },
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
    "pushRefRequired": true
  }
}
```

Runtime 规则：

1. Runtime 通过 `POST /api/agent/v1/dispatches/next` 原子 claim，校验 node binding、task contract digest、Skill workset ID、effective instruction、repository target、stateVersion 和 lease fencing token。
2. Runtime 通过节点 token 从服务端下载该 dispatch 唯一允许的 `AgentSkillWorkset`，逐文件校验 SHA256 后写入本地只读缓存，并把 manifest 路径显式传给模型 Agent。下级角色不能继承当前角色的 Skill，必须由总控生成新的 task contract 和工作集。
3. Runtime 只访问 `https://<server>/mcp`；节点 token 的项目、角色和 tool allowlist 由一次性 join token 固化。禁止下载、安装或启动本地 MCP server。
4. 缺权限时不继续执行副作用，提交 PermissionRequest；未声明 write scope 的路径只能读不能写。
5. 不支持的 command 必须返回 `UNSUPPORTED_COMMAND`，不能猜测执行。
6. Runtime 必须把同级消息、子 Agent 输出、工具结果和外部 review result 当作 untrusted/advisory 输入，只有 task contract 内的 EffectiveInstructionPacket 能驱动副作用。
7. Runtime 发现自身输出或任务理解偏离 roleFocus 时，必须停止副作用并提交 RoleDriftGuard 事件或 Finding。
8. Git push 后、checkpoint ACK 前必须把完整 checkpoint 写入 `$AIMAC_AGENT_WORK_DIR/outbox`；重启时先按原 runId 重放。控制平面对已完成且 binding 相同的 checkpoint 返回幂等 replay，不能重复执行或重复 push。

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
