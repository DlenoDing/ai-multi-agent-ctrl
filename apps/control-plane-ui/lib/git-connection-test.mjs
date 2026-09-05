// 项目仓库「测试连接」：用【已保存】的仓库地址与凭证跑一次 `git ls-remote`，把 git 的英文 stderr 归成
// 几类人能处置的原因。此前凭证配错要等派发失败才知道（而且 agent 那边只报 git_command_failed）。
//
// 密钥只走本次 git 子进程的 askpass 环境变量：脚本本身不含密钥、跑完即删；不进日志、不进响应、
// 不进状态文件（响应里的 detail 会先把密钥与 URL 里的 user:pass 抹掉）。
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
const CLEANUP_RESERVE_MAX_MS = 5000;
const CLEANUP_RESERVE_MIN_MS = 50;
const WRITE_PROBE_REF_PREFIX = "refs/heads/aimac-connection-check";
const WRITE_PROBE_FILE = "AIMAC_CONNECTION_CHECK.txt";
const SYNTHETIC_GIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: "AIMAC Connection Check",
  GIT_AUTHOR_EMAIL: "aimac-connection-check@example.invalid",
  GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "AIMAC Connection Check",
  GIT_COMMITTER_EMAIL: "aimac-connection-check@example.invalid",
  GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z"
});

// 界面按这张表给中文（console 门核每一项都有中文）。前五种是 git 握手的归类，后两种在跑 git 之前就能判定。
export const REPOSITORY_CONNECTION_REASONS = Object.freeze([
  "repository_auth_failed",
  "repository_not_found",
  "repository_unreachable",
  "repository_connection_timeout",
  "repository_connection_failed",
  "credential_missing",
  "repository_credential_unreadable"
]);

// 认证问题要排在「找不到仓库」之前：GitHub/GitLab 对没权限的私有仓库也回 404 / "not found"，
// 但同一段 stderr 里通常先有 "Authentication failed" / "Permission denied"。
export function classifyGitRemoteFailure(stderr, {timedOut = false} = {}) {
  if (timedOut) return "repository_connection_timeout";
  const text = String(stderr || "");
  if (/authentication failed|could not read username|could not read password|invalid username or password|permission denied|access denied|returned error: 40[13]\b|http 40[13]\b/iu.test(text)) {
    return "repository_auth_failed";
  }
  if (/does not appear to be a git repository|not a git repository|repository .*not found|returned error: 404\b|no such file or directory|could not read from remote repository/iu.test(text)) {
    return "repository_not_found";
  }
  if (/could not resolve host|unable to access|connection refused|connection timed out|network is unreachable|failed to connect|name or service not known|no route to host/iu.test(text)) {
    return "repository_unreachable";
  }
  return "repository_connection_failed";
}

// 把密钥与 URL 里的 user:pass@ 抹掉后再交给人看：git 的报错会把它拉取的 URL 原样打出来。
export function scrubConnectionDetail(text, secret) {
  let value = String(text || "").replace(/\s+/gu, " ").trim();
  if (secret) value = value.split(String(secret)).join("***");
  value = value.replace(/(\w+:\/\/)[^/\s@]+@/gu, "$1***@");
  return value.slice(0, 400);
}

function writeAskpass(dir, username, secret) {
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const script = join(dir, "askpass.sh");
  // git 先问 "Username for ..." 再问 "Password for ..."：脚本只按提示词回相应的环境变量，密钥不落在脚本里。
  writeFileSync(script, "#!/bin/sh\ncase \"$1\" in *sername*) printf '%s\\n' \"$AIMAC_GIT_USERNAME\";; *) printf '%s\\n' \"$AIMAC_GIT_SECRET\";; esac\n", {mode: 0o700});
  return {GIT_ASKPASS: script, GIT_TERMINAL_PROMPT: "0", AIMAC_GIT_USERNAME: username, AIMAC_GIT_SECRET: String(secret)};
}

function gitArgs(args) {
  // The empty credential.helper resets configured helpers so the probe uses only the saved credential/askpass path.
  return ["-c", "credential.helper=", "-c", "credential.useHttpPath=true", ...args];
}

function sanitizedProcessEnv({isolateHome = false, homeDir = ""} = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^GIT_/u.test(key)) continue;
    if (key === "SSH_ASKPASS" || key === "SSH_ASKPASS_REQUIRE" || key === "DISPLAY") continue;
    env[key] = value;
  }
  if (isolateHome) env.HOME = env.USERPROFILE = homeDir;
  return env;
}

