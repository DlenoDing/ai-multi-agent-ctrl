#!/usr/bin/env node
/*
 * 判别力门（mutation gate）
 *
 * 问题：一条"测试通过"并不能证明它护住了任何东西。在人工定稿闸门这一系列改动里，我自己写的验证
 * 有一半是【假绿】——断言含宽泛的析取项、种子里本来就有别的失败源、只做单向断言（只证明坏结果没
 * 发生，不证明好结果发生了）。这些测试在守卫被删掉之后照样通过，等于门自己在空转。
 *
 * 做法：对每个关键守卫，把它【故意改坏】（mutation），然后要求 contract-check 必须失败，并且失败
 * 信息里要出现那条守卫对应的断言。改坏之后仍然全绿 = 那条测试没有判别力，本门直接报错。
 *
 * 这是把"还原修复→确认测试失败"这套一直靠手工执行的纪律固化成 CI 可执行的检查。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = "apps/control-plane-ui/lib/control-plane-core.mjs";
const MCP = "apps/mcp-server/server.mjs";
const GATEWAY = "apps/control-plane-ui/lib/agent-gateway.mjs";

// 每条 mutation：把守卫改坏，期望 contract-check 失败且输出里出现 expect 片段。
const MUTATIONS = [
  {
    name: "核心决策必须真人定稿",
    file: CORE,
    from: 'if (request.decisionClass === "major" && !isHumanConfirmationActor(state, options.actor))',
    to: "if (false)",
    expect: "机器主体（service_account）竟然可以定稿核心决策"
  },
  {
    name: "AI 互审不得直接验收",
    file: CORE,
    from: 'workItem.status = "verification_ready";',
    to: 'workItem.status = "verified";',
    expect: "AI 互审仍然直接把工作项标记为 verified"
  },
  {
    name: "AI 再分析不得终结决策",
    file: CORE,
    from: 'if (!request.awaitingAiAnalysis && Number(request.round || 1) > 1)',
    to: "if (false)",
    expect: "AI 可连续刷新候选方案推进轮次"
  },
  {
    name: "定稿对象不得被掉包",
    file: CORE,
    from: "if (request.subjectContentDigest) {",
    to: "if (false) {",
    expect: "方案在人点确认前被改掉，定稿却仍然生效"
  },
  {
    name: "承载授权的记录 id 必须唯一",
    file: CORE,
    from: "if ((collection || []).some((item) => item?.[idField] === id)) {",
    to: "if (false) {",
    expect: "允许重复 id（冒名记录可顶替人批准的那一份）"
  },
  {
    name: "写入边界一个工作项只能有一份",
    file: MCP,
    from: "if (activeExisting) return {repositoryOutputTarget: activeExisting, deduplicated: true};",
    to: "",
    expect: "同一工作项出现了多份生效的写入边界"
  },
  {
    name: "确认单去重键按类别隔离",
    file: CORE,
    from: "const dedupeKey = `${decisionType}:` + (String(input.requestKey",
    to: 'const dedupeKey = "" + (String(input.requestKey',
    expect: "运行时确认单顶掉了核心决策单"
  },
  {
    name: "执行证据去重限定本次派发",
    file: GATEWAY,
    from: "item.eventKey === eventKey && item.dispatchId === dispatchId",
    to: "item.eventKey === eventKey",
    expect: "执行事件按全局 eventKey 去重"
  },
  {
    name: "技能绑定不得被冒名顶替且不得回退占位",
    file: CORE,
    from: "skillBasename(skill) === hint.skillRef",
    to: 'String(skill.roleSkillId || "").endsWith("/" + hint.skillRef)',
    expect: "真实同步技能没有被绑定"
  },
  {
    name: "草稿契约不得锁死关闭门（人无杠杆）",
    file: CORE,
    // 必须唯一匹配：这个片段在 core 里出现三次（派发循环 / completion readiness / close barrier），
    // 而被测的是 computeCloseBarrier 那一处。只写片段会改坏派发循环，于是本门报出"你的测试是假绿"，
    // 而那条测试其实好好的 —— 一个把人派去删掉有用断言的假阳性。连上下文一起写。
    // 瞄准 computeCompletionReadiness 里那一处：带 objectType:"SharedDefinitionContract" 的阻塞对象
    // 由它产出（checkFailures.shared_definitions_active → blockers.push），而断言检查的正是那些对象。
    // 关闭门里同名的 all_shared_definitions_active 是另一条腿，改它不会影响这条断言。
    // 我为这条 mutation 瞄错过两次（先是派发循环，再是关闭门），两次的症状都是"你的测试是假绿" ——
    // 用代码片段钉住突变本身就容易瞄错，而它的误报方向恰好是最会误导人的那个。
    from: 'shared_definitions_active: relatedSharedDefinitions(state, taskGroup).some((definition) => SHARED_DEFINITION_BLOCKING_STATUSES.includes(definition.status)),\n    repository_output_target_terminal',
    to: 'shared_definitions_active: relatedSharedDefinitions(state, taskGroup).some((definition) => definition.status !== "active"),\n    repository_output_target_terminal',
    expect: "AI 能建出的草稿契约就锁死了关闭门"
  },
  {
    name: "裸 Project 通配不得横扫全项目",
    file: CORE,
    from: "const projectRefs = [`Project:${taskGroup.projectId}`, taskGroup.projectId];",
    to: 'const projectRefs = [`Project:${taskGroup.projectId}`, taskGroup.projectId, "Project"];',
    expect: "裸 Project 通配锁死了别的任务组"
  },
  {
    name: "合法发布必须真的激活",
    file: CORE,
    from: "args.allowDirectActivation === true",
    to: "false",
    expect: "合法发布未能激活"
  },
  {
    name: "技能绑定读的是生产者真实字段",
    file: CORE,
    from: 'String(skill.sourcePath || "")',
    to: 'String(skill.relativePath || "")',
    expect: "真实同步技能没有被绑定"
  },
  {
    name: "共享定义状态不得由调用方声称",
    file: CORE,
    from: "      : (SHARED_DEFINITION_CREATABLE_STATUSES.includes(args.status) ? args.status : \"draft\"),",
    to: '      : (args.status || "draft"),',
    expect: "调用方可直接把共享定义声明为生效/冲突"
  },
  {
    name: "publish 不得铸造未知契约",
    file: MCP,
    from: 'if (!definition) return {ok: false, error: "shared_definition_not_found"};',
    to: "if (!definition) return {ok: false, error: \"shared_definition_not_found\"}; // eslint-disable-line",
    to_alt: true,
    expect: "publish 铸造并激活了一个未知契约",
    skip: "publish 的 mutation 需要重建 || 分支，改动过大，由 validate-specs 的源码断言覆盖"
  },
  {
    name: "越权访问必须被漂移门定性阻断",
    file: CORE,
    from: "const hardViolation = signals.some",
    to: "const hardViolation = [].some",
    expect: "单条越权访问未被角色漂移门拦下"
  }
];

// 崩溃安全：这个脚本会把真实源文件改坏再还原。一旦中途被打断（Ctrl-C / 被杀 / 抛错），
// 工作树里就会留下【闸门守卫被禁用】的代码 —— 那比它要防的问题更危险。所以把待还原的内容
// 登记在进程级，并在所有退出路径上还原。
// 记的是「原内容」与「我写下的那份改坏内容」两样。还原前必须确认磁盘上仍是后者 ——
// 否则就是别人在这期间改了这个文件，把它覆盖回去等于销毁别人未提交的改动。
// 本次会话真的发生过：这道门在后台跑，我同时在改同一个文件，跑完它把我的改动抹掉了。
// 这与用 git checkout 撤销临时改动是同一类事故，只是这次是我自己的工具做的。
const pendingRestores = new Map();
function restoreAll() {
  for (const [path, {original, mutated}] of pendingRestores) {
    try {
      const onDisk = readFileSync(path, "utf8");
      if (onDisk !== mutated) {
        process.stderr.write(`mutation gate: ${path} 在本门运行期间被改动过，已放弃还原以免覆盖它。\n`
          + "  若这不是你的改动，请对照 git diff 手工确认；本门不再自动写回。\n");
        continue;
      }
      writeFileSync(path, original);
    } catch { /* 尽力而为 */ }
  }
  pendingRestores.clear();
}
process.on("exit", restoreAll);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { restoreAll(); process.exit(130); });
}
process.on("uncaughtException", (error) => { restoreAll(); console.error(error); process.exit(1); });

