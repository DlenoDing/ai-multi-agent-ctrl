// 环境旋钮的数值读取只有这一个正确做法。原先散在各处的是
// `Math.max(下限, Number(process.env.X || 默认))` —— 值打错（"10k"、"32MB"）时 Number 给出 NaN，
// 而 Math.max(下限, NaN) 还是 NaN：上限比较（length > cap）恒 false＝容量阀静默失效、
// 重试/限速比较（attempts >= max）恒 false＝登录限速静默关闭、slice(0, NaN)＝[]＝列表整个消失。
// 一个打错的旋钮值，静默变成「无上限」或「清空」，而运维得到的提示是零。
// 这里认不出就用默认值（unset/空串/垃圾同待遇），认得出才取 max(下限, 值)。
// 收在叶子模块里（与 mcp-tool-catalog 同理）：core/server/mcp/存储层都要用，不能互相成环。
// agent 运行时（runtime.mjs）是单文件下发的，那边有一份同名同实现的本地副本。
export function clampEnvNumber(raw, min, fallback) {
  const text = String(raw ?? "").trim();
  const numeric = text === "" ? Number(fallback) : Number(text);
  return Number.isFinite(numeric) ? Math.max(min, numeric) : Math.max(min, fallback);
}
