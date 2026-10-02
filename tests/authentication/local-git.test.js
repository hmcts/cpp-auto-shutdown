import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/app-write-probe.sh", import.meta.url));
const token = "dummy-offline-local-git-token";
// Resolve Git before adding the wrapper to PATH. No caller Git configuration is inherited.
const lookup = spawnSync("/bin/sh", ["-c", "command -v git"], {
  encoding: "utf8", env: { PATH: process.env.PATH || "/usr/bin:/bin" }
});
assert.ifError(lookup.error);
assert.equal(lookup.status, 0, lookup.stderr);
const realGit = realpathSync(lookup.stdout.trim());

// This is an allowlist, not a general URL rewriter. All other Git calls fail closed.
const wrapper = `#!${process.execPath}
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const env = process.env;
const args = process.argv.slice(2);
const same = expected => JSON.stringify(args) === JSON.stringify(expected);
const marker = 'app-write-probe-' + env.GITHUB_RUN_ID + '-' + env.GITHUB_RUN_ATTEMPT + '.txt';
const invoke = (argv, cwd = process.cwd()) => {
  const result = spawnSync(env.REAL_GIT, argv, { cwd, env, encoding: 'utf8', timeout: 10000 });
  if (result.error || result.signal) throw new Error('Local Git did not complete');
  return result;
};
const checked = (argv, cwd) => {
  const result = invoke(argv, cwd);
  if (result.status !== 0) throw new Error('Local fixture Git operation failed');
  return result.stdout.trim();
};
let delegated = args;
let allowed = false;
if (args.length === 9 && same([
  '-c', 'credential.helper=', 'clone', '--quiet', '--single-branch', '--branch', 'main',
  'https://github.com/hmcts/cpp-auto-shutdown.git', args.at(-1)
])) {
  // Exact source URL and a destination inside the dedicated probe temporary directory only.
  const destination = args.at(-1);
  if (dirname(dirname(destination)) !== env.TMPDIR || !destination.endsWith('/repo')) process.exit(90);
  delegated = args.map((arg, index) => index === 7 ? env.LOCAL_BARE : arg);
  writeFileSync(env.WORKDIR_RECORD, dirname(destination));
  allowed = true;
} else {
  const cwd = realpathSync(process.cwd());
  if (dirname(dirname(cwd)) !== env.TMPDIR || !cwd.endsWith('/repo')) process.exit(91);
  allowed = [
    ['config', 'user.name', 'cpp-github-management[bot]'],
    ['config', 'user.email', 'devops-team@hmcts.net'],
    ['add', '--', marker], ['diff', '--cached', '--name-only'],
    ['commit', '-m', 'Probe GitHub App write access (' + env.GITHUB_RUN_ID + '/' + env.GITHUB_RUN_ATTEMPT + ')'],
    ['rev-parse', 'HEAD'],
    ['rev-parse', 'refs/remotes/origin/main'],
    ['-c', 'credential.helper=', 'push', 'origin', 'HEAD:refs/heads/main'],
    ['-c', 'credential.helper=', 'fetch', '--quiet', 'origin', 'refs/heads/main:refs/remotes/origin/main']
  ].some(same);
  if (args[0] === 'merge-base') {
    const probe = readFileSync(env.PROBE_SHA_RECORD, 'utf8');
    const fetched = checked(['rev-parse', 'refs/remotes/origin/main']);
    if (!/^[0-9a-f]{40}$/.test(probe) || !/^[0-9a-f]{40}$/.test(fetched)) process.exit(96);
    allowed = same(['merge-base', '--is-ancestor', probe, fetched]) &&
      fetched === checked(['--git-dir', env.LOCAL_BARE, 'rev-parse', 'refs/heads/main']);
  }
  if (args.includes('push') || args.includes('fetch') || args[0] === 'merge-base') {
    if (checked(['config', '--get', 'remote.origin.url']) !== env.LOCAL_BARE) process.exit(92);
    const pushUrl = invoke(['config', '--get-all', 'remote.origin.pushurl']);
    if (pushUrl.status !== 1 || pushUrl.stdout.trim() !== '') process.exit(92);
  }
}
if (!allowed) process.exit(93);
const advanceWriter = afterPush => {
  if (checked(['config', '--get', 'remote.origin.url'], env.WRITER) !== env.LOCAL_BARE) process.exit(92);
  const pushUrl = invoke(['config', '--get-all', 'remote.origin.pushurl'], env.WRITER);
  if (pushUrl.status !== 1 || pushUrl.stdout.trim() !== '') process.exit(92);
  if (afterPush) {
    // Base the ordinary descendant push on the probe commit, not the stale writer clone.
    checked(['-c', 'credential.helper=', 'fetch', '--quiet', 'origin', 'refs/heads/main:refs/remotes/origin/main'], env.WRITER);
    checked(['reset', '--hard', 'refs/remotes/origin/main'], env.WRITER);
  }
  writeFileSync(join(env.WRITER, 'concurrent.txt'), 'concurrent local writer\\n');
  checked(['add', '--', 'concurrent.txt'], env.WRITER);
  checked(['commit', '-m', 'Concurrent local fixture update'], env.WRITER);
  checked(['push', 'origin', 'HEAD:refs/heads/main'], env.WRITER);
  writeFileSync(env.CONCURRENT_SHA_RECORD, checked(['rev-parse', 'HEAD'], env.WRITER));
};
if (args.includes('push')) {
  writeFileSync(env.PROBE_SHA_RECORD, checked(['rev-parse', 'HEAD']));
  if (env.CONCURRENT === 'before') {
    // A real local writer advances the bare main immediately before the probe's ordinary push.
    advanceWriter(false);
  }
}
const result = invoke(delegated);
if (args.includes('push') && result.status === 0 && env.CONCURRENT === 'after') advanceWriter(true);
appendFileSync(env.GIT_LOG, JSON.stringify({ args, status: result.status }) + '\\n');
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 94);
`;

function fixture(t) {
  // macOS aliases /var to /private/var. Compare canonical fixture paths in the wrapper.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "offline-real-git-probe-")));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, "fixture cleanup");
  });
  const paths = Object.fromEntries(["bin", "home", "tmp", "hooks", "templates", "original", "writer"]
    .map(name => [name, join(root, name)]));
  for (const path of Object.values(paths)) mkdirSync(path);
  const bare = join(root, "remote.git");
  const env = {
    PATH: `${dirname(realGit)}:/usr/bin:/bin`, HOME: paths.home, XDG_CONFIG_HOME: paths.home,
    TMPDIR: paths.tmp, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: paths.hooks,
    GIT_CONFIG_KEY_1: "protocol.allow", GIT_CONFIG_VALUE_1: "never",
    GIT_CONFIG_KEY_2: "protocol.file.allow", GIT_CONFIG_VALUE_2: "always",
    GIT_TEMPLATE_DIR: paths.templates
  };
  const git = (args, cwd = root) => {
    const result = spawnSync(realGit, args, { cwd, env, encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "--bare", "--initial-branch=main", bare]);
  git(["init", "--initial-branch=main"], paths.original);
  const identity = cwd => {
    git(["config", "user.name", "Offline Fixture"], cwd);
    git(["config", "user.email", "offline@example.invalid"], cwd);
  };
  identity(paths.original);
  const files = {
    "config/stacks.yaml": "stacks: []\n",
    "state/environments/dev.json": '{"status":"fixture-only"}\n'
  };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(paths.original, name)), { recursive: true });
    writeFileSync(join(paths.original, name), content);
  }
  git(["add", "--", ...Object.keys(files)], paths.original);
  git(["commit", "-m", "Initial offline fixture"], paths.original);
  git(["remote", "add", "origin", bare], paths.original);
  git(["push", "origin", "HEAD:refs/heads/main"], paths.original);
  const initial = git(["rev-parse", "HEAD"], paths.original);
  git(["clone", "--quiet", "--branch", "main", bare, paths.writer]);
  identity(paths.writer);
  // The caller's dirty tracked state and local-only file must also remain untouched.
  writeFileSync(join(paths.original, "state/environments/dev.json"), "local dirty state\n");
  writeFileSync(join(paths.original, "local-only.txt"), "local only\n");
  const snapshot = () => ({
    head: git(["rev-parse", "HEAD"], paths.original),
    status: git(["status", "--porcelain=v1", "--untracked-files=all"], paths.original),
    config: readFileSync(join(paths.original, ".git/config"), "utf8"),
    contents: [...Object.keys(files), "local-only.txt"].map(name => readFileSync(join(paths.original, name), "utf8"))
  });
  const original = snapshot();
  writeFileSync(join(paths.bin, "package.json"), '{"type":"module"}');
  writeFileSync(join(paths.bin, "git"), wrapper, { mode: 0o700 });
  // macOS mktemp can ignore TMPDIR. Keep the script's scratch directory strictly in this fixture.
  writeFileSync(join(paths.bin, "mktemp"), `#!${process.execPath}
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['-d'])) process.exit(95);
console.log(mkdtempSync(join(process.env.TMPDIR, 'tmp.')));
`, { mode: 0o700 });
  const remote = args => git(["--git-dir", bare, ...args]);
  const run = (attempt = "1", concurrent = "none") => {
    const log = join(root, `calls-${attempt}`);
    const workdir = join(root, `workdir-${attempt}`);
    const probeSha = join(root, `probe-sha-${attempt}`);
    const concurrentSha = join(root, `concurrent-sha-${attempt}`);
    const result = spawnSync("/bin/bash", [script], {
      cwd: paths.original, encoding: "utf8", timeout: 20000,
      env: {
        ...env, PATH: `${paths.bin}:${env.PATH}`, REAL_GIT: realGit, LOCAL_BARE: bare,
        WRITER: paths.writer, CONCURRENT: String(concurrent), GIT_LOG: log,
        WORKDIR_RECORD: workdir, PROBE_SHA_RECORD: probeSha, CONCURRENT_SHA_RECORD: concurrentSha,
        GITHUB_REPOSITORY: "hmcts/cpp-auto-shutdown", GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: attempt,
        CONFIRM_WRITE: "true", APP_TOKEN: token, APP_SLUG: "cpp-github-management",
        APP_INSTALLATION_ID: "123", EXPECTED_INSTALLATION_ID: "123"
      }
    });
    assert.ifError(result.error);
    assert.ok(existsSync(log), `wrapper completed no Git calls (exit ${result.status}): ${result.stderr}`);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(!`${result.stdout}${result.stderr}${JSON.stringify(calls)}`.includes(token), "no token output");
    assert.equal(existsSync(readFileSync(workdir, "utf8")), false, "clone and askpass directory removed");
    assert.deepEqual(readdirSync(paths.tmp), [], "no probe temporary files left");
    assert.deepEqual(snapshot(), original, "original working tree, HEAD and local config preserved");
    assert.equal(calls.filter(call => call.args.includes("clone")).length, 1);
    assert.equal(calls.filter(call => call.args.includes("push")).length, 1, "no push retry");
    for (const [name, content] of Object.entries(files)) {
      assert.equal(remote(["show", `main:${name}`]), content.trim(), "remote state/config preserved");
    }
    assert.equal(remote(["for-each-ref", "--format=%(refname)"]), "refs/heads/main");
    return { ...result, calls, probe: readFileSync(probeSha, "utf8"), concurrentSha };
  };
  const tree = () => remote(["ls-tree", "-r", "--name-only", "main"]).split("\n");
  return { run, remote, tree, initial, files };
}

test("real local Git writes one marker commit and attempt 2 preserves both markers", t => {
  const f = fixture(t);
  let parent = f.initial;
  const markers = [];
  for (const attempt of ["1", "2"]) {
    const result = f.run(attempt);
    assert.equal(result.status, 0, result.stderr);
    const head = f.remote(["rev-parse", "main"]);
    const marker = `app-write-probe-123-${attempt}.txt`;
    assert.equal(head, result.probe);
    assert.equal(f.remote(["rev-list", "--parents", "-n", "1", "main"]), `${head} ${parent}`);
    assert.equal(f.remote(["diff-tree", "--no-commit-id", "--name-status", "-r", parent, head]), `A\t${marker}`);
    assert.equal(f.remote(["rev-list", "--count", "main"]), String(Number(attempt) + 1));
    assert.ok(result.stdout.endsWith(`Verified probe commit ${result.probe} in main at ${head}, marker ${marker}\n`));
    assert.equal(result.calls.find(call => call.args.includes("push")).status, 0);
    assert.deepEqual(result.calls.slice(-3), [
      { args: ["-c", "credential.helper=", "fetch", "--quiet", "origin", "refs/heads/main:refs/remotes/origin/main"], status: 0 },
      { args: ["rev-parse", "refs/remotes/origin/main"], status: 0 },
      { args: ["merge-base", "--is-ancestor", result.probe, head], status: 0 }
    ]);
    markers.push(marker);
    assert.deepEqual(f.tree(), [...Object.keys(f.files), ...markers].sort());
    for (const [index, name] of markers.entries()) {
      assert.equal(f.remote(["show", `main:${name}`]), `GitHub Actions run 123, attempt ${index + 1}`);
    }
    parent = head;
  }
});

test("real local Git rejects a stale-base push without retry or token output", t => {
  const f = fixture(t);
  const result = f.run("1", "before");
  assert.notEqual(result.status, 0);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /\[rejected\].*(fetch first|non-fast-forward)/);
  const push = result.calls.find(call => call.args.includes("push"));
  assert.equal(push.status, 1, "real Git rejected the ordinary push");
  assert.deepEqual(push.args, ["-c", "credential.helper=", "push", "origin", "HEAD:refs/heads/main"]);
  assert.equal(result.calls.filter(call => call.args[0] === "commit").length, 1);
  assert.ok(!result.calls.some(call => call.args.includes("fetch") || call.args.includes("merge-base")));
  assert.ok(!result.stdout.includes("Verified probe commit"));
  const concurrent = readFileSync(result.concurrentSha, "utf8");
  assert.equal(f.remote(["rev-parse", "main"]), concurrent);
  assert.notEqual(concurrent, result.probe);
  assert.equal(f.remote(["rev-list", "--parents", "-n", "1", "main"]), `${concurrent} ${f.initial}`);
  assert.equal(f.remote(["rev-list", "--count", "main"]), "2");
  assert.equal(f.remote(["diff-tree", "--no-commit-id", "--name-status", "-r", f.initial, concurrent]), "A\tconcurrent.txt");
  assert.equal(f.remote(["show", "main:concurrent.txt"]), "concurrent local writer");
  assert.deepEqual(f.tree(), [...Object.keys(f.files), "concurrent.txt"].sort());
});

test("real local Git verifies a concurrent descendant after the successful probe push", t => {
  const f = fixture(t);
  const result = f.run("1", "after");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  const concurrent = readFileSync(result.concurrentSha, "utf8");
  const marker = "app-write-probe-123-1.txt";
  assert.notEqual(concurrent, result.probe);
  assert.equal(f.remote(["rev-parse", "main"]), concurrent);
  assert.equal(f.remote(["rev-list", "--parents", "-n", "1", result.probe]), `${result.probe} ${f.initial}`);
  assert.equal(f.remote(["rev-list", "--parents", "-n", "1", "main"]), `${concurrent} ${result.probe}`);
  assert.equal(f.remote(["rev-list", "--count", "main"]), "3");
  assert.equal(f.remote(["diff-tree", "--no-commit-id", "--name-status", "-r", f.initial, result.probe]), `A\t${marker}`);
  assert.equal(f.remote(["diff-tree", "--no-commit-id", "--name-status", "-r", result.probe, concurrent]), "A\tconcurrent.txt");
  assert.equal(f.remote(["show", `main:${marker}`]), "GitHub Actions run 123, attempt 1");
  assert.equal(f.remote(["show", "main:concurrent.txt"]), "concurrent local writer");
  assert.deepEqual(f.tree(), [...Object.keys(f.files), marker, "concurrent.txt"].sort());
  assert.equal(result.calls.find(call => call.args.includes("push")).status, 0);
  assert.deepEqual(result.calls.slice(-3), [
    { args: ["-c", "credential.helper=", "fetch", "--quiet", "origin", "refs/heads/main:refs/remotes/origin/main"], status: 0 },
    { args: ["rev-parse", "refs/remotes/origin/main"], status: 0 },
    { args: ["merge-base", "--is-ancestor", result.probe, concurrent], status: 0 }
  ]);
  assert.ok(result.stdout.endsWith(`Verified probe commit ${result.probe} in main at ${concurrent}, marker ${marker}\n`));
});