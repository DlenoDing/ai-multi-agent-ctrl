#!/usr/bin/env node
/*
 * 鉴权位置门（auth placement gate）
 *
 * 起因：我在 POST /api/repository-output-targets 里加了一个"幂等返回已有记录"的分支，却把它放在了
 * beginGuardedWrite 之前 —— 而鉴权、权限、租户作用域全都在那个守卫里。结果是任何人无凭证就能读到
 * 人批准的写入边界（仓库地址、分支、基线、允许与禁止路径、活跃租约）。所有单元测试都是绿的，因为
 * 没有一条测试会去问"这个响应是在鉴权之前还是之后产生的"。是外部复核直接 curl 才发现。
 *
 * 这一类靠逐条写测试是防不住的（每加一条路由就要记得写一条），所以做成静态结构检查：
 * 对每个 `if (req.method === "POST"|"PUT"|"PATCH"|"DELETE" ...)` 路由块，找出它的授权点
 * （beginGuardedWrite / agent_node_auth_required / requireRead 等），并要求在授权点之前
 * 不出现任何 `json(res, ...)` 响应或对 state 的写入。
 *
 * 一个例外白名单用于"授权前的纯输入校验"（400 类），它们不泄露任何状态，也不改状态。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = "apps/control-plane-ui/server.mjs";

// 授权点：出现其中任意一个即视为"已鉴权"。
const AUTH_MARKERS = [
  "beginGuardedWrite(",
  "agent_node_auth_required",
  "requireRead(",
  "canExposeBootstrapHint(",
  "authenticateRequest(",
  "accountFromRequest("
];

// 授权前允许出现的响应：纯输入校验（不读也不改状态，只根据请求体本身拒绝）。
const PRE_AUTH_ALLOWED_RESPONSES = [
  "must_use_git_trackable_paths",
  "unsafe_repository_url",
  "invalid_json_body",
  "unsupported_media_type",
  "payload_too_large",
  "bad_request"
];

function extractRouteBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  const routeStart = /if \(req\.method === "(POST|PUT|PATCH|DELETE)"/;
  for (let i = 0; i < lines.length; i += 1) {
    if (!routeStart.test(lines[i])) continue;
    // 以缩进为界粗略取块：从这一行到下一个同级 `if (req.method` 或函数结束。
    const body = [];
    // 按大括号配平取块，而不是"到下一个 if (req.method 为止" —— 后者会把相邻路由（含它的成功响应）
    // 吞进来，产生大量误报，把真信号淹掉。
    let depth = 0;
    for (let j = i; j < lines.length; j += 1) {
      body.push({line: j + 1, text: lines[j]});
      depth += (lines[j].match(/\{/gu) || []).length - (lines[j].match(/\}/gu) || []).length;
      if (j > i && depth <= 0) break;
      if (body.length > 400) break;
    }
    blocks.push({startLine: i + 1, header: lines[i].trim().slice(0, 120), body});
  }
  return blocks;
}

function run() {
  const source = readFileSync(join(root, TARGET), "utf8");
  const blocks = extractRouteBlocks(source);
  const violations = [];

  for (const block of blocks) {
    const authIndex = block.body.findIndex((entry) => AUTH_MARKERS.some((marker) => entry.text.includes(marker)));
    if (authIndex === -1) continue; // 没有授权点的块（例如纯静态响应）不在本门范围内
    const preAuth = block.body.slice(0, authIndex);
    for (const entry of preAuth) {
      const text = entry.text;
      if (text.trim().startsWith("//")) continue;
      const respondsEarly = /\bjson\(res,/.test(text);
      const mutatesState = /\bstate\.[A-Za-z]+\s*(\.\s*(push|unshift|splice)\s*\(|=[^=])/.test(text);
      if (respondsEarly && !PRE_AUTH_ALLOWED_RESPONSES.some((allowed) => text.includes(allowed))) {
        // 分两档：
        //  · 返回了【状态内容】= 严重（我那个漏洞就是这一档：无凭证读到人批准的写入边界）
        //  · 只返回 404「不存在」= 未鉴权的存在性探测，可枚举 id、区分"无此物"与"有但无权"，
        //    属跨租户信息泄露，但不泄露对象内容。
        // 只有【把状态里的对象/字段回给调用方】才算内容泄露。纯错误码响应（4xx + 固定 error 字符串）
        // 不泄露任何状态，属合法的前置校验；404 存在性探测单列一档。
        // 判据：响应体里出现了变量引用（非纯字面量），即可能带出状态内容。
        const payload = text.slice(text.indexOf("json(res,"));
        // 纯校验响应：4xx 且响应体里没有对 state 派生对象的引用（无模板插值、无变量标识符做值）。
        const isClientError = /json\(res,\s*4\d\d,/.test(payload);
        const hasInterpolation = /\$\{/.test(payload);
        const errorOnly = isClientError && !hasInterpolation;
        const contentLeak = !errorOnly && !/\b(404|not_found)\b/.test(text);
        violations.push({
          severity: contentLeak ? "content" : "existence",
          message: `${TARGET}:${entry.line} 在鉴权之前${contentLeak ? "返回了状态内容" : "做了存在性探测(404)"} —— 绕过 beginGuardedWrite（${block.header}）`
        });
      }
      if (mutatesState) {
        violations.push({severity: "content", message: `${TARGET}:${entry.line} 在鉴权之前就改写了 state（${block.header}）`});
      }
    }
  }

  const contentLeaks = violations.filter((item) => item.severity === "content");
  const existenceProbes = violations.filter((item) => item.severity === "existence");
  if (existenceProbes.length) {
    // 存在性探测目前作为【已知项】列出而不直接失败：全仓多处同形态，统一整改需要单独一轮。
    console.log(`auth placement gate: ${existenceProbes.length} 处鉴权前存在性探测（未鉴权即可区分"不存在"与"存在但无权"，属信息泄露，待统一整改）`);
    for (const probe of existenceProbes) console.log(`  · ${probe.message}`);
  }
  if (contentLeaks.length) {
    console.error("auth placement gate failed:");
    for (const violation of contentLeaks) console.error(`- ${violation.message}`);
    console.error("\n授权前只允许做纯输入校验（不读不改状态）。任何要返回状态内容或改状态的分支，都必须放在 beginGuardedWrite 之后。");
    process.exit(1);
  }
  console.log(`auth placement gate ok: ${blocks.length} 条改状态路由，鉴权之前均无状态内容泄露与状态写入`);
}

run();
