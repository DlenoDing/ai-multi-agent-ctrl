// 针对 PostgreSQL 存储的 CAS 探针：拿【调用方指定的版本】去写。
// 两个进程拿同一个版本各自写回时，只能有一个成功 —— 另一个必须收到冲突，
// 而不是把对方的改动整份覆盖掉。版本由父进程读一次后传进来：
// 让两个探针各自去读会变成"先读先写、后读后写"的顺序执行，那样两个都成功是正常的，
// 测的就不是 CAS 了（第一版就是这么写的，白跑一轮）。
import {pgReadStateWithShards, pgWriteStateWithProjectShards} from "../../apps/control-plane-ui/lib/pg-sync-store.mjs";

const marker = process.argv[2];
const expected = Number(process.argv[3]);
// 分片必须【原样带回】：写入方会删掉不在列表里的分片行，传空数组等于把项目分片全清了。
// 第一版就是这么写的 —— CAS 结论虽然对，但顺带毁掉了这套栈，后面的 agentctl doctor 当场报
// project_state_shard_missing。探针不该破坏被测系统。
const {central: state, shards} = pgReadStateWithShards();
const next = {...state, stateVersion: expected + 1,
  // 探针写进去的项目要合它自己的规范（schemaVersion / ownerAccountId / progress 都是必填）：
  // 原先只写了 id/name/status，PG 产出规范核对第一跑就把这条自己种下的记录报了出来。
  projects: [...(state?.projects || []), {schemaVersion: "project/v1", id: `prj_cas_${marker}`, name: `cas-${marker}`,
    organizationId: "org_default", status: "active", ownerAccountId: "acct_system_owner", members: [], progress: {percent: 0, phase: "probe", health: "normal", updatedAt: new Date().toISOString()}}]};
try {
  pgWriteStateWithProjectShards(next, shards || [], expected);
  console.log(JSON.stringify({marker, outcome: "written", expected}));
} catch (error) {
  const conflict = error?.code === "AIMAC_STATE_CONFLICT";
  console.log(JSON.stringify({marker, outcome: conflict ? "conflict" : "error", expected,
    detail: conflict ? undefined : String(error?.message || error).slice(0, 140)}));
}
