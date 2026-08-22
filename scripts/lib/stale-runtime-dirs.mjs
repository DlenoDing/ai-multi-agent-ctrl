import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

// 控制面 e2e 每跑一次就在 .runtime 下留一个运行目录，从来没人清 ——
// 2026-08-22 在这台机器上数出 1367 个、3.9GB（而 commit.sh 每次提交都会跑一遍）。
// 规矩：跑成功了自己收掉；失败的留着给人查，但下一轮再来时把超过保留期的收走。
export const DOCTOR_RUNTIME_DIR_PREFIX = "doctor-";
export const DEFAULT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export function sweepStaleDoctorRuntimeDirs(runtimeRoot, options = {}) {
  const staleAfterMs = Number.isFinite(options.staleAfterMs) ? options.staleAfterMs : DEFAULT_STALE_AFTER_MS;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const keep = new Set(options.keep || []);
  const result = {removed: [], keptRecent: [], failed: []};
  let entries;
  try {
    entries = readdirSync(runtimeRoot, {withFileTypes: true});
  } catch {
    // 目录还不存在（第一次跑）：没有可清的，也不该报错。
    return result;
  }
  for (const entry of entries) {
    // 只碰 e2e 自己造的那些。别的东西（真实运行态、截图、人手工放的）一律不动 ——
    // 一个"顺手清理"的动作把人的数据删掉，比不清理坏得多。
    if (!entry.isDirectory() || !entry.name.startsWith(DOCTOR_RUNTIME_DIR_PREFIX)) continue;
    if (keep.has(entry.name)) continue;
    const path = join(runtimeRoot, entry.name);
    let ageMs;
    try {
      ageMs = now - statSync(path).mtimeMs;
    } catch {
      continue;
    }
    // 量不到年龄或还太新的一律留着：删错的代价远大于多占一会儿盘。
    if (!Number.isFinite(ageMs) || ageMs < staleAfterMs) { result.keptRecent.push(entry.name); continue; }
    try {
      rmSync(path, {recursive: true, force: true});
      result.removed.push(entry.name);
    } catch (error) {
      // 清不掉要说出来（正被别的进程用着、权限不够），不能假装清干净了。
      result.failed.push(`${entry.name}（${error?.code || error?.message || "原因不明"}）`);
    }
  }
  return result;
}