function connectionEnv(authDir, authEnv = {}, options = {}) {
  const xdgConfigHome = join(authDir, "xdg");
  mkdirSync(xdgConfigHome, {recursive: true, mode: 0o700});
  const isolatedGlobalConfig = join(authDir, "gitconfig");
  writeFileSync(isolatedGlobalConfig, "", {mode: 0o600});
  return {
    ...sanitizedProcessEnv(options),
    GIT_ALLOW_PROTOCOL: "file:https:ssh:git",
    GIT_CONFIG_GLOBAL: isolatedGlobalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
    XDG_CONFIG_HOME: xdgConfigHome,
    ...authEnv
  };
}

function remainingTimeout(deadline) {
  return Math.max(1, deadline - Date.now());
}

function cleanupReserveMs(totalTimeoutMs) {
  const total = Math.max(1, Number(totalTimeoutMs) || 30000);
  return Math.min(CLEANUP_RESERVE_MAX_MS, Math.max(CLEANUP_RESERVE_MIN_MS, Math.floor(total * 0.2)), Math.max(1, Math.floor(total / 2)));
}

function beforeCleanupDeadline(deadline, totalTimeoutMs) {
  return Date.now() + Math.max(1, remainingTimeout(deadline) - cleanupReserveMs(totalTimeoutMs));
}

function commandFailure(error, secret, timeoutMs) {
  const timedOut = Boolean(error?.killed) || error?.signal === "SIGTERM" || error?.signal === "SIGKILL";
  const output = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join(" ");
  return {
    ok: false,
    reason: classifyGitRemoteFailure(output, {timedOut}),
    detail: timedOut ? `${timeoutMs} ms 内没有应答` : scrubConnectionDetail(output, secret),
    ...(timedOut ? {timedOut: true} : {})
  };
}

function stageFailure(result) {
  return {ok: false, reason: result.reason, detail: result.detail, ...(result.timedOut ? {timedOut: true} : {})};
}

async function runGit(args, {cwd, env, deadline, secret}) {
  const timeout = remainingTimeout(deadline);
  try {
    const result = await execFileAsync("git", gitArgs(args), {cwd, env, timeout, maxBuffer: GIT_MAX_BUFFER});
    return {ok: true, stdout: result.stdout || "", stderr: result.stderr || "", durationMs: timeout - remainingTimeout(deadline)};
  } catch (error) {
    return {...commandFailure(error, secret, timeout), durationMs: timeout - remainingTimeout(deadline)};
  }
}

function readStageFromHeads(stdout, defaultBranch, startedAt) {
  const heads = String(stdout).split("\n").filter(Boolean).map((line) => line.split(/\s+/u)[1] || "");
  return {
    ok: true,
    refCount: heads.length,
    defaultBranchFound: heads.includes(`refs/heads/${defaultBranch}`),
    durationMs: Date.now() - startedAt
  };
}

async function readRepositoryHeads({url, defaultBranch, env, deadline, secret}) {
  const startedAt = Date.now();
  const result = await runGit(["ls-remote", "--heads", "--", url], {env, deadline, secret});
  if (!result.ok) return {...result, durationMs: Date.now() - startedAt};
  return readStageFromHeads(result.stdout, defaultBranch, startedAt);
}

function writeProbeRef() {
  const stamp = new Date().toISOString().replace(/[^0-9T]/gu, "").toLowerCase();
  return `${WRITE_PROBE_REF_PREFIX}/${stamp}-${randomBytes(8).toString("hex")}`;
}

async function makeSyntheticCommit({workDir, env, deadline, secret}) {
  mkdirSync(workDir, {recursive: true, mode: 0o700});
  let result = await runGit(["init", "-q", workDir], {env, deadline, secret});
  if (!result.ok) return result;
  writeFileSync(join(workDir, WRITE_PROBE_FILE), "AIMAC repository connection write probe\n", {mode: 0o600});
  result = await runGit(["add", "--", WRITE_PROBE_FILE], {cwd: workDir, env, deadline, secret});
  if (!result.ok) return result;
  result = await runGit(["commit", "-q", "-m", "AIMAC repository connection write probe"], {cwd: workDir, env: {...env, ...SYNTHETIC_GIT_ENV}, deadline, secret});
  if (!result.ok) return result;
  result = await runGit(["rev-parse", "HEAD"], {cwd: workDir, env, deadline, secret});
  if (!result.ok) return result;
  return {ok: true, commit: String(result.stdout || "").trim()};
}

async function remoteRefSha({workDir, remoteName, probeRef, env, deadline, secret}) {
  const result = await runGit(["ls-remote", "--heads", remoteName, probeRef], {cwd: workDir, env, deadline, secret});
  if (!result.ok) return result;
  const line = String(result.stdout || "").trim();
  return {ok: true, sha: line ? line.split(/\s+/u)[0] || "" : ""};
}

async function cleanupProbeRef({workDir, remoteName, probeRef, expectedSha, env, deadline, secret}) {
  const deletion = await runGit(["push", "--porcelain", `--force-with-lease=${probeRef}:${expectedSha}`, remoteName, `:${probeRef}`], {cwd: workDir, env, deadline, secret});
  if (!deletion.ok) return {...deletion, attempted: true, status: "pending", probeRef, lease: expectedSha};
  const after = await remoteRefSha({workDir, remoteName, probeRef, env, deadline, secret});
  if (!after.ok) return {...after, attempted: true, status: "uncertain", probeRef, lease: expectedSha};
  if (after.sha) {
    return {ok: false, attempted: true, status: "pending", reason: "repository_connection_failed", detail: "临时写入探测 ref 删除后仍存在", probeRef, lease: expectedSha};
  }
  return {ok: true, attempted: true, status: "deleted", probeRef, lease: expectedSha};
}

function noCleanupNeeded(detail) {
  return {ok: true, attempted: false, status: "not_needed", detail};
}

function cleanupUncertain({probeRef, reason, detail}) {
  return {ok: false, attempted: false, status: "uncertain", probeRef, reason, detail};
}

function cleanupPending({probeRef, observedSha, detail}) {
  return {ok: false, attempted: false, status: "pending", probeRef, observedSha, reason: "repository_connection_failed", detail};
}

async function cleanupAfterAmbiguousPush({workDir, remoteName, probeRef, expectedSha, pushResult, env, deadline, secret}) {
  const afterFailure = await remoteRefSha({workDir, remoteName, probeRef, env, deadline, secret});
  if (!afterFailure.ok) {
    return cleanupUncertain({
      probeRef,
      reason: afterFailure.reason,
      detail: `不能确认临时写入探测 ref 是否已落到远端：${afterFailure.detail || pushResult.detail || "push result uncertain"}`
    });
  }
  if (!afterFailure.sha) {
    return {
      ok: true,
      attempted: false,
      status: pushResult.timedOut ? "confirmed_absent" : "not_needed",
      probeRef,
      detail: pushResult.timedOut ? "push 结果不确定，但复查确认临时写入探测 ref 不存在" : "push 失败前没有创建临时写入探测 ref"
    };
  }
  if (afterFailure.sha !== expectedSha) {
    return cleanupPending({
      probeRef,
      observedSha: afterFailure.sha,
      detail: "临时写入探测 ref 已存在但不是本次合成提交，未删除；需要人工核对"
    });
  }
  return cleanupProbeRef({workDir, remoteName, probeRef, expectedSha, env, deadline, secret});
}

