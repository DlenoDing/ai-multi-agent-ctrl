# 核心控制平面规格

## 1. 范围

本文档把总体设计收敛为终态控制平面规格，覆盖数据库核心表、HTTP API、MCP tools、事件模型、事务边界和可靠性规则。该规格的消费者是 Orchestrator、Agent Runtime、MCP Proxy、Scheduler、Monitor Agent 和自动化验证器，不是外部操作流程。

控制平面是系统权威状态来源。Agent Runtime 的本地配置/缓存/outbox、Room WS、远程 MCP、UI 和外部脚本都不能越过控制平面直接改变权威状态。所有服务型组件和 MCP Server 均运行在控制平面服务器，Agent 节点只运行轻量执行器。

## 2. 核心实体

```text
Project
  TaskGroup
    WorkItem
      WorkSession

AgentNode
Room
RoomMessage
Command
Lease
Checkpoint
Artifact
Finding
Contract
QualityGate
ChangeSet
MergeQueueItem
IntegrationBatch
ReleaseManifest
PermissionRequest
ApprovalRequest
PolicyDecision
DecisionRecord
CommandEffect
DLQEntry
AuditLog
RuntimeBootstrapProfile
Account
AccessControlGrant
ManagementConsoleSurface
ProgressSnapshot
InstructionEnvelope
SharedDefinitionContract
RepositoryOutputTarget
```

终态规格不区分“先做/后做”的非系统执行阶段。所有实体都必须在 schema、state machine 和事件模型中拥有明确边界。具体编码时可以由 Orchestrator 按依赖 DAG 自动分批提交，但不能把未实现实体设计成需要非系统执行路径补齐的开放项。

## 3. 数据库核心表

### 3.1 projects

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| name | text | not null |
| status | text | active, archived |
| default_ruleset_ref | text | nullable |
| runtime_config | jsonb | not null default `{}` |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

### 3.2 task_groups

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| name | text | not null |
| delivery_stage | text | not null |
| goal_execution_status | text | not null |
| risk_level | text | L0, L1, L2, L3 |
| control_state_version | bigint | not null default 1 |
| owner_session_id | text | nullable |
| close_barrier | jsonb | not null default `{}`，快照必须符合 `spec/close-barrier.schema.json` |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

### 3.3 work_items

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| task_group_id | text | references task_groups |
| title | text | not null |
| status | text | not null |
| priority | integer | not null default 100 |
| role_id | text | not null |
| input_locators | jsonb | not null default `[]` |
| input_digests | jsonb | not null default `{}` |
| write_scope | jsonb | not null default `[]` |
| dependencies | jsonb | not null default `[]` |
| acceptance | jsonb | not null default `{}` |
| assigned_session_id | text | nullable |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

### 3.4 work_sessions

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| task_group_id | text | references task_groups |
| agent_node_id | text | references agent_nodes |
| role_id | text | not null |
| status | text | not null |
| current_work_id | text | nullable |
| state_version | bigint | not null |
| model_assignment | jsonb | not null default `{}` |
| last_seen_at | timestamptz | nullable |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

### 3.5 agent_nodes

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| node_name | text | not null |
| status | text | joining, online, offline, read_only, quarantine |
| protocol_version | text | not null |
| runtime_version | text | not null |
| resource_profile | jsonb | not null default `{}` |
| model_profile | jsonb | not null default `{}` |
| tool_profile | jsonb | not null default `{}` |
| permission_profile | jsonb | not null default `{}` |
| trust_score | integer | not null default 100 |
| last_heartbeat_at | timestamptz | nullable |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

### 3.6 rooms 和 room_messages

`rooms`：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| task_group_id | text | nullable |
| type | text | project, task_group, sub |
| status | text | active, closed |
| next_sequence | bigint | not null default 1 |

`room_messages`：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| room_id | text | references rooms |
| sequence | bigint | not null |
| type | text | not null |
| priority | text | normal, important, p0 |
| sender_session_id | text | nullable |
| recipients | jsonb | not null default `[]` |
| state_version | bigint | not null |
| correlation_id | text | nullable |
| idempotency_key | text | not null |
| body | jsonb | not null |
| created_at | timestamptz | not null |

