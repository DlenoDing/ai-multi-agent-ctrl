import { clampEnvNumber } from "./env-number.mjs";

// 一条幂等记录同时承担两件事，而两件事的时限差了几个数量级：
//   1) 重放 —— 同一个键的重试要拿回同一份响应体。客户端的重试发生在几秒到几分钟内。
//   2) 按键复用冲突检测 —— 同一个键配上不同 actor/动作/请求体必须 409。这条要保留整个上限窗口。
// 原先响应体跟着记录一起留到被淘汰为止：单条实测 8KB（orchestrator_run 的完整返回），上限 5000 条
// 就是中央文档里 ~40MB，而中央文档【每一次任意写入都要整份重写】—— 一次失败登录的审计写也要。
// 所以响应体按重放窗口清掉，判据字段照旧长期保留。
export function purgeExpiredIdempotencyPayloads(state, at = Date.now()) {
  const ttlMs = clampEnvNumber(process.env.AIMAC_IDEMPOTENCY_PAYLOAD_TTL_MS, 60000, 600000);
  for (const record of Object.values(state.idempotencyRecords || {})) {
    if (record.payload === undefined || record.payloadExpiredAt) continue;
    if (at - new Date(record.createdAt || 0).getTime() <= ttlMs) continue;
    delete record.payload;
    record.payloadExpiredAt = new Date(at).toISOString();
  }
}

// 命中一条幂等记录时该怎么答 —— 两条路（REST 的 finishGuardedWrite、MCP 的工具派发）
// 此前各写各的：REST 明确拒绝"空的成功回执"，MCP 那一支直接 ok:true / replayed:true 而正文是
// undefined —— 看起来像原来那次调用的结果，其实什么内容都没有。而 agent 全都走 MCP。
// 所以把这个判断收成一个入口，下一次改动不会再只改到一边。
export function idempotentReplayOutcome(record) {
  if (!record) return {replay: false};
  if (record.payload === undefined) {
    return {replay: false, expired: true, error: "idempotent_result_expired",
      originalStatus: record.status, completedAt: record.createdAt,
      payloadExpiredAt: record.payloadExpiredAt};
  }
  return {replay: true, status: record.status, payload: record.payload};
}

// 幂等回执有【两个写入点】：REST 的 finishGuardedWrite、MCP 的工具派发。
// 上面那个正文清理原先只挂在 REST 那一侧 —— agent 全都走 MCP，于是 MCP-only 的部署
// 从来不清理回执正文：实测按出厂上限（5000 条）跑满是 29.6MB 中央态，光这一项
// 给每一轮读写加 74ms（0 条 8.4ms → 5000 条 82.4ms，线性），而中央文档【每一次任意写入
// 都要整份重写】。这是本仓反复出问题的那个形状：同一件事两条路，只有一条被改到。
// 所以把「写下一条幂等回执」收成一个入口，清理与淘汰跟着它走，两侧都不再各自记得。
export function recordIdempotentResult(state, key, record, at = Date.now()) {
  state.idempotencyRecords = state.idempotencyRecords || {};
  state.idempotencyRecords[key] = record;
  purgeExpiredIdempotencyPayloads(state, at);
  capIdempotencyRecords(state);
}

// 条数上限。旋钮与落盘那步（state-store 的 pruneIdempotencyRecords）用【同一个】——
// 两个名字两层上限时生效的永远是更严的那个，调大的那个等于没用（本仓撞过）。
export function capIdempotencyRecords(state) {
  const cap = clampEnvNumber(process.env.AIMAC_IDEMPOTENCY_MAX_RECORDS, 100, 5000);
  const keys = Object.keys(state.idempotencyRecords || {});
  if (keys.length <= cap) return;
  const ordered = keys
    .map((key) => ({key, createdAt: state.idempotencyRecords[key]?.createdAt || ""}))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const {key} of ordered.slice(0, keys.length - cap)) delete state.idempotencyRecords[key];
}