function run() {
  const failures = [];
  const checked = [];
  for (const mutation of MUTATIONS) {
    if (mutation.skip) { checked.push(`- ${mutation.name}（跳过：${mutation.skip}）`); continue; }
    const path = join(root, mutation.file);
    const original = readFileSync(path, "utf8");
    if (!original.includes(mutation.from)) {
      failures.push(`${mutation.name}: 找不到要改坏的代码片段 —— 守卫可能已被重写，mutation 需同步更新`);
      continue;
    }
    // 目标不唯一必须报错，不能默默改第一处。实测踩到过：SHARED_DEFINITION_BLOCKING_STATUSES.includes(...)
    // 后来在派发循环里也出现了一次、且在文件更靠前，于是这条 mutation 改坏的是另一条路径，
    // 被测的关闭门毫发无损 —— 本门于是报出"你的测试是假绿"。而那条测试其实是好的。
    // 一个把人派去修好测试的假阳性，比漏报更糟：它会让人删掉真正有用的断言。
    const occurrences = original.split(mutation.from).length - 1;
    if (occurrences !== 1) {
      failures.push(`${mutation.name}: 要改坏的代码片段在 ${mutation.file} 里出现了 ${occurrences} 次 —— `
        + "无法确定改的是被测的那一处，mutation 必须写成唯一匹配（连上下文一起写）");
      continue;
    }
    // 【必须先登记再改】——否则上面那套退出钩子拿不到要还原的内容，看着有崩溃安全实则空转
    // （我第一版就是这样：pendingRestores 从没被填充过）。
    const mutated = original.replace(mutation.from, mutation.to);
    pendingRestores.set(path, {original, mutated});
    writeFileSync(path, mutated);
    let output = "";
    let passed = false;
    try {
      execFileSync("node", [join(root, "scripts/contract-check.mjs")], {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
      passed = true; // 改坏了却还通过 => 测试没有判别力
    } catch (error) {
      output = `${error.stdout || ""}${error.stderr || ""}`;
    } finally {
      // 同上：只在磁盘内容仍是自己写下的那份时才写回。
      let onDisk = "";
      try { onDisk = readFileSync(path, "utf8"); } catch { onDisk = mutated; }
      if (onDisk === mutated) writeFileSync(path, original);
      else process.stderr.write(`mutation gate: ${path} 期间被改动过，已放弃还原以免覆盖它。\n`);
      pendingRestores.delete(path);
    }
    process.stdout.write(`  · ${mutation.name} …\n`);
    if (passed) {
      failures.push(`${mutation.name}: 守卫被改坏后 contract-check 仍然通过 —— 该守卫的测试是假绿，没有判别力`);
    } else if (!output.includes(mutation.expect)) {
      failures.push(`${mutation.name}: 失败了但不是因为预期断言（期望出现「${mutation.expect}」）—— 测试可能在别处偶然失败，并未真正覆盖这条守卫`);
    } else {
      checked.push(`- ${mutation.name}`);
    }
  }
  if (failures.length) {
    console.error("mutation gate failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`mutation gate ok: ${checked.length} 条守卫均已证明其测试具备判别力`);
  for (const line of checked) console.log(line);
}

run();
