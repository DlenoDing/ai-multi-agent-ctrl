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
