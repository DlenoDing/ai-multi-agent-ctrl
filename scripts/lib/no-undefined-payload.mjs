// 夹具里取错一层不会报错：值是 undefined，拼进模板串成了 "room_undefined"，请求照发、断言照绿，
// 而那一形态其实从没被验过（6e5176f 实撞一次：跨租户扫描自述"三种入参"，第三种一直等同于空参）。
// e2e 里多数 id 都有各自的"取不到就报空转"守卫；这一条是它们下面的网，判据便宜：
// 发给服务端的报文里不该出现字面量 undefined。故意要发的地方显式豁免。
export function assertNoUndefinedInPayload(label, payload, allow = false) {
  if (allow) return;
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  if (/undefined/u.test(text)) {
    throw new Error(`${label} 的报文里出现了字面量 undefined —— 夹具多半取错了一层，`
      + `这一路的断言在验一个不存在的对象：${text.slice(0, 200)}`);
  }
}

// 自证：这道网本身要能被改坏后报红。它平时【无事可抓】（现有夹具都是干净的），
// 所以没有任何产品代码的变异能证明它 —— 只能在这里当场造一个 undefined 和一个正常报文各走一遍。
// 加载时执行，跑任何一个 e2e 都会带上它。
{
  let missing;
  let caught = false;
  try {
    assertNoUndefinedInPayload("self-check", {roomId: `room_${missing}`});
  } catch {
    caught = true;
  }
  if (!caught) throw new Error("no-undefined-payload 自检失败：拼进模板串的 undefined 没有被抓住 —— 这道网是空的");
  try {
    assertNoUndefinedInPayload("self-check", {roomId: "room_ok", note: "一切正常"});
  } catch (error) {
    throw new Error(`no-undefined-payload 自检失败：正常报文被误伤（${error.message}）—— 会把真实的 e2e 打红`);
  }
}
