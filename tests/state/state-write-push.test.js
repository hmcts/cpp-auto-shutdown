import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { command, fixture, git, observation } from "./helpers.js";

const script = new URL("../../scripts/state/state-write-push.sh", import.meta.url);
function setup(fix, accepted = ["STECCM43"]) {
  const scratch = join(fix.directory, "results");
  mkdirSync(scratch);
  writeFileSync(join(scratch, "validate-result.json"), JSON.stringify({
    rejectedStacks: [], baseSha: git(["rev-parse", "HEAD"], fix.repo, fix.env)
  }));
  writeFileSync(join(scratch, "merge-result.json"), JSON.stringify({
    acceptedStacks: accepted, sourcePipelines: [404], sourceRunIds: [123]
  }));
  if (accepted.length) {
    const path = join(fix.repo, "state/environments/ste.json");
    const state = JSON.parse(readFileSync(path, "utf8"));
    state.stacks.STECCM43 = observation();
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
  }
  return scratch;
}
function run(fix, scratch, env = {}) {
  return command("bash", [script.pathname, "--scratch-dir", scratch], {
    cwd: fix.directory, env: { ...fix.env, STATE_REPO_DIR: fix.repo, STATE_BRANCH: "main", ...env }
  });
}

test("push commits only environment state and never prints the token", t => {
  const fix = fixture(t);
  const scratch = setup(fix);
  writeFileSync(join(fix.repo, "config/unrelated.txt"), "must not be staged\n");
  const secret = "dummy-state-write-token";
  const result = run(fix, scratch, { STATE_WRITE_TOKEN: secret });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
  const value = JSON.parse(readFileSync(join(scratch, "push-result.json"), "utf8"));
  assert.equal(value.writeOutcome, "succeeded");
  assert.match(value.writtenCommitSha, /^[0-9a-f]{40}$/);
  const changed = git(["show", "--pretty=format:", "--name-only", "HEAD"], fix.repo, fix.env).trim().split("\n");
  assert.deepEqual(changed, ["state/environments/ste.json"]);
  assert.equal(git(["--git-dir", fix.bare, "rev-parse", "refs/heads/main"], fix.directory, fix.env), value.writtenCommitSha);
});

test("push succeeds without a commit when state is unchanged", t => {
  const fix = fixture(t);
  const scratch = setup(fix, []);
  const result = run(fix, scratch);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::warning::/);
  const value = JSON.parse(readFileSync(join(scratch, "push-result.json"), "utf8"));
  assert.equal(value.writeOutcome, "succeeded");
  assert.equal(value.writtenCommitSha, JSON.parse(readFileSync(join(scratch, "validate-result.json"), "utf8")).baseSha);
});

test("push reports a moved remote base as stale-base", t => {
  const fix = fixture(t);
  const scratch = setup(fix);
  writeFileSync(join(fix.seed, "concurrent.txt"), "remote advanced\n");
  git(["add", "concurrent.txt"], fix.seed, fix.env);
  git(["commit", "-m", "Advance remote"], fix.seed, fix.env);
  git(["push", "origin", "HEAD:main"], fix.seed, fix.env);
  const result = run(fix, scratch);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(readFileSync(join(scratch, "push-result.json"), "utf8")).writeOutcome, "stale-base");
});

test("push classifies pre-receive rejection as git-failed", t => {
  const fix = fixture(t);
  const scratch = setup(fix);
  const hook = join(fix.bare, "hooks/pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho rejected by test policy >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const result = run(fix, scratch);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(readFileSync(join(scratch, "push-result.json"), "utf8")).writeOutcome, "git-failed");
});
