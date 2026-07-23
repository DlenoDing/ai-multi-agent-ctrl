# Agent Runtime 协议

## 1. 目标

Agent Runtime 是公网或内网 Agent 节点上的本地控制进程，负责节点入网、心跳、资源探测、模型探测、MCP 本地代理、session 启动、checkpoint 上传、artifact 上传、权限阻断回传和断线恢复。

Runtime 不是无限远程 shell。所有副作用都必须由控制平面授权，并绑定 project、taskGroup、work、session、command、lease 和 audit。

## 2. 一键加入流程

总控生成一次性 join token：

```bash
agentctl join-token create \
  --project <project_id> \
  --node-name <expected_node_name> \
  --roles backend,frontend,reviewer,qa \
  --ttl 30m \
  --max-uses 1
```

受信开发环境的简单加入命令：

```bash
curl -fsSL https://control.example.com/install-agent.sh | sudo bash -s -- \
  --server https://control.example.com \
  --join-token <one_time_join_token> \
  --node-name "$(hostname)" \
  --work-dir /opt/ai-agent
```

生产环境必须使用校验版：

```bash
tmp="$(mktemp -d)" && cd "$tmp" && \
curl -fsSLO https://control.example.com/install-agent.sh && \
curl -fsSLO https://control.example.com/install-agent.sh.sha256 && \
shasum -a 256 -c install-agent.sh.sha256 && \
sudo bash install-agent.sh \
  --server https://control.example.com \
  --join-token <one_time_join_token> \
  --node-name "$(hostname)" \
  --work-dir /opt/ai-agent \
  --runtime-version <pinned_version> \
  --runtime-sha256 <expected_sha256>
```

加入成功回显：

```text
AGENT_JOINED
nodeId=agent_...
nodeName=...
agentProfileDigest=sha256:...
resourceClass=small|medium|large|xlarge
quotaClass=low|normal|high|unknown
models=<count>
modelAliases=deep_reasoning,balanced,fast_fix
mcpServers=<count>
gitProfiles=<count>
schedulerAdmission=read_only|limited|full
```

## 3. 初始化握手

```text
install_runtime
-> node_register
-> protocol_negotiation
-> runtime_integrity_attestation
-> resource_probe
-> model_probe
-> tool_probe
-> permission_probe
-> project_access_probe
-> local_db_init
-> control_channel_open
-> scheduler_admission
```

### 3.1 node_register

请求：

```json
{
  "joinToken": "join_...",
  "nodeName": "builder-01",
  "protocolVersion": "0.1",
  "runtimeVersion": "0.1.0",
  "platform": {
    "os": "darwin",
    "arch": "arm64",
    "hostname": "builder-01",
    "timezone": "Asia/Kuala_Lumpur"
  }
}
```

响应：

```json
{
  "nodeId": "agent_...",
  "projectScopes": ["prj_..."],
  "controlToken": "short_lived_token",
  "roomEndpoints": {
    "http": "https://control.example.com/api",
    "ws": "wss://control.example.com/ws"
  },
  "minRuntimeVersion": "0.1.0",
  "capabilityFlags": ["room", "command", "mcp_proxy", "permission_request"]
}
```

### 3.2 probe payload

Runtime 必须上报：

| 类别 | 字段 |
| --- | --- |
| resource | cpu、memory、disk、load、network、docker、browser、workspace |
| model | provider、modelId、alias、reasoningLevels、contextWindow、speed、quality、quotaState |
| tool | shell、git、node、python、docker、browser、test runners、本地 MCP |
| permission | OS、browser、credential helper、OAuth、network、Git、DB、Keychain/sudo |
| integrity | runtime digest、installer digest、config digest、sandbox mode |

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
  "minRuntimeVersion": "0.1.0",
  "requestedProbes": ["resource", "permission"]
}
```

## 5. session_start

控制平面启动 session 时必须传最小任务契约。

```json
{
  "commandId": "cmd_...",
  "sessionId": "sess_...",
  "projectId": "prj_...",
  "taskGroupId": "tg_...",
  "workId": "work_...",
  "roleId": "backend-owner",
  "roomId": "room_...",
  "stateVersion": 12,
  "rulesetDigest": "sha256:...",
  "inputLocators": ["repo://service/path", "doc://..."],
  "inputDigests": {
    "rules": "sha256:...",
    "contract": "sha256:..."
  },
  "writeScope": [
    {
      "resourceType": "file_path",
      "resourceKey": "service/src/foo.ts",
      "leaseId": "lease_...",
      "fencingToken": 77
    }
  ],
  "mcpGrants": ["grant_..."],
  "model": {
    "modelId": "provider/model",
    "alias": "balanced",
    "reasoningLevel": "medium",
    "selectionMode": "auto_best"
  },
  "permissionPolicy": {
    "onMissing": "permission_request",
    "autoAllowPromptTypes": ["browser_download"]
  },
  "stopOrReturn": ["done", "blocked", "stale_state", "needs_decision", "permission_required"]
}
```

Runtime 规则：

1. 启动前校验 `stateVersion`、ruleset digest、lease fencing token 和 MCP grants。
2. 缺权限时不继续执行副作用，提交 PermissionRequest。
3. 未声明 write scope 的路径只能读不能写。
4. 不支持的 command 必须返回 `UNSUPPORTED_COMMAND`，不能猜测执行。
5. session 必须写本地 outbox，控制平面 ACK 后才能清理。

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
  "evidenceRefs": ["artifact_..."],
  "nextSteps": ["request_review"]
}
```

控制平面返回新 stateVersion。Runtime 必须保存 ACK。

## 7. artifact_upload

Artifact 上传分两步：

```text
artifact_prepare -> upload file -> artifact_commit
```

上传前 Runtime 必须做基础脱敏：

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
  "suggestedActions": ["grant_credential", "manual_login", "reassign", "abort"]
}
```

Runtime 进入 `permission_required`，只允许继续上传日志、截图、checkpoint 和 outbox。

收到 `permission_resolution` 后：

| resolution | Runtime 行为 |
| --- | --- |
| grant_issued | 刷新 profile，从 safe retry point 重试 |
| manual_action_done | 重新 probe，对比权限变化后重试 |
| reassign | 停止当前 session，提交 handoff checkpoint |
| rejected | 标记 work blocked 或 aborted |
| scope_reduced | 重新读取 work contract 后继续 |

## 9. 断线恢复

Runtime 本地 SQLite 至少保存：

| 表 | 用途 |
| --- | --- |
| local_message_cursor | 每个 room 的 cursor |
| local_outbox | 未 ACK 的 checkpoint、artifact、permission event |
| local_session_state | active session、work、stateVersion |
| local_probe_cache | resource/model/tool/permission 最近画像 |
| local_grant_cache | 当前 MCP、Git、secret grant 摘要 |

恢复流程：

```text
runtime_start
-> load local state
-> heartbeat reconnect
-> flush local_outbox by idempotencyKey
-> room_wait from cursor
-> state_compare
-> continue|stale_state|recover_required
```

## 10. 安全边界

1. Runtime 不持有长期项目密钥，只持有短期 token 或 credential helper 引用。
2. Worker Session 与 Control Agent 分离。
3. session 结束、取消或隔离时清理临时凭据、临时文件、子进程和 shell history。
4. 默认不允许访问其它项目目录、全局 SSH key、宿主敏感路径和未授权网络。
5. 默认不自动批准 OS、Keychain、sudo、UAC、Screen Recording、Accessibility 权限弹窗。
6. 所有 command、MCP 写操作、Git 写操作和权限处理都必须进入 audit。
