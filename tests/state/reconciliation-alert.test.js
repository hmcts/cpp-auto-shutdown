import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url));
const resolver = join(root, "scripts/state/reconciliation-resolve-targets.sh");
const alert = join(root, "scripts/state/state-write-alert.sh");
function runResolver(outcome, rejected = ["STECCM43"], states = { STECCM43: "stopped" }) {
  return spawnSync("bash", [resolver], { cwd: root, encoding: "utf8", env: {
    ...process.env, WRITE_OUTCOME: outcome, REQUESTED_STACKS: '["STECCM43","DEVCCM01"]',
    REJECTED_STACKS: JSON.stringify(rejected), REQUESTED_STATES: JSON.stringify(states), GITHUB_OUTPUT: ""
  } });
}

test("partial/rejected outcomes select only rejected stacks", () => {
  for (const outcome of ["partial", "rejected"]) {
    const result = runResolver(outcome);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /stacksJson=\[/);
    assert.match(result.stdout, /matrix=\{"include":\[/);
    assert.ok(result.stdout.includes('"stack":"STECCM43"'));
    assert.ok(!result.stdout.includes("DEVCCM01"));
  }
});

test("stale-base and unrecognized outcomes safely select every requested stack", () => {
  for (const outcome of ["stale-base", "unexpected"]) {
    const result = runResolver(outcome, [], { STECCM43: "stopped", DEVCCM01: "started" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("DEVCCM01"));
    if (outcome === "unexpected") assert.match(result.stdout, /::warning::/);
  }
});

test("resolver fails without a valid requested state and emits no matrix", () => {
  const result = runResolver("stale-base", [], { STECCM43: "unknown" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::/);
  assert.doesNotMatch(result.stdout, /matrix=/);
});

test("alert without Slack includes an error, run link, and summary without secrets", t => {
  const directory = mkdtempSync(join(tmpdir(), "state-alert-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const summary = join(directory, "summary.md");
  const secret = "https://hooks.slack.invalid/never-print-this";
  const result = spawnSync("bash", [alert, "--case", "git-failed", "--details", "Push was rejected"], {
    cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary,
      GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "hmcts/cpp-auto-shutdown",
      GITHUB_RUN_ID: "42", SLACK_WEBHOOK_URL: "" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::error::/);
  assert.ok(readFileSync(summary, "utf8").includes("https://github.com/hmcts/cpp-auto-shutdown/actions/runs/42"));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
});
test("alert identifies exhausted reconciliation attempts", () => {
  const result = spawnSync("bash", [alert, "--case", "reconciliation-failed"], {
    cwd: root, encoding: "utf8", env: { ...process.env, SLACK_WEBHOOK_URL: "" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::error::/);
  assert.match(result.stdout, /all three reconciliation attempts failed/i);
});