唯一约束：

```text
unique(room_id, sequence)
unique(room_id, idempotency_key)
```

### 3.7 commands

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| task_group_id | text | nullable |
| session_id | text | nullable |
| type | text | not null |
| status | text | created, admitted, dispatched, running, checkpointed, succeeded, failed, timed_out, cancelled, compensated, dlq |
| payload | jsonb | not null |
| idempotency_key | text | not null |
| attempt | integer | not null default 0 |
| max_attempts | integer | not null default 3 |
| timeout_at | timestamptz | nullable |
| result_ref | text | nullable |
| created_by | text | not null |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

唯一约束：

```text
unique(project_id, idempotency_key)
```

### 3.8 leases

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| task_group_id | text | nullable |
| resource_type | text | not null |
| resource_key | text | not null |
| owner_session_id | text | references work_sessions |
| fencing_token | bigint | not null |
| status | text | requested, active, renewing, released, expired, revoked |
| expires_at | timestamptz | not null |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

唯一约束：

```text
unique(project_id, resource_type, resource_key) where status = 'active'
```

### 3.9 checkpoints 和 evidence/artifact metadata

`checkpoints`：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| task_group_id | text | references task_groups |
| work_item_id | text | references work_items |
| session_id | text | references work_sessions |
| state_version | bigint | not null |
| summary | text | not null |
| commit_refs | jsonb | not null default `[]` |
| push_refs | jsonb | not null default `[]` |
| evidence_refs | jsonb | not null default `[]` |
| next_steps | jsonb | not null default `[]` |
| created_at | timestamptz | not null |

`artifacts` 只登记证据、日志、截图、测试报告和 artifact manifest metadata。项目任务的交付文件不进入独立文件管理系统，必须由 `RepositoryOutputTarget` 指向项目 Git 仓库路径，并通过 `commit_refs`、`push_refs` 和 `artifact_manifest_path` 证明。

`artifacts`：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| run_id | text | not null |
| type | text | not null |
| uri | text | not null |
| digest | text | not null |
| owner_session_id | text | nullable |
| sensitivity | text | public, internal, confidential, secret |
| metadata | jsonb | not null default `{}` |
| created_at | timestamptz | not null |

### 3.10 permission_requests

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| task_group_id | text | nullable |
| work_item_id | text | nullable |
| session_id | text | nullable |
| agent_node_id | text | references agent_nodes |
| status | text | observed, classified, routed_to_controller, pending_approval, approved, rejected, external_capability_required, external_capability_blocked, reassigned, scope_reduced, grant_issued, retrying, resolved, aborted, expired |
| prompt_type | text | not null |
| requested_capability | text | not null |
| requested_resource | text | nullable |
| risk_level | text | not null |
| artifact_ref | text | nullable |
| safe_retry_point | jsonb | not null default `{}` |
| suggested_actions | jsonb | not null default `[]` |
| expires_at | timestamptz | not null |
| on_timeout | text | reject, reassign, scope_reduce, abort |
| approval_request_id | text | nullable references approval_requests |
| policy_decision_id | text | nullable references policy_decisions |
| grant_ref | text | nullable |
| resolution_audit_ref | text | nullable |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

### 3.11 audit_logs

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | nullable |
| actor | text | not null |
| action | text | not null |
| resource | text | not null |
| params_digest | text | not null |
| result | text | not null |
| prev_hash | text | nullable |
| row_hash | text | not null |
| created_at | timestamptz | not null |

### 3.12 terminal_governance_objects

以下终态治理对象必须有独立表或等价的强 schema 存储。它们可以由代码生成 migration，但不能只存为无约束聊天文本。

| 对象 | 最小字段 |
| --- | --- |
| approval_requests | `id,project_id,task_group_id,action_ref,risk_level,required_approver_roles,quorum_policy,status,decision_record_id,expires_at,created_at` |
| approval_decisions | `id,approval_request_id,approver_role,decision,evidence_refs,audit_ref,created_at` |
| policy_decisions | `id,project_id,task_group_id,actor_ref,action,resource_ref,policy_version,decision,reason,evidence_refs,expires_at,created_at` |
| decision_records | `id,project_id,task_group_id,title,scope,status,decision,evidence_refs,invalidates_on,supersedes,created_at` |
| findings | `id,project_id,task_group_id,source_session_id,severity,status,root_cause_group,evidence_refs,owner_role,created_at` |
| contracts | `id,project_id,type,name,status,current_version_id,owner_role,created_at` |
| contract_versions | `id,contract_id,version,digest,source_ref,compatibility,status,created_by,created_at` |
| quality_gate_results | `id,project_id,task_group_id,target_ref,gate,status,evidence_refs,decision_record_id,created_at` |
| change_sets | `id,project_id,task_group_id,work_item_refs,base_commit,head_commit,changed_paths,status,evidence_refs,created_at` |
| merge_queue_items | `id,project_id,task_group_id,change_set_id,priority,status,lease_ref,created_at` |
| integration_batches | `id,project_id,task_group_id,baseline_commit,status,change_set_refs,merge_commit,push_refs,command_effect_refs,batch_ci_evidence_refs,failed_change_set_refs,conflict_owner_refs,ci_run_ref,release_manifest_ref,created_at` |
| release_manifests | `id,project_id,task_group_id,version_ref,commit_refs,push_refs,artifact_refs,rollback_refs,status,created_at` |
| command_effects | `id,project_id,task_group_id,command_id,status,effect_type,resource_key,before_digest,after_digest,external_operation_id,reversible,rollback_command_id,evidence_refs,verified_at,fencing_token` |
| dlq_entries | `id,project_id,task_group_id,source_type,source_id,source_command_id,source_effect_id,status,reason_code,owner_role,replay_policy_ref,resolution_effect_ref,created_at` |
| secret_grants | `id,project_id,task_group_id,work_item_id,session_id,agent_node_id,secret_ref,action,status,policy_decision_id,approval_request_id,expires_at,revocation_ref,audit_ref,created_at` |
| secret_leases | `id,project_id,task_group_id,work_item_id,session_id,agent_node_id,secret_grant_id,status,lease_ref,expires_at,release_audit_ref,created_at` |
| temp_grants | `id,project_id,task_group_id,work_item_id,session_id,agent_node_id,resource_ref,action,status,policy_decision_id,expires_at,revocation_ref,audit_ref,created_at` |
| external_capability_boundaries | `id,project_id,task_group_id,work_item_id,status,boundary_type,resource_ref,risk_level,forbids_ai_approval,allowed_resolution_modes,capability_grant_ref,evidence_refs,audit_ref,created_at` |
| agent_skill_sources | `id,source_id,repository_url,default_ref,pinned_commit,status,catalog_digest,index_ref,overlay_policy,created_at` |
| agent_role_skills | `id,source_id,source_path,name,category,status,frontmatter_digest,content_digest,capabilities,default_model_requirements,overlay_refs,created_at` |
| role_skill_overlays | `id,project_id,task_group_id,role_skill_id,status,overlay_digest,decision_record_id,created_at` |
| model_providers | `id,provider_class,status,probe_ref,capability_profile_ref,created_at` |
| model_capability_profiles | `id,provider_id,model_id,status,capability_digest,modalities,strengths,limits,quality_signals,cost_signals,observed_at` |
| model_selection_decisions | `id,project_id,task_group_id,work_item_id,role_skill_id,selected_model_id,status,score_breakdown_ref,policy_decision_id,audit_ref,created_at` |
| session_placement_policies | `id,project_id,task_group_id,status,default_placement,capacity_policy,placement_rules,decision_record_id,created_at` |
| session_placement_decisions | `id,project_id,task_group_id,work_item_id,status,placement,work_signals,capacity_snapshot_ref,model_selection_decision_id,task_contract_ref,audit_ref,created_at` |
| effective_instruction_packets | `id,project_id,task_group_id,work_item_id,status,objective_boundary_digest,next_action_draft_digest,action_basis_ref,active_rule_refs,non_active_material_refs,context_intake_refs,validation_requirements,forbidden_actions,audit_ref,created_at` |
| role_drift_guards | `id,project_id,task_group_id,work_item_id,session_id,role_id,role_class,status,objective_boundary_digest,role_mission_digest,task_contract_digest,effective_instruction_packet_id,drift_score,max_allowed_drift_score,corrective_actions,audit_ref,created_at` |
| execution_topologies | `id,project_id,task_group_id,work_item_id,status,mode,runner_kind,isolation,base_snapshot,merge_policy,eligibility_gates,branch_refs,blockers,audit_ref,created_at` |
| derived_task_requests | `id,project_id,task_group_id,source_ref,status,reason,proposed_insertion_mode,topology_effect,summary,evidence_ref,action_basis_ref,audit_ref,created_at` |
| review_plans | `id,project_id,task_group_id,source_ref,status,trigger,batching_decision,coverage_matrix,closure_gate,audit_ref,created_at` |
| review_bundles | `id,project_id,task_group_id,review_plan_id,review_batch_id,status,scope_root,payload_digest,redaction_status,provider_grant_ref,advisory_result_ref,local_verification_status,audit_ref,created_at` |
| rule_source_resolutions | `id,project_id,task_group_id,status,source_locator,source_scope,authority_level,source_digest,conflict_check,active_rule_refs,reference_only_refs,excluded_source_refs,audit_ref,created_at` |
| completion_readiness_checks | `id,project_id,task_group_id,target_ref,status,state_version,state_digest,required_checks,check_results,blocking_objects,evidence_refs,computed_at` |
| runtime_issue_patterns | `id,project_id,task_group_id,status,issue_fingerprint,recurrence_count,evidence_refs,sample_refs,upgrade_candidate_id,created_at` |
| system_upgrade_candidates | `id,project_id,task_group_id,status,issue_pattern_id,issue_fingerprint,recurrence_count,affected_components,evidence_refs,sample_refs,external_upgrade_package_ref,audit_ref,created_at` |
| runtime_bootstrap_profiles | `id,status,launch_modes,commands,services,storage,admin_seed_policy,health_checks,audit_ref,created_at,updated_at` |
| accounts | `id,account_type,status,display_name,email,roles,permissions,auth_policy,last_login_at,audit_ref,created_at,updated_at` |
| access_control_grants | `id,status,subject_ref,resource_ref,role,permissions,scope_digest,policy_decision_id,expires_at,audit_ref,created_at,updated_at` |
| management_console_surfaces | `id,console_type,status,route,views,guarded_actions,visual_quality_gates,audit_ref,created_at,updated_at` |
| progress_snapshots | `id,scope_type,scope_ref,status,progress,health,counters,role_activity,work_items,blockers,repository_outputs,digest,created_at,updated_at` |
| instruction_envelopes | `id,project_id,task_group_id,work_item_id,status,recipient_role,effective_instruction_packet_id,stable_prefix_digest,delta_refs,cache_key,token_budget,output_contract_ref,payload_digest,audit_ref,created_at,updated_at` |
| shared_definition_contracts | `id,project_id,task_group_id,status,definition_type,scope_refs,canonical_owner_role,producer_role,consumer_refs,definition_digest,repository_target,conflict_policy,change_policy,review_evidence_refs,audit_ref,created_at,updated_at` |
| repository_output_targets | `id,project_id,task_group_id,work_item_id,status,repository_id,repository_url,remote,branch,base_ref,path_allowlist,path_denylist,output_policy,decision_record_id,lease_id,commit_refs,push_refs,artifact_manifest_path,audit_ref,created_at,updated_at` |

