#!/usr/bin/env node
// 备份运行目录：拷贝 + 【核对】 + 不对就重拷。
//
// 为什么不能只 cp -R：项目分片按 generation 命名，写入方在写出新一代之后【立刻】删掉旧的那一份。
// 于是不停机拷贝存在一个真实的竞态 —— 中央索引在 T1 被拷走（指着 G1），T2 有人写入并删掉 G1，
// T3 拷到 project-db 时只剩 G2。拷出来的那份"看着完整"，还原时才发现分片对不上。
// 换个拷贝顺序也躲不掉（反过来就是分片旧、索引新）。所以做法是：拷完【按索引核一遍】，不对就重来。
// 实测 cp 本身也会撞上正在改名的临时文件而报 ENOENT（三次里中一次），同样按重试处理。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// 认不出的参数一律拒（与仓里其它运维入口同一形状）：`--verify` 这种打错的名字被当成"没给"的话，
// 命令会照跑，而人以为自己开了某个开关。备份只吃两个位置参数。
const unknownFlags = process.argv.slice(2).filter((item) => item.startsWith("-"));
if (unknownFlags.length) {
  console.error(`认不出的参数：${unknownFlags.join(" ")}\n`
    + "用法：node scripts/backup-runtime.mjs [运行目录] [备份目录]（都是位置参数，没有开关）\n"
    + "可用环境变量：AIMAC_RUNTIME_DIR（默认源）、AIMAC_BACKUP_ATTEMPTS（重试次数，默认 5）");
  process.exit(1);
}

const source = resolve(process.argv[2] || process.env.AIMAC_RUNTIME_DIR || ".runtime");
const target = resolve(process.argv[3] || `${source}-backup-${new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}`);
const attempts = Math.max(1, Number(process.env.AIMAC_BACKUP_ATTEMPTS || 5));

if (!existsSync(source)) {
  console.error(`备份源不存在：${source}\n用法：node scripts/backup-runtime.mjs [运行目录] [备份目录]`);
  process.exit(1);
}

// 核对拷贝出来的那份自身是否自洽：中央索引点名的每一个分片、段清单点名的每一个事件段，都要在。
// 这与控制面启动时的检查是同一套判据（project_state_shard_missing / 段清单核对），
// 提前在备份这一刻问，而不是等到还原那一刻。
function verify(dir) {
  const statePath = join(dir, "control-plane-state.json");
  if (!existsSync(statePath)) return ["中央状态文件不在"];
  let central;
  try { central = JSON.parse(readFileSync(statePath, "utf8")); }
  catch (error) { return [`中央状态文件解析不了：${String(error.message).slice(0, 80)}`]; }
  const problems = [];
  const projectDb = join(dir, "project-db");
  const indexed = central.projectStateShards?.projects || [];
  for (const entry of indexed) {
    const name = entry.storageRef ? basename(String(entry.storageRef)) : null;
    if (!name) { problems.push(`项目 ${entry.projectId} 的索引条目没有 storageRef`); continue; }
    const shardPath = join(projectDb, name);
    if (!existsSync(shardPath)) { problems.push(`项目 ${entry.projectId} 的分片 ${name} 不在`); continue; }
    // 比的是分片【自己记着的正文字节数】，与存储层读取时那道校验同源 —— 不要拿文件大小去比
    // （那是另一个数：文件里还有 schemaVersion、generation 这些字段，第一版就是这么错的）。
    let shard = null;
    try { shard = JSON.parse(readFileSync(shardPath, "utf8")); }
    catch (error) { problems.push(`项目 ${entry.projectId} 的分片 ${name} 解析不了：${String(error.message).slice(0, 60)}`); continue; }
    if (entry.storagePayloadBytes && Number(entry.storagePayloadBytes) !== Number(shard.storagePayloadBytes || 0)) {
      problems.push(`项目 ${entry.projectId} 的分片 ${name} 正文长度与索引对不上`
        + `（索引 ${entry.storagePayloadBytes}、分片 ${shard.storagePayloadBytes || 0}）`);
    }
  }
  if (existsSync(projectDb)) {
    for (const name of readdirSync(projectDb).filter((item) => item.endsWith("execution-events.manifest.json"))) {
      let manifest;
      try { manifest = JSON.parse(readFileSync(join(projectDb, name), "utf8")); } catch { problems.push(`段清单 ${name} 解析不了`); continue; }
      for (const segment of manifest.segments || []) {
        if (!existsSync(join(projectDb, segment.file))) problems.push(`事件段 ${segment.file} 不在（段清单 ${name} 记着它）`);
      }
    }
  } else if (indexed.length) {
    problems.push("project-db 目录整个不在，而中央索引里记着分片");
  }
  return problems;
}

let lastProblems = ["没跑成"];
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  rmSync(target, {recursive: true, force: true});
  mkdirSync(target, {recursive: true});
  try {
    cpSync(source, target, {recursive: true});
  } catch (error) {
    lastProblems = [`拷贝本身失败：${String(error.message).slice(0, 120)}（多半撞上了正在改名的临时文件）`];
    continue;
  }
  lastProblems = verify(target);
  if (!lastProblems.length) {
    const files = readdirSync(target).length;
    console.log(`备份 ok：${source} → ${target}（第 ${attempt} 次拷贝通过核对，顶层 ${files} 项）`);
    console.log("核过的：中央索引点名的每个分片都在且长度对得上；段清单点名的每个事件段都在。");
    console.log("还原：把这个目录整个拷回去（或用 AIMAC_RUNTIME_DIR 指向它）再启动。");
    process.exit(0);
  }
}
rmSync(target, {recursive: true, force: true});
console.error(`备份没做成（试了 ${attempts} 次，每次拷完都核对不通过）：\n  ${lastProblems.slice(0, 5).join("\n  ")}`);
console.error("这通常说明拷贝期间写入很密集：把系统静一静再拷，或调大 AIMAC_BACKUP_ATTEMPTS。");
console.error("【不要】拿这份没通过核对的目录去还原 —— 它的分片与索引对不上，起不来。");
process.exit(1);
