// 主审计台账只有一处构造。此前它长在 UI 服务端里，而 MCP 那 85 个工具走的是另一条写路径 ——
// 于是经 MCP 改的状态在控制台的审计页上一条痕迹都没有，人来问"谁动了它"看到的是空白。
//
// 合流必须三件事一起做，缺一件都会造出比分开更糟的不一致：
//   ① 条目构造（含 prevHash 链）共用一处 —— 两处各写一份，链迟早分叉；
//   ② 归档落盘共用一处 —— 只做①的话条目进了内存台账（只留 80 条）却没进归档，
//      结果是控制台看得见、问责凭据里没有；
//   ③ 写入顺序必须是【先落盘状态、再追加归档】：CAS 冲突时那次写入根本没生效，
//      归档里不能留下一条并不存在的操作。
//
// 归档故障是【本进程本地文件】的事实，不放进共享状态：状态在每次写盘后才更新故障标记，
// 于是标记永远赶不上那一次持久化，下一个请求从存储重新载入时它已经不存在了（实测为 null）。
import { appendFileSync } from "node:fs";
import { digestOf } from "./control-plane-core.mjs";

let archiveFault = null;

// 内存台账只留最近这么多条，更早的只在归档文件里。界面要据此判断「有没有东西被挤掉」，
// 所以这个数必须只有一处 —— 此前它是这里的一个字面量，而界面自己编了一句"只保留最近 N 条"。
export const AUDIT_LOG_CAP = 80;

export function auditArchiveFault() {
  return archiveFault;
}

export function appendAuditEntry(state, {actor, action, subject, result = "succeeded", at, ref}) {
  state.auditLog ||= [];
  const entry = {
    // 这个集合此前【不受任何规范约束】：813 条真实记录一条都没被校验过，
    // 少一个字段、改一个类型都不会有人发现，而它是事后问责的唯一凭据。
    // schemaVersion 要在 digestOf 之前打上 —— 链上的哈希覆盖除 rowHash 外的全部字段。
    schemaVersion: "audit-log-entry/v1",
    id: `audit_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    at: at || new Date().toISOString(),
    actor,
    action,
    subject,
    result,
    stateVersion: Number(state.stateVersion || 0),
    // 【两本账要能对上】。经 MCP 改的状态在这本人看的账上只有一句 mcp_tool_call + 主题；
    // 入参/返回摘要在另一本 mcp-audit.jsonl 里，而这一行原先没有任何键能跳过去 ——
    // 界面上那句"摘要另存于 mcp-audit.jsonl"等于让人去一本没有索引的账里翻。
    // ref 记那边的 callId。只在给了时写（REST 侧的行没有），且放在 rowHash 之前，让链覆盖它。
    ...(ref ? {ref} : {}),
    prevHash: state.auditLog[0]?.rowHash || state.auditChainHead || "sha256:genesis"
  };
  entry.rowHash = digestOf(entry);
  state.auditLog.unshift(entry);
  state.auditLog = state.auditLog.slice(0, AUDIT_LOG_CAP);
  state.auditChainHead = entry.rowHash;
  state.__pendingAuditAppends = [...(state.__pendingAuditAppends || []), entry];
  return entry;
}

export function flushPendingAuditAppends(state, archivePath) {
  const pending = state.__pendingAuditAppends || [];
  delete state.__pendingAuditAppends;
  if (!pending.length) return;
  try {
    appendFileSync(archivePath, pending.map((entry) => `${JSON.stringify(entry)}\n`).join(""), {mode: 0o600});
    archiveFault = null;
  } catch (error) {
    // 内存里只留最近 80 条，归档才是问责的凭据。这里原先是 `catch {}`：磁盘满了、权限变了，
    // 记录就这么没了，而且【没有任何人会知道】—— 出事时人以为查得到，实际早就断了。
    // 失败必须同时落在两处：日志（运维看得见）和状态（控制台看得见），且要记下丢了几条。
    archiveFault = {
      at: new Date().toISOString(),
      lostEntries: Number(archiveFault?.lostEntries || 0) + pending.length,
      error: String(error?.message || error).slice(0, 200)
    };
    console.error(`[audit] 归档写入失败，${pending.length} 条记录未落盘：${archiveFault.error}`);
  }
}
