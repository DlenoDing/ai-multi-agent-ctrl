import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { testRepositoryConnection } from "../apps/control-plane-ui/lib/git-connection-test.mjs";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid"
};

function git(args, options = {}) {
  return execFileSync("git", args, {encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: gitEnv, ...options});
}

function makeRemote(base) {
  const remote = join(base, "remote.git");
  const work = join(base, "seed");
  git(["init", "--bare", remote]);
  git(["init", "-b", "main", work]);
  writeFileSync(join(work, "README.md"), "# repository connection test\n");
  git(["-C", work, "add", "README.md"]);
  git(["-C", work, "commit", "-q", "-m", "init"]);
  git(["-C", work, "push", "-q", remote, "HEAD:refs/heads/main"]);
  return remote;
}

function listProbeRefs(remote) {
  return git(["--git-dir", remote, "for-each-ref", "--format=%(refname)", "refs/heads/aimac-connection-check"])
    .split("\n")
    .filter(Boolean);
}

function writeHook(remote, name, body) {
  const hook = join(remote, "hooks", name);
  writeFileSync(hook, body, {mode: 0o700});
  return hook;
}

function assertRuntimeClean(runtimeDir) {
  const root = join(runtimeDir, "git-connection-test");
  const leftovers = existsSync(root) ? readdirSync(root) : [];
  assert.deepEqual(leftovers, [], "temporary git connection runtime directories should be removed");
}

async function withFixture(name, fn) {
  const base = mkFixture(name);
  try {
    await fn(base);
  } finally {
    rmSync(base, {recursive: true, force: true});
  }
}

function mkFixture(name) {
  return mkdtempSync(join(tmpdir(), `aimac-repository-write-check-${name}-`));
}

function realGitPath() {
  return execFileSync("which", ["git"], {encoding: "utf8"}).trim();
}

async function defaultReadUnchanged() {
  await withFixture("read", async (base) => {
    const remote = makeRemote(base);
    const runtimeDir = join(base, "runtime");
    const result = await testRepositoryConnection({url: remote, defaultBranch: "main", mode: "none", runtimeDir, timeoutMs: 20000});
    assert.equal(result.ok, true);
    assert.equal(result.refCount, 1);
    assert.equal(result.defaultBranchFound, true);
    assert.equal(Object.hasOwn(result, "read"), false);
    assert.equal(Object.hasOwn(result, "write"), false);
    assertRuntimeClean(runtimeDir);
  });
}