`task_groups.close_barrier` 只保存 Orchestrator 最近一次计算出的 `CloseBarrier` 快照。关闭判定必须从 `work_items`、`findings`、`quality_gate_results`、`permission_requests`、`approval_requests`、`leases`、`commands`、`command_effects`、`dlq_entries`、`integration_batches`、`release_manifests`、`external_capability_boundaries`、`effective_instruction_packets`、`role_drift_guards`、`execution_topologies`、`derived_task_requests`、`review_plans`、`review_bundles`、`rule_source_resolutions`、`completion_readiness_checks`、`shared_definition_contracts`、`repository_output_targets`、`progress_snapshots`、`instruction_envelopes`、`rulesets`、`runtime_issue_patterns` 和 `system_upgrade_candidates` 的终态或非阻断状态确定性计算，并写入 `stateDigest`、`sourceQueryRefs`、按 gate 名称索引的 `gateResults`、`blockingObjects`、`waivers` 和 `evidenceRefs`。重复运行问题只要求已聚合并导出系统外升级证据包；关闭屏障不得要求运行中的系统自动执行自身升级。不能把自由文本或聊天结论写入 `close_barrier` 后直接关闭。

## 4. HTTP API

HTTP API 供 Orchestrator、Agent Runtime、系统 MCP adapter、自动化验证器和只读观察 UI 使用。所有读接口必须认证并按账号、项目、任务组 scope 过滤；所有写接口必须接收 `Idempotency-Key` header，并写入 audit。入口总控会话只能提交目标、边界和外部能力信号；后台管理只能配置能力 registry、查看审计和导入系统外升级产物；它们都不能作为项目执行 actor 调用任务写入接口。

