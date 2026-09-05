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

/**
 * @param {object} input
 * @param {string} input.url 仓库地址（调用方先过 isSafeGitRemoteUrl）
 * @param {string} input.defaultBranch 默认分支：报告远端上有没有它
 * @param {"none"|"account_password"|"api_key"} input.mode
 * @param {string} [input.username]
 * @param {string|null} [input.secret] 已解开的密码 / API Key；mode none 时忽略
 * @param {string} input.runtimeDir askpass 临时目录的落点
 * @param {number} input.timeoutMs 墙钟超时
 */
export async function testRepositoryConnection({url, defaultBranch = "main", mode = "none", username = "", secret = null, runtimeDir, timeoutMs}) {
  const startedAt = Date.now();
  const authDir = join(runtimeDir, "git-connection-test", randomBytes(8).toString("hex"));
  let authEnv = {};
  try {
    if (mode !== "none") {
      authEnv = writeAskpass(authDir, username || (mode === "api_key" ? "x-access-token" : ""), secret);
    }
    const env = {...process.env, GIT_ALLOW_PROTOCOL: "file:https:ssh:git", GIT_TERMINAL_PROMPT: "0", ...authEnv};
    let stdout = "";
    try {
      ({stdout} = await execFileAsync("git", ["ls-remote", "--heads", "--", url], {env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024}));
    } catch (error) {
      const timedOut = Boolean(error?.killed) || error?.signal === "SIGTERM";
      return {
        ok: false,
        reason: classifyGitRemoteFailure(error?.stderr, {timedOut}),
        detail: timedOut ? `${timeoutMs} ms 内没有应答` : scrubConnectionDetail(error?.stderr || error?.message, secret),
        durationMs: Date.now() - startedAt
      };
    }
    const heads = String(stdout).split("\n").filter(Boolean).map((line) => line.split(/\s+/u)[1] || "");
    return {
      ok: true,
      refCount: heads.length,
      defaultBranchFound: heads.includes(`refs/heads/${defaultBranch}`),
      durationMs: Date.now() - startedAt
    };
  } finally {
    rmSync(authDir, {recursive: true, force: true});
  }
}