async function verifyRepositoryWrite({url, authRoot, env, deadline, totalTimeoutMs, secret}) {
  const startedAt = Date.now();
  const workDir = join(authRoot, "write-probe");
  const remoteName = "aimac-connection-check";
  const probeRef = writeProbeRef();
  const write = {
    ok: false,
    probeRef,
    permissionScope: "temporary_ref_only",
    protectedBranchPermissionVerified: false,
    dryRun: null,
    push: null,
    cleanup: {ok: true, attempted: false, status: "not_started"}
  };
  const commit = await makeSyntheticCommit({workDir, env, deadline, secret});
  if (!commit.ok) return {...write, ...commit, durationMs: Date.now() - startedAt};
  write.commit = commit.commit;

  let result = await runGit(["remote", "add", remoteName, url], {cwd: workDir, env, deadline, secret});
  if (!result.ok) return {...write, ...result, durationMs: Date.now() - startedAt};

  const existing = await remoteRefSha({workDir, remoteName, probeRef, env, deadline, secret});
  if (!existing.ok) return {...write, ...existing, durationMs: Date.now() - startedAt};
  if (existing.sha) {
    return {
      ...write,
      ok: false,
      reason: "repository_connection_failed",
      detail: "唯一临时写入探测 ref 已存在，已拒绝覆盖",
      durationMs: Date.now() - startedAt
    };
  }

  result = await runGit(["push", "--porcelain", "--dry-run", `--force-with-lease=${probeRef}:`, remoteName, `${commit.commit}:${probeRef}`], {cwd: workDir, env, deadline, secret});
  write.dryRun = result.ok ? {ok: true} : stageFailure(result);
  if (!result.ok) {
    write.cleanup = noCleanupNeeded("dry-run 失败，没有执行真实写入");
    return {...write, ok: false, reason: result.reason, detail: result.detail, durationMs: Date.now() - startedAt};
  }

  result = await runGit(["push", "--porcelain", `--force-with-lease=${probeRef}:`, remoteName, `${commit.commit}:${probeRef}`], {
    cwd: workDir,
    env,
    deadline: beforeCleanupDeadline(deadline, totalTimeoutMs),
    secret
  });
  write.push = result.ok ? {ok: true} : stageFailure(result);
  if (!result.ok) {
    write.cleanup = await cleanupAfterAmbiguousPush({workDir, remoteName, probeRef, expectedSha: commit.commit, pushResult: result, env, deadline, secret});
    return {...write, ok: false, reason: result.reason, detail: result.detail, durationMs: Date.now() - startedAt};
  }

  write.cleanup = await cleanupProbeRef({workDir, remoteName, probeRef, expectedSha: commit.commit, env, deadline, secret});
  if (!write.cleanup.ok) {
    return {
      ...write,
      ok: false,
      reason: write.cleanup.reason || "repository_connection_failed",
      detail: write.cleanup.detail || "临时写入探测 ref 清理失败",
      durationMs: Date.now() - startedAt
    };
  }
  return {...write, ok: true, durationMs: Date.now() - startedAt};
}

/**
 * @param {object} input
 * @param {string} input.url 仓库地址（调用方先过 isSafeGitRemoteUrl）
 * @param {string} input.defaultBranch 默认分支：报告远端上有没有它
 * @param {"none"|"account_password"|"api_key"} input.mode
 * @param {string} [input.username]
 * @param {string|null} [input.secret] 已解开的密码 / API Key；mode none 时忽略
 * @param {string} input.runtimeDir askpass 临时目录的落点
 * @param {number} input.timeoutMs 墙钟超时
 * @param {boolean} [input.verifyWrite=false] 为 true 时会创建并清理唯一临时 ref 来验证写权限
 */
export async function testRepositoryConnection(input) {
  const {url, defaultBranch = "main", mode = "none", username = "", secret = null, runtimeDir, timeoutMs, verifyWrite = false} = input;
  const startedAt = Date.now();
  const authDir = join(runtimeDir, "git-connection-test", randomBytes(8).toString("hex"));
  let authEnv = {};
  try {
    mkdirSync(authDir, {recursive: true, mode: 0o700});
    if (mode !== "none") {
      authEnv = writeAskpass(authDir, username || (mode === "api_key" ? "x-access-token" : ""), secret);
    }
    const totalTimeoutMs = Math.max(1, Number(timeoutMs) || 30000);
    const env = connectionEnv(authDir, authEnv, {isolateHome: mode !== "none", homeDir: authDir});
    const deadline = Date.now() + totalTimeoutMs;
    const read = await readRepositoryHeads({url, defaultBranch, env, deadline, secret});
    if (!verifyWrite) return read;
    if (!read.ok) {
      return {
        ok: false,
        reason: read.reason,
        detail: read.detail,
        durationMs: Date.now() - startedAt,
        read,
        write: {ok: false, skipped: true, reason: read.reason, detail: "read stage failed"}
      };
    }
    const write = await verifyRepositoryWrite({url, authRoot: authDir, env, deadline, totalTimeoutMs, secret});
    return {
      ok: write.ok,
      ...(write.ok ? {} : {reason: write.reason || "repository_connection_failed", detail: write.detail || "写入权限验证失败"}),
      refCount: read.refCount,
      defaultBranchFound: read.defaultBranchFound,
      durationMs: Date.now() - startedAt,
      read,
      write
    };
  } finally {
    rmSync(authDir, {recursive: true, force: true});
  }
}
