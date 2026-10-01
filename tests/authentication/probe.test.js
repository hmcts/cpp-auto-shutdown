import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("../../scripts/app-write-probe.sh", import.meta.url));
const sha = "a".repeat(40);
const token = "dummy-offline-token-never-use-live";

// Every Git call goes through this stub. Unexpected calls fail, never fall back to real Git.
const fakeGit = `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(process.env.GIT_LOG, JSON.stringify(args) + '\\n');
const command = args[0] === '-c' ? args.slice(2) : args;
const operation = command[0];
if (process.env.FAIL_OPERATION === operation) process.exit(42);
switch (operation) {
  case 'clone': {
    const repo = command.at(-1);
    mkdirSync(repo);
    writeFileSync(process.env.WORKDIR_RECORD, repo.slice(0, -5));
    if (process.env.EXISTING_MARKER === 'true') {
      writeFileSync(join(repo, 'app-write-probe-' + process.env.GITHUB_RUN_ID + '-' + process.env.GITHUB_RUN_ATTEMPT + '.txt'), 'existing');
    }
    const user = spawnSync(process.env.GIT_ASKPASS, ['Username for GitHub'], { encoding: 'utf8' });
    const password = spawnSync(process.env.GIT_ASKPASS, ['Password for GitHub'], { encoding: 'utf8' });
    const unknown = spawnSync(process.env.GIT_ASKPASS, ['Unexpected prompt'], { encoding: 'utf8' });
    if (user.stdout.trim() !== 'x-access-token' || password.stdout.trim() !== process.env.APP_TOKEN || unknown.status === 0) process.exit(43);
    if (process.env.GIT_TERMINAL_PROMPT !== '0') process.exit(44);
    break;
  }
  case 'config': break;
  case 'add':
    writeFileSync(process.env.MARKER_RECORD, JSON.stringify({ name: command[2], content: readFileSync(command[2], 'utf8') }));
    break;
  case 'diff': {
    const marker = JSON.parse(readFileSync(process.env.MARKER_RECORD, 'utf8')).name;
    console.log(process.env.EXTRA_STAGED === 'true' ? marker + '\\nstate/environments/dev.json' : marker);
    break;
  }
  case 'commit': break;
  case 'rev-parse': console.log(process.env.INVALID_SHA === 'true' ? 'invalid' : '${sha}'); break;
  case 'push': break;
  case 'ls-remote':
    console.log((process.env.WRONG_SHA === 'true' ? '${"b".repeat(40)}' : '${sha}') + '\\trefs/heads/main');
    break;
  default: process.exit(45);
}
`;

function runProbe(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "offline-app-probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  writeFileSync(join(bin, "git"), fakeGit, { mode: 0o700 });
  const log = join(dir, "git-log");
  const workdirRecord = join(dir, "workdir-record");
  const markerRecord = join(dir, "marker-record");
  const result = spawnSync("/bin/bash", [script], {
    cwd: dir,
    encoding: "utf8",
    timeout: 10000,
    // Deliberately do not inherit GITHUB_* or credentials from the caller.
    env: {
      PATH: `${bin}:/usr/bin:/bin`, TMPDIR: dir, HOME: dir,
      GIT_LOG: log, WORKDIR_RECORD: workdirRecord, MARKER_RECORD: markerRecord,
      GITHUB_REPOSITORY: "hmcts/cpp-auto-shutdown", GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
      CONFIRM_WRITE: "true", APP_TOKEN: token, APP_SLUG: "cpp-github-management",
      APP_INSTALLATION_ID: "31986882", EXPECTED_INSTALLATION_ID: "31986882",
      ...overrides
    }
  });
  assert.ifError(result.error);
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  const marker = existsSync(markerRecord) ? JSON.parse(readFileSync(markerRecord, "utf8")) : null;
  if (existsSync(workdirRecord)) {
    assert.equal(existsSync(readFileSync(workdirRecord, "utf8")), false, "temporary authentication directory cleaned up");
  }
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith("tmp.")), [], "cleanup also occurs when clone fails");
  assert.ok(!`${result.stdout}${result.stderr}${JSON.stringify(calls)}${JSON.stringify(marker)}`.includes(token));
  return { ...result, calls, marker };
}