| 方法 | 路径 | 作用 | 允许 actor |
| --- | --- | --- | --- |
| POST | `/api/projects` | 创建项目 | orchestrator |
| GET | `/api/projects/:projectId` | 读取项目 | orchestrator、scheduler、agent-runtime、monitor、admin read-only |
| GET | `/api/projects/:projectId/progress` | 读取项目进度快照 | orchestrator、monitor、ui-console-service |
| POST | `/api/projects/:projectId/members` | 授予项目成员权限 | ui-console-service、identity-service、policy-engine |
| POST | `/api/task-groups` | 创建任务组 | orchestrator |
| GET | `/api/task-groups/:taskGroupId` | 读取任务组快照 | orchestrator、scheduler、agent-runtime、monitor、admin read-only |
| GET | `/api/task-groups/:taskGroupId/progress` | 读取任务组进度快照 | orchestrator、monitor、ui-console-service |
| GET | `/api/task-groups/:taskGroupId/readiness` | 计算任务组完成就绪和关闭屏障 | orchestrator、monitor、ui-console-service |
| POST | `/api/task-groups/:taskGroupId/control` | 暂停、恢复、请求复验或纠偏 | orchestrator、ui-console-service |
| POST | `/api/work-items` | 创建 work item | orchestrator、decision-center |
| POST | `/api/work-items/:workItemId/assign` | 分配或改派 | scheduler、orchestrator |
| POST | `/api/effective-instruction-packets` | 创建强化后的有效指令包 | orchestrator、policy-engine |
| POST | `/api/instruction-envelopes` | 创建压缩后的角色指令信封 | orchestrator、instruction-optimizer |
| POST | `/api/role-drift-guards` | 绑定或更新角色漂移防护对象 | orchestrator、monitor |
| POST | `/api/role-drift-guards/:guardId/rebound` | 暂停跑偏角色并重签任务契约 | orchestrator |
| GET | `/api/model-registry` | 读取模型能力画像、选择策略和选择记录 | model-registry、scheduler、ui-console-service |
| POST | `/api/model-capabilities` | 注册或覆盖模型能力画像 | model-registry、policy-engine |
| POST | `/api/model-selection/decide` | 根据角色 skill、任务能力和策略生成模型选择决策 | scheduler、model-registry |
| POST | `/api/model-selection-decisions` | 记录模型和 Agent 自动选择结果 | model-registry、scheduler |
| GET | `/api/skill-registry` | 读取 skill source、role skill 和 overlay 索引 | skill-registry、scheduler、ui-console-service |
| POST | `/api/skill-sources/:sourceId/sync` | 同步 pinned skill source 并生成 digest 索引 | skill-registry |
| POST | `/api/role-skill-overlays` | 创建项目或任务组级 role skill overlay | skill-registry、decision-center |
| POST | `/api/session-placement/decide` | 生成新 WorkSession 或 subagent 放置决策 | scheduler |
| POST | `/api/session-placement-decisions` | 记录新会话或子 Agent placement | scheduler |
| POST | `/api/orchestrator/run` | 执行 Orchestrator 自治调度循环 | orchestrator |
| POST | `/api/agent-join-tokens` | 生成项目/角色/MCP scope 绑定的一次性 Agent 加入令牌 | agent-gateway |
| POST | `/api/agent/v1/register` | 消费 join token，注册轻量 Agent Runtime 并签发节点凭证 | agent-gateway |
| POST | `/api/agent/v1/heartbeat` | 上报节点资源、模型和工具能力 | agent-gateway |
| POST | `/api/agent/v1/self-check` | 验证 runtime、filesystem、Git、Gateway 和远程 MCP | agent-gateway |
| POST | `/api/agent/v1/dispatches/next` | 由已准入节点原子 claim 兼容 dispatch | agent-gateway |
| GET | `/api/agent/v1/skill-worksets/:worksetId` | 按 task contract 下发摘要绑定的最小 Skill 工作集 | skill-registry |
| POST | `/api/agent/v1/dispatches/:dispatchId/checkpoint` | 从远端 Git 独立取证后接受 checkpoint | agent-gateway、evidence-service |
| POST | `/api/verification/agent-runtime/run` | 仅 verification profile 的服务器内确定性测试入口，生产禁用 | spec-validator |
| POST | `/api/execution-topologies` | 创建并行/降级执行拓扑 | scheduler、orchestrator |
| POST | `/api/derived-task-requests` | 提交派生任务请求 | agent-runtime、reviewer、monitor、orchestrator |
| POST | `/api/review-plans` | 创建或更新互审计划 | reviewer、orchestrator |
| POST | `/api/review-bundles` | 注册 redacted review bundle 和 advisory result | reviewer、security |
| POST | `/api/rule-source-resolutions` | 解析外部/旧项目/互审材料是否可成为 active rule | rule-steward、orchestrator |
| POST | `/api/completion-readiness/compute` | 计算 WorkSession/TaskGroup 完成就绪 | orchestrator、monitor |
| POST | `/api/rooms/:roomId/messages` | 发送 room message | room-broker、agent-runtime、orchestrator |
| GET | `/api/rooms/:roomId/messages?after=` | 按 cursor 补读消息 | room-broker、agent-runtime、orchestrator |
| POST | `/api/commands` | 创建 command | orchestrator、command-bus、agent-runtime |
| POST | `/api/leases/claim` | 获取 lease | scheduler、agent-runtime |
| POST | `/api/leases/:leaseId/release` | 释放 lease | agent-runtime、orchestrator |
| POST | `/api/checkpoints` | 提交 checkpoint | agent-runtime |
| POST | `/api/artifacts` | 注册 artifact | agent-runtime、evidence-mcp |
| POST | `/api/permission-requests` | 提交权限阻断 | permission-gateway、agent-runtime |
| POST | `/api/approval-requests` | 创建审批状态机对象 | decision-center、policy-engine、orchestrator |
| POST | `/api/policy-decisions/evaluate` | 记录策略判定并返回准入结果 | policy-engine |
| POST | `/api/findings` | 提交独立复验发现 | reviewer、qa、security、monitor |
| POST | `/api/contracts` | 注册或更新契约对象 | orchestrator、decision-center |
| POST | `/api/shared-definition-contracts` | 创建或更新共享定义合同 | orchestrator、decision-center |
| POST | `/api/repository-output-targets` | 为 WorkItem 选择项目 Git 仓库输出目标 | orchestrator、repository-router |
| POST | `/api/integration-batches` | 创建集成批次 | release、orchestrator |
| POST | `/api/runtime-issues` | 收集重复运行期问题并生成升级候选，不触发运行时自修改 | monitor |
| POST | `/api/runtime-issue-patterns` | 聚合重复运行问题 | monitor |
| POST | `/api/system-upgrade-candidates/export` | 导出系统外升级证据包 | monitor、rule-steward |
| POST | `/api/system-upgrade-candidates/import-external-result` | 导入系统外独立升级后的版本化结果 | admin console、orchestrator import service |
| POST | `/api/close-barriers/compute` | 计算并校验关闭屏障 | orchestrator |
| POST | `/api/agent/v1/register` | 使用一次性 join token 初始化 Agent Runtime 节点 | agent-runtime |
| POST | `/api/agent/v1/heartbeat` | Agent Runtime 心跳与凭据轮换 | agent-runtime |
| POST | `/api/agent/v1/self-check` | Agent Runtime 初始化自检与准入 | agent-runtime |
| GET | `/api/agent/v1/control` | Agent Runtime 长轮询接收服务端控制命令 | agent-runtime |
| POST | `/api/agent/v1/control/:commandId/ack` | Agent Runtime ACK 控制命令结果 | agent-runtime |
| POST | `/api/agent/v1/dispatches/next` | Agent Runtime 拉取可执行 dispatch | agent-runtime |
| POST | `/api/agent/v1/events` | Agent Runtime 实时回送执行事件 | agent-runtime |
| POST | `/api/agents/:nodeId/activation` | 激活或停用 Agent | ui-console-service、policy-engine |
| POST | `/api/agents` | 创建项目可用 Agent identity | ui-console-service、identity-service |
| GET | `/api/runtime/health` | 运行健康检查 | ui-console-service、monitor |
| POST | `/api/bootstrap/init` | 初始化运行态 | ui-console-service、agent-runtime |
| POST | `/api/accounts` | 创建或邀请账号 | identity-service、ui-console-service |
| POST | `/api/access-grants` | 创建授权 | identity-service、policy-engine、ui-console-service |
| POST | `/api/access-grants/:grantId/revoke` | 撤销授权 | identity-service、policy-engine、ui-console-service |