async function writeProbeCreatesAndCleansTemporaryRef() {
  await withFixture("write-clean", async (base) => {
    const remote = makeRemote(base);
    const runtimeDir = join(base, "runtime");
    const result = await testRepositoryConnection({url: remote, defaultBranch: "main", mode: "none", runtimeDir, timeoutMs: 20000, verifyWrite: true});
    assert.equal(result.ok, true);
    assert.equal(result.read.ok, true);
    assert.equal(result.write.ok, true);
    assert.match(result.write.probeRef, /^refs\/heads\/aimac-connection-check\//u);
    assert.equal(result.write.permissionScope, "temporary_ref_only");
    assert.equal(result.write.protectedBranchPermissionVerified, false);
    assert.equal(result.write.cleanup.ok, true);
    assert.deepEqual(listProbeRefs(remote), [], "successful write probe should not leave temporary refs");
    assertRuntimeClean(runtimeDir);
  });
}

async function rejectingHookDoesNotLeaveTemporaryRef() {
  await withFixture("reject", async (base) => {
    const remote = makeRemote(base);
    writeHook(remote, "pre-receive", "#!/bin/sh\nprintf '%s\\n' 'write probe rejected by test hook' >&2\nexit 1\n");
    const runtimeDir = join(base, "runtime");
    const result = await testRepositoryConnection({url: remote, defaultBranch: "main", mode: "none", runtimeDir, timeoutMs: 20000, verifyWrite: true});
    assert.equal(result.ok, false);
    assert.equal(result.read.ok, true);
    assert.equal(result.write.ok, false);
    assert.match(result.detail, /rejected by test hook|pre-receive hook declined|failed to push/u);
    assert.equal(result.write.cleanup.status, "not_needed");
    assert.deepEqual(listProbeRefs(remote), [], "rejected write probe should not leave temporary refs");
    assertRuntimeClean(runtimeDir);
  });
}

async function creationPushUsesEmptyExpectedLease() {
  const source = readFileSync(new URL("../apps/control-plane-ui/lib/git-connection-test.mjs", import.meta.url), "utf8");
  assert.match(source, /`--force-with-lease=\$\{probeRef\}:`/u);
}

async function raceCreatedProbeRefIsNotOverwrittenOrDeleted() {
  await withFixture("race", async (base) => {
    const remote = makeRemote(base);
    const seedSha = git(["--git-dir", remote, "rev-parse", "refs/heads/main"]).trim();
    const fakeBin = join(base, "bin");
    const fakeGit = join(fakeBin, "git");
    mkdirSync(fakeBin, {recursive: true});
    writeFileSync(fakeGit, [
      "#!/bin/sh",
      "is_push=0",
      "is_dry_run=0",
      "probe_ref=",
      "for arg in \"$@\"; do",
      "  [ \"$arg\" = \"push\" ] && is_push=1",
      "  [ \"$arg\" = \"--dry-run\" ] && is_dry_run=1",
      "  case \"$arg\" in *:refs/heads/aimac-connection-check/*) probe_ref=${arg#*:};; esac",
      "done",
      "if [ \"$is_push\" = 1 ] && [ \"$is_dry_run\" = 0 ] && [ -n \"$probe_ref\" ]; then",
      "  \"$REAL_GIT\" --git-dir \"$AIMAC_RACE_REMOTE\" update-ref \"$probe_ref\" refs/heads/main",
      "fi",
      "exec \"$REAL_GIT\" \"$@\"",
      ""
    ].join("\n"), {mode: 0o700});
    const runtimeDir = join(base, "runtime");
    const oldEnv = {
      PATH: process.env.PATH,
      REAL_GIT: process.env.REAL_GIT,
      AIMAC_RACE_REMOTE: process.env.AIMAC_RACE_REMOTE
    };
    const realGit = realGitPath();
    try {
      process.env.PATH = `${fakeBin}:${process.env.PATH || ""}`;
      process.env.REAL_GIT = realGit;
      process.env.AIMAC_RACE_REMOTE = remote;
      const result = await testRepositoryConnection({url: remote, defaultBranch: "main", mode: "none", runtimeDir, timeoutMs: 20000, verifyWrite: true});
      assert.equal(result.ok, false);
      assert.equal(result.write.push.ok, false);
      assert.equal(result.write.cleanup.status, "pending");
      assert.equal(result.write.cleanup.observedSha, seedSha);
      assert.deepEqual(listProbeRefs(remote), [result.write.probeRef], "race-created ref should remain for manual review, not be overwritten or deleted");
      git(["--git-dir", remote, "update-ref", "-d", result.write.probeRef]);
      assert.deepEqual(listProbeRefs(remote), []);
    } finally {
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assertRuntimeClean(runtimeDir);
  });
}

async function cleanupFailureReportsProbeRefAndLease() {
  await withFixture("cleanup-failure", async (base) => {
    const remote = makeRemote(base);
    const hook = writeHook(remote, "update", [
      "#!/bin/sh",
      "ref=\"$1\"",
      "new=\"$3\"",
      "case \"$ref:$new\" in",
      "  refs/heads/aimac-connection-check/*:0000000000000000000000000000000000000000) printf '%s\\n' 'delete rejected by test hook' >&2; exit 1;;",
      "esac",
      "exit 0",
      ""
    ].join("\n"));
    const runtimeDir = join(base, "runtime");
    const result = await testRepositoryConnection({url: remote, defaultBranch: "main", mode: "none", runtimeDir, timeoutMs: 20000, verifyWrite: true});
    assert.equal(result.ok, false);
    assert.equal(result.write.push.ok, true);
    assert.equal(result.write.cleanup.ok, false);
    assert.equal(result.write.cleanup.attempted, true);
    assert.equal(result.write.cleanup.status, "pending");
    assert.match(result.write.probeRef, /^refs\/heads\/aimac-connection-check\//u);
    assert.match(result.write.cleanup.lease, /^[0-9a-f]{40}$/u);
    const refs = listProbeRefs(remote);
    assert.deepEqual(refs, [result.write.probeRef], "cleanup failure should identify the leftover temporary ref");
    rmSync(hook, {force: true});
    git(["--git-dir", remote, "update-ref", "-d", result.write.probeRef]);
    assert.deepEqual(listProbeRefs(remote), [], "test fixture cleanup should remove the intentionally stranded ref");
    assertRuntimeClean(runtimeDir);
  });
}

async function timeoutIsSharedAcrossWriteStages() {
  await withFixture("timeout", async (base) => {
    const remote = makeRemote(base);
    writeHook(remote, "pre-receive", "#!/bin/sh\nsleep 2\nexit 0\n");
    const runtimeDir = join(base, "runtime");
    const result = await testRepositoryConnection({url: remote, defaultBranch: "main", mode: "none", runtimeDir, timeoutMs: 200, verifyWrite: true});
    assert.equal(result.ok, false);
    assert.equal(result.reason, "repository_connection_timeout");
    assert.equal(result.write.ok, false);
    assert.match(result.write.cleanup.status, /^(confirmed_absent|uncertain)$/u);
    assert.deepEqual(listProbeRefs(remote), [], "timed out write probe should not leave temporary refs");
    assertRuntimeClean(runtimeDir);
  });
}

async function timedOutPushWithTimedOutRefCheckLeavesUncertainCleanup() {
  await withFixture("uncertain", async (base) => {
    const remote = makeRemote(base);
    const runtimeDir = join(base, "runtime");
    const fakeBin = join(base, "bin");
    const marker = join(base, "push-started");
    const fakeGit = join(fakeBin, "git");
    mkdirSync(fakeBin, {recursive: true});
    writeFileSync(fakeGit, [
      "#!/bin/sh",
      "is_push=0",
      "is_ls_remote=0",
      "is_dry_run=0",
      "for arg in \"$@\"; do",
      "  [ \"$arg\" = \"push\" ] && is_push=1",
      "  [ \"$arg\" = \"ls-remote\" ] && is_ls_remote=1",
      "  [ \"$arg\" = \"--dry-run\" ] && is_dry_run=1",
      "done",
      "if [ \"$is_push\" = 1 ] && [ \"$is_dry_run\" = 0 ]; then",
      "  : > \"$AIMAC_FAKE_GIT_MARKER\"",
      "  sleep 2",
      "fi",
      "if [ \"$is_ls_remote\" = 1 ] && [ -f \"$AIMAC_FAKE_GIT_MARKER\" ]; then",
      "  sleep 2",
      "fi",
      "exec \"$REAL_GIT\" \"$@\"",
      ""
    ].join("\n"), {mode: 0o700});
    const oldEnv = {
      PATH: process.env.PATH,
      REAL_GIT: process.env.REAL_GIT,
      AIMAC_FAKE_GIT_MARKER: process.env.AIMAC_FAKE_GIT_MARKER
    };
    const realGit = realGitPath();
    try {
      process.env.PATH = `${fakeBin}:${process.env.PATH || ""}`;
      process.env.REAL_GIT = realGit;
      process.env.AIMAC_FAKE_GIT_MARKER = marker;
      const result = await testRepositoryConnection({url: remote, defaultBranch: "main", mode: "none", runtimeDir, timeoutMs: 1000, verifyWrite: true});
      assert.equal(result.ok, false);
      assert.equal(result.reason, "repository_connection_timeout");
      assert.ok(result.write.push, JSON.stringify(result));
      assert.equal(result.write.push.ok, false);
      assert.equal(result.write.cleanup.ok, false, JSON.stringify(result));
      assert.equal(result.write.cleanup.attempted, false);
      assert.equal(result.write.cleanup.status, "uncertain");
      assert.equal(result.write.cleanup.probeRef, result.write.probeRef);
    } finally {
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assertRuntimeClean(runtimeDir);
  });
}

async function inheritedGitEnvironmentDoesNotChangeSavedCredentialProbe() {
  await withFixture("git-env", async (base) => {
    const remote = makeRemote(base);
    const runtimeDir = join(base, "runtime");
    const oldEnv = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
      HOME: process.env.HOME
    };
    try {
      process.env.GIT_DIR = join(base, "does-not-exist.git");
      process.env.GIT_WORK_TREE = join(base, "does-not-exist-worktree");
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
      process.env.GIT_CONFIG_VALUE_0 = "never";
      process.env.HOME = join(base, "host-home-that-should-not-be-used");
      const result = await testRepositoryConnection({
        url: remote,
        defaultBranch: "main",
        mode: "api_key",
        username: "",
        secret: "saved-token",
        runtimeDir,
        timeoutMs: 20000,
        verifyWrite: true
      });
      assert.equal(result.ok, true);
      assert.deepEqual(listProbeRefs(remote), []);
    } finally {
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assertRuntimeClean(runtimeDir);
  });
}

async function askpassScriptDoesNotContainSecret() {
  await withFixture("askpass", async (base) => {
    const remote = makeRemote(base);
    const runtimeDir = join(base, "runtime");
    const secret = "repository-write-check-secret";
    const seen = [];
    const probe = testRepositoryConnection({url: remote, defaultBranch: "main", mode: "api_key", username: "", secret, runtimeDir, timeoutMs: 20000, verifyWrite: true});
    const spyRoot = join(runtimeDir, "git-connection-test");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const dirs = existsSync(spyRoot) ? readdirSync(spyRoot) : [];
      for (const dir of dirs) {
        const script = join(spyRoot, dir, "askpass.sh");
        if (existsSync(script)) seen.push({content: readFileSync(script, "utf8"), mode: statSync(script).mode & 0o777});
      }
      if (seen.length) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const result = await probe;
    assert.equal(result.ok, true);
    assert.ok(seen.length > 0, "askpass script should be observable during authenticated probe");
    for (const item of seen) {
      assert.equal(item.content.includes(secret), false, "askpass script should not write the secret to disk");
      assert.equal(item.mode & 0o077, 0, "askpass script should not be group/world-readable");
    }
    assert.equal(JSON.stringify(result).includes(secret), false, "connection result should not expose the secret");
    assertRuntimeClean(runtimeDir);
  });
}

const tests = [
  defaultReadUnchanged,
  writeProbeCreatesAndCleansTemporaryRef,
  rejectingHookDoesNotLeaveTemporaryRef,
  creationPushUsesEmptyExpectedLease,
  raceCreatedProbeRefIsNotOverwrittenOrDeleted,
  cleanupFailureReportsProbeRefAndLease,
  timeoutIsSharedAcrossWriteStages,
  timedOutPushWithTimedOutRefCheckLeavesUncertainCleanup,
  inheritedGitEnvironmentDoesNotChangeSavedCredentialProbe,
  askpassScriptDoesNotContainSecret
];

for (const test of tests) {
  await test();
  console.log(`ok ${test.name}`);
}
