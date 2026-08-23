import { createHash } from "node:crypto";

// 项目数据在磁盘上的名字。状态分片（state-store）与事件段（project-event-store）指的是
// 【同一个项目的同一批数据】，两边算出来的名字必须逐字一致 —— 各留一份实现，
// 哪天只改了一处，事件库与状态库就会指向两个目录，而这件事不会报错：
// 一边照常写，另一边把对方的文件当野文件（本仓「索引说有、存储给不出」那一族的邻居）。
// 所以放在这里，两边都 import 同一份。

export function safeProjectId(projectId) {
  const raw = String(projectId || "unknown");
  return `p_${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}

// 早期用的是「把不合法字符换成下划线」的命名。旧目录还在盘上，读取时要认得它，
// 所以这个函数不能删 —— 它只用于【读】，写一律用上面那个。
export function legacySafeProjectId(projectId) {
  const raw = String(projectId || "unknown");
  const safe = raw.replace(/[^A-Za-z0-9._-]+/gu, "_") || "unknown";
  if (safe === raw) return safe;
  return `${safe}-${createHash("sha256").update(raw).digest("hex").slice(0, 10)}`;
}
