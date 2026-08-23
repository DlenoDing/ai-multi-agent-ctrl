// 「这条派发还算不算活的」这一判定，此前在 6 个文件里【内联抄了 15 遍】：
// core 7 处、server 2 处、state-store 2 处、agent-gateway 1 处、mcp-server 1 处、控制台 2 处。
// 它决定的事情很硬：活的派发会挡住任务组关闭、会被暂停/撤销叫停、会被容量保护绕开。
// 多一个终态而漏改一处，那一处就会把已经结束的派发当成还在跑（任务组永远关不掉），
// 或者反过来把在跑的当成已结束（叫停时放过它）—— 两个方向都不报错。
//
// 真相源是 spec/state-machines.yaml 里 AgentDispatch 的 terminal 字段，
// 由 validate-specs 逐字核对这份常量与它一致，并禁止任何文件再内联抄一份。
export const AGENT_DISPATCH_TERMINAL_STATES = Object.freeze(["completed", "failed", "cancelled"]);

const AGENT_DISPATCH_TERMINAL = new Set(AGENT_DISPATCH_TERMINAL_STATES);

export function isTerminalDispatchStatus(status) {
  return AGENT_DISPATCH_TERMINAL.has(status);
}
