#!/usr/bin/env node
// 突变探针：验证一条断言是否真的有判别力（"把修复撤掉，测试必须变红"）。
//
// 为什么需要它：验证判别力时要临时改坏一处代码再改回来，而"改回来"这一步如果用
// `git checkout -- <file>`，会把该文件里**所有未提交的改动**一起销毁 —— 包括正在做的修复本身。
// 这个错误我在本仓犯过三次，每次都是在验证自己刚写的断言时把刚写的修复弄丢。
// 这里把它变成不可能：备份的是【当前工作区内容】，恢复的也是它，与 git 无关。
//
//   node scripts/mutate-probe.mjs <file> <搜索串> <替换串> -- <验证命令...>
//
// 流程：备份原文件 -> 应用替换 -> 跑验证命令 -> 无论成败都恢复原文件 -> 打印命令输出。
// 退出码沿用验证命令的退出码，便于直接判断"突变后是否如预期失败"。
import {readFileSync, writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
if (separator < 0 || separator < 3) {
  console.error("用法: node scripts/mutate-probe.mjs <file> <search> <replace> -- <command...>");
  process.exit(2);
}
const [file, search, replace] = argv.slice(0, 3);
const command = argv.slice(separator + 1);
if (!command.length) {
  console.error("缺少验证命令");
  process.exit(2);
}

const original = readFileSync(file, "utf8");
if (!original.includes(search)) {
  console.error(`突变探针: 在 ${file} 里找不到要替换的内容 —— 探针本身已与代码脱节，不能据此下结论`);
  process.exit(2);
}
// 目标不唯一就停手。只替换第一处会静默改坏另一条路径，然后把"测试没有判别力"这个结论
// 安到一条其实好好的断言头上 —— 本次会话里判别力门与我自己各踩过一次。
const occurrences = original.split(search).length - 1;
if (occurrences !== 1) {
  console.error(`突变探针: 要替换的内容在 ${file} 里出现了 ${occurrences} 次 —— 无法确定改的是哪一处；`
    + "把上下文一起写进搜索串，使它唯一匹配（若确实要改全部，请分次执行）");
  process.exit(2);
}

let status = 2;
try {
  writeFileSync(file, original.replace(search, replace));
  const run = spawnSync(command[0], command.slice(1), {encoding: "utf8"});
  status = run.status ?? 1;
  process.stdout.write(run.stdout || "");
  process.stderr.write(run.stderr || "");
} finally {
  // 恢复的是备份下来的工作区内容，不是 git 里的版本 —— 未提交的修复不会被牵连。
  writeFileSync(file, original);
}
process.exit(status);