## 5. MCP tools

系统必须内置以下 MCP tools。MCP tool 与 HTTP API 可以共用 service layer，但 MCP 调用必须经过 MCP Proxy、policy、lease、idempotency 和 audit。

| MCP server | tools |
| --- | --- |
| `orchestration-mcp` | `project_create`、`task_group_create`、`work_item_create`、`work_assign`、`orchestrator_run`、`state_get` |
| `room-mcp` | `room_join`、`room_send`、`room_wait`、`room_ack` |
| `agent-control-mcp` | `node_register`、`node_probe`、`session_start`、`session_pause`、`session_cancel`、`session_recover`、`dispatch_status` |
| `scheduler-mcp` | `model_select`、`session_place`、`work_assign`、`capacity_snapshot`、`execution_topology_plan`、`derived_task_classify` |
| `resource-mcp` | `lease_claim`、`lease_release`、`resource_snapshot` |
| `model-mcp` | `model_capabilities`、`model_policy_get`、`model_select` |
| `skill-mcp` | `skill_source_sync`、`role_skill_parse`、`role_skill_overlay_validate`、`role_skill_resolve` |
| `evidence-mcp` | `artifact_register`、`checkpoint_submit`、`test_result_submit` |
| `permission-mcp` | `permission_probe`、`permission_request_submit`、`permission_status`、`permission_resolve` |
| `review-mcp` | `review_plan_create`、`review_bundle_register`、`review_result_consume`、`completion_readiness_compute` |
| `governance-mcp` | `approval_request_create`、`policy_decision_eval`、`finding_submit`、`contract_publish`、`effective_instruction_create`、`role_drift_guard_bind`、`role_drift_rebound`、`rule_source_resolve`、`runtime_issue_pattern_submit`、`system_upgrade_candidate_export`、`system_upgrade_external_import`、`close_barrier_compute` |
| `identity-mcp` | `account_invite`、`account_suspend`、`grant_create`、`grant_revoke`、`permission_matrix_get` |
| `ui-console-mcp` | `runtime_health_get`、`management_surface_get`、`project_progress_get`、`task_group_progress_get`、`guarded_action_dispatch` |
| `definition-mcp` | `shared_definition_create`、`shared_definition_publish`、`shared_definition_consumer_bind`、`shared_definition_conflict_report` |
| `instruction-mcp` | `instruction_envelope_create`、`cache_key_index`、`stable_prefix_get`、`delta_payload_compact` |
| `repository-mcp` | `repository_output_target_select`、`repository_target_lease_bind`、`artifact_manifest_index` |

## 6. 事件模型

所有重要变化都写入 `room_messages` 或 `commands/outbox`，WS 只推送事件 ID。

事件 envelope：

```json
{
  "schemaVersion": "control-event/v1",
  "protocolVersion": "control-plane/v1",
  "schemaDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "eventId": "evt_...",
  "projectId": "prj_...",
  "taskGroupId": "tg_...",
  "roomId": "room_...",
  "sequence": 120,
  "type": "checkpoint_submitted",
  "stateVersion": 12,
  "correlationId": "corr_...",
  "actor": {
    "actorType": "session",
    "actorId": "sess_..."
  },
  "subject": {
    "type": "Checkpoint",
    "id": "chk_..."
  },
  "idempotencyKey": "checkpoint-work-1-run-1",
  "payloadSchemaRef": "spec/checkpoint.schema.json",
  "payloadRef": "db:checkpoints/chk_...",
  "payloadDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "stateTransition": {
    "machine": "WorkItem",
    "fromState": "in_progress",
    "toState": "checkpoint_submitted",
    "stateVersionBefore": 11,
    "stateVersionAfter": 12,
    "transitionId": "WorkItem:in_progress:checkpoint_submitted"
  },
  "guardEvidenceRefs": ["artifact_..."],
  "createdAt": "2026-07-23T08:00:00Z"
}
```

