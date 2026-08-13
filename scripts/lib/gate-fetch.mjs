// 门里 fetch 失败时 Node 只给一句 `TypeError: fetch failed`：不说是哪道门、不说哪个地址，
// 更不说最要紧的那句 —— 服务端根本没在监听的话，这一轮后面的断言什么也没验。
// 一次真实的间歇红就是这么读不动的（只看到 ECONNREFUSED 127.0.0.1:50725，无从判断出自哪道门）。
// 装一次即可覆盖该门的每一个调用点，不必逐处改写。
// undici 把连接失败包成 `TypeError: fetch failed`，码在 `cause.code`（本机实测就是这一层）。
// 另外两个分支是防御性的、本机没复现过：多地址（IPv4/IPv6）都失败时 cause 是 AggregateError，
// 码落在 `cause.errors[0].code`。取不到码时"服务端没在监听"会被降级成一句泛泛的"传输层失败"。
// 顺着 cause 链一路往下找（外面还可能再包一层本模块自己的报文），聚合错误则展开它的 errors。
export function transportErrorCode(error) {
  const seen = new Set();
  const queue = [error];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (item.code) return String(item.code);
    if (item.cause) queue.push(item.cause);
    if (Array.isArray(item.errors)) queue.push(...item.errors);
  }
  return "unknown";
}

export function installGateFetch(gateName) {
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    try {
      return await inner(input, init);
    } catch (error) {
      const code = transportErrorCode(error);
      const url = typeof input === "string" ? input : input?.url || String(input);
      const hint = code === "ECONNREFUSED"
        ? "服务端没在监听 —— 本轮结论不可信，别把它当成'通过'，先看这道门有没有把服务起起来"
        : "传输层失败（连接被对端关闭 / 超时）";
      throw new Error(`${gateName}: 请求 ${url} 失败（${code}）—— ${hint}`, {cause: error});
    }
  };
  return () => { globalThis.fetch = inner; };
}