test("valid manual probe uses only the scoped marker and ordinary main push", t => {
  const result = runProbe(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.marker, {
    name: "app-write-probe-123-1.txt", content: "GitHub Actions run 123, attempt 1\n"
  });
  const clone = result.calls.find(args => args.includes("clone"));
  assert.deepEqual(clone.slice(0, -1), [
    "-c", "credential.helper=", "clone", "--quiet", "--single-branch", "--branch", "main",
    "https://github.com/hmcts/cpp-auto-shutdown.git"
  ]);
  assert.deepEqual(result.calls.find(args => args[0] === "add"), ["add", "--", result.marker.name]);
  assert.deepEqual(result.calls.find(args => args.includes("push")), [
    "-c", "credential.helper=", "push", "origin", "HEAD:refs/heads/main"
  ]);
  assert.ok(result.calls.every(args => args.every(arg => !arg.startsWith("--force") && arg !== "-f")));
  assert.match(result.stdout, new RegExp(`Verified main at ${sha}, marker app-write-probe-123-1.txt`));
});

test("rerun attempts use distinct markers", t => {
  const first = runProbe(t);
  const second = runProbe(t, { GITHUB_RUN_ATTEMPT: "2" });
  assert.equal(second.status, 0, second.stderr);
  assert.notEqual(first.marker.name, second.marker.name);
});

for (const [label, overrides, message] of [
  ["missing token", { APP_TOKEN: "" }, "GitHub App token is missing"],
  ["wrong repository", { GITHUB_REPOSITORY: "other/repo" }, "Unexpected repository"],
  ["feature ref", { GITHUB_REF: "refs/heads/feature" }, "Probe must run from main"],
  ["automatic event", { GITHUB_EVENT_NAME: "push" }, "Probe must be dispatched manually"],
  ["unconfirmed write", { CONFIRM_WRITE: "false" }, "Explicit write acknowledgement"],
  ["missing run ID", { GITHUB_RUN_ID: "" }, "Invalid GitHub run ID"],
  ["invalid run ID", { GITHUB_RUN_ID: "123/../../state" }, "Invalid GitHub run ID"],
  ["invalid attempt", { GITHUB_RUN_ATTEMPT: "0" }, "Invalid GitHub run attempt"],
  ["wrong App", { APP_SLUG: "different-app" }, "Unexpected GitHub App"],
  ["missing expected installation", { EXPECTED_INSTALLATION_ID: "" }, "Expected installation ID"],
  ["wrong installation", { APP_INSTALLATION_ID: "123" }, "Unexpected GitHub App installation"]
]) {
  test(`${label} fails before any Git operation`, t => {
    const result = runProbe(t, overrides);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(message));
    assert.deepEqual(result.calls, []);
  });
}

for (const operation of ["clone", "commit", "push", "ls-remote"]) {
  test(`${operation} failure propagates without retry`, t => {
    const result = runProbe(t, { FAIL_OPERATION: operation });
    assert.equal(result.status, 42);
    assert.equal(result.calls.filter(args => args.includes(operation)).length, 1);
    assert.ok(!result.stdout.includes("Verified main"));
    if (["clone", "commit"].includes(operation)) {
      assert.ok(!result.calls.some(args => args.includes("push")));
    }
  });
}

for (const [label, overrides, message] of [
  ["existing marker", { EXISTING_MARKER: "true" }, "Probe marker already exists"],
  ["extra staged state file", { EXTRA_STAGED: "true" }, "Unexpected staged files"],
  ["invalid commit SHA", { INVALID_SHA: "true" }, "Invalid probe commit SHA"]
]) {
  test(`${label} prevents the push`, t => {
    const result = runProbe(t, overrides);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(message));
    assert.ok(!result.calls.some(args => args.includes("push")));
  });
}

test("remote SHA mismatch is a failure, never silently reported as success", t => {
  const result = runProbe(t, { WRONG_SHA: "true" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /main no longer points at the probe commit/);
  assert.ok(!result.stdout.includes("Verified main"));
});