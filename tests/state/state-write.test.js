import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { command, fixture, observation, writeObservation } from "./helpers.js";

const script = new URL("../../scripts/state/state-write.sh", import.meta.url);
function setup(fix, requested, record = observation()) {
  const observations = join(fix.directory, "observations");
  const results = join(fix.directory, "results");
  mkdirSync(observations); mkdirSync(results);
  if (record) writeObservation(observations, "observation-steccm43_123", record);
  const output = join(fix.directory, "github-output.txt");
  return { observations, results, output, requested };
}
function run(fix, paths, env = {}) {
  return command("bash", [script.pathname], { cwd: fix.directory, env: {
    ...fix.env, OBSERVATIONS_DIR: paths.observations, RESULTS_DIR: paths.results,
    EXPECTED_RUN_IDS: "123", REQUESTED_STACKS: paths.requested,
    STATE_REPO_URL: fix.bare, STATE_BRANCH: "main", STATE_REPO_DIR: join(fix.directory, "writer"),
    GITHUB_OUTPUT: paths.output, RETRY_SLEEP_MIN: "0", RETRY_SLEEP_MAX: "0", ...env
  } });
}
function outputs(paths) {
  return Object.fromEntries(readFileSync(paths.output, "utf8").trim().split("\n").map(line => {
    const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
  }));
}

test("wrapper writes success outputs and the requested state map", t => {
  const fix = fixture(t); const paths = setup(fix, "steccm43:stopped");
  const result = run(fix, paths);
  assert.equal(result.status, 0, result.stderr);
  const value = outputs(paths);
  assert.equal(value.writeOutcome, "succeeded");
  assert.equal(value.alertRequired, "false");
  assert.equal(value.reconciliationRequired, "false");
  assert.deepEqual(JSON.parse(value.requestedStacks), ["STECCM43"]);
  assert.deepEqual(JSON.parse(value.requestedStates), { STECCM43: "stopped" });
  assert.deepEqual(JSON.parse(value.acceptedStacks), ["STECCM43"]);
});

test("wrapper reports a partial write when one requested stack has no observation", t => {
  const fix = fixture(t); const paths = setup(fix, "steccm43:stopped,missing:started");
  const result = run(fix, paths);
  assert.equal(result.status, 0, result.stderr);
  const value = outputs(paths);
  assert.equal(value.writeOutcome, "partial");
  assert.equal(value.reconciliationRequired, "true");
  assert.deepEqual(JSON.parse(value.rejectedStacks), ["MISSING"]);
});

test("wrapper rejects requests when no observation is available", t => {
  const fix = fixture(t); const paths = setup(fix, "missing:stopped", null);
  const result = run(fix, paths);
  assert.equal(result.status, 0, result.stderr);
  const value = outputs(paths);
  assert.equal(value.writeOutcome, "rejected");
  assert.deepEqual(JSON.parse(value.acceptedStacks), []);
  assert.deepEqual(JSON.parse(value.rejectedStacks), ["MISSING"]);
});

test("wrapper retries a stale base and recovers on the next attempt", t => {
  const fix = fixture(t); const paths = setup(fix, "steccm43:stopped");
  const hook = join(fix.directory, "advance-remote.sh");
  writeFileSync(hook, `#!/bin/sh\nset -e\nprintf 'race\\n' >> '${join(fix.seed, "race.txt")}'\ngit -C '${fix.seed}' add race.txt\ngit -C '${fix.seed}' -c user.name=Race -c user.email=race@example.invalid commit -m Race\ngit -C '${fix.seed}' push origin HEAD:main\n`);
  chmodSync(hook, 0o755);
  const result = run(fix, paths, { MAX_RETRIES: "2", STATE_WRITE_TEST_MODE: "1",
    STATE_WRITE_TEST_HOOK_BEFORE_PUSH: hook });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputs(paths).writeOutcome, "succeeded");
});

test("wrapper alerts and stops after a rejected remote push", t => {
  const fix = fixture(t); const paths = setup(fix, "steccm43:stopped");
  const hook = join(fix.bare, "hooks/pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho rejected by test policy >&2\nexit 1\n"); chmodSync(hook, 0o755);
  const result = run(fix, paths);
  assert.equal(result.status, 1);
  const value = outputs(paths);
  assert.equal(value.writeOutcome, "git-failed");
  assert.equal(value.alertRequired, "true");
  assert.equal(value.reconciliationRequired, "false");
});

test("wrapper emits script-failure outputs when a child cannot validate", t => {
  const fix = fixture(t); const paths = setup(fix, "steccm43:stopped");
  const result = run(fix, paths, { OBSERVATIONS_DIR: join(fix.directory, "missing-observations") });
  assert.equal(result.status, 1);
  const value = outputs(paths);
  assert.equal(value.writeOutcome, "script-failure");
  assert.equal(value.alertRequired, "true");
  assert.deepEqual(JSON.parse(value.acceptedStacks), []);
  assert.deepEqual(JSON.parse(value.rejectedStacks), []);
});