## 7. 事务边界

| 操作 | 必须同事务完成 |
| --- | --- |
| 发送 room message | 插入 message、递增 room sequence、插入 outbox、写 audit |
| 创建 command | 插入 command、插入 outbox、写 audit |
| 获取 lease | 检查唯一 active lease、插入 lease、递增 fencing token、写 audit |
| 提交 checkpoint | 校验 active AgentDispatch、runId、taskContractDigest、lease、RepositoryOutputTarget、commit/push remote 和 artifact manifest outputRefs 后，插入 checkpoint、更新 work/session 状态、递增 stateVersion、发送 checkpoint message、写 audit |
| PermissionRequest | 插入 request、更新 session 为 `permission_required`、发送事件、写 audit |

## 8. 可靠性规则

1. PostgreSQL 是权威状态，WS 掉线不能丢消息。
2. 所有消费者按 cursor 或 command id 补读。
3. 所有写接口必须有 idempotencyKey。
4. 所有副作用必须记录 command effect 或至少记录 resultRef。
5. lease 写入必须校验 fencing token。
6. 状态转移必须用 `spec/gates.yaml` 解析每个 `requires`，未匹配 resolver 的 gate 直接拒绝。
7. `controlStateVersion` 变化后，旧 session 必须 rebind 或返回 `STALE_STATE`。
8. DLQ 不能静默堆积，必须出现在关闭屏障和告警中。
9. MCP tool result 进入上下文前标记为 untrusted。
10. Evidence/artifact 只在消息中传 locator 和 digest，不传大内容；项目交付文件只通过 Git repository target、commitRef、pushRef 和 artifact manifest 表达。
11. Secret 只以 secret ref 表达，不进入 room message、artifact 正文或普通日志。
12. 共享定义必须先有 canonical owner、producer、definition digest 和 consumer binding；依赖 work 不能各自定义公共语义。
13. 指令 envelope 必须 stable-prefix/digest/delta/cache-key 优先，避免重复长上下文和低缓存命中。
