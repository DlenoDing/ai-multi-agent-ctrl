import { readFileSync } from "node:fs";

// 变异门被硬杀时，工作区里会留着一份被改坏的源码，同时留下一张恢复便条。
// 下一次启动本会自动照便条还原 —— 但【拿不到锁】的那次不会：它在 acquireLock 里就退出了，
// 而它当时对人说的是"删掉锁文件后重试"，一个字都没提磁盘上还躺着一份 `if (false)` 版本的源码。
// 照着那句话做的人会先删锁，然后拿这份坏代码去跑别的门、甚至提交（2026-08-21 我自己就差点）。
// 所以拒绝启动时必须把残局一起说出来：哪个文件、以及"重跑本门会自动收拾"。
export function describePendingWreckage(notePath, readFile = readFileSync) {
  let note = null;
  try { note = JSON.parse(readFile(notePath, "utf8")); } catch { return ""; }
  if (!note?.path) return "";
  let onDisk = null;
  try { onDisk = readFile(note.path, "utf8"); } catch { return ""; }
  if (onDisk === note.original) return "";       // 已经好了，便条过期，不必吓人
  if (onDisk !== note.mutated) {
    return `\n  ⚠ 上一轮还留着 ${note.path} 没收尾，而它现在既不是原内容也不是本门改坏的那份 —— `
      + "有人在这中间改过它，本门不会自动写回，请对照 git diff 手工确认。";
  }
  return `\n  ⚠ 同时：上一轮被中断，${note.path} 现在是【被本门改坏】的那份，还没还原。`
    + "\n    在还原之前不要拿这份代码跑别的门或提交 —— 重新跑一次本门就会照便条自动收拾。";
}
