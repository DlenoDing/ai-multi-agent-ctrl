// 起过的子进程一律登记，并在【所有】退出路径上收掉。
// 只在成功路径上 kill 是不够的：断言抛错、超时、Ctrl-C 时服务就成了孤儿（父进程没了、PPID=1），
// 而它还带着自治循环在跑。本机实测积了 13 个这样的进程、最久的活了 15 小时，
// 负载被抬到 7 以上 —— 后果不只是浪费：同一份代码的耗时量出 22s 和 99s 两个结果，
// 任何性能判断都作不得数。测试留下的垃圾会污染后面所有测试。
//
// 这一段此前在三个门里各存一份（逐字节相同）。收进来是为了将来只改一处：
// 子进程清理是出问题最贵的那类代码，三份里改漏一份的表现是"偶尔留下孤儿进程"，
// 而那正好是最难复现、最容易被当成环境问题的故障。
export function createChildTracker() {
  const spawnedChildren = [];
  return {
    trackChild(child) {
      spawnedChildren.push(child);
      return child;
    },
    killTrackedChildren() {
      for (const child of spawnedChildren.splice(0)) {
        try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch { /* 尽力而为 */ }
      }
    }
  };
}

// 等一个子进程退出，带上限。
// **必须先看 exitCode/signalCode**：进程若已经退出，`on("exit")` 再也不会触发（事件早发生完了），
// 而上限那支定时器是 .unref() 的（它只是上限，不该把进程吊到上限）——
// 两边都吊不住事件循环时，Node 会空转到退出，报一句 "Detected unsettled top-level await"，
// 看不出是谁没退出、也跑不到后面的检查。
// 2026-08-23：这个形状在整跑变异门时连着咬了三次，每次都表现为「失败了但不是因为预期断言」，
// 而单独跑那条变异是好的 —— 最难查的那类假失败。全仓 11 处等待都改走这里。
export async function waitForChildExit(child, timeoutMs = 10000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs).unref())
  ]);
}

// 同上，但要拿到退出码。返回 {code} 或 {timedOut: true}。
// 已经退出的进程直接给它的 exitCode —— 不先看这一下的话，once(child,"exit") 永不 resolve。
export async function waitForChildExitCode(child, timeoutMs = 10000) {
  if (!child) return {timedOut: true};
  if (child.exitCode !== null || child.signalCode !== null) return {code: child.exitCode};
  return Promise.race([
    new Promise((resolve) => child.once("exit", (code) => resolve({code}))),
    new Promise((resolve) => setTimeout(() => resolve({timedOut: true}), timeoutMs).unref())
  ]);
}
