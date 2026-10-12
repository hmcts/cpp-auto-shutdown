import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { command, fixture, observation, writeObservation } from "./helpers.js";

const script = new URL("../../scripts/state/state-write-validate.sh", import.meta.url);
function run(fix, observations, scratch, expected = "123", env = {}) {
  return command("bash", [script.pathname, "--observations-dir", observations,
    "--expected-run-ids", expected, "--scratch-dir", scratch], {
    cwd: fix.directory,
    env: { ...fix.env, STATE_REPO_URL: fix.bare, STATE_BRANCH: "main",
      STATE_REPO_DIR: fix.repo, ...env }
  });
}
function setup(fix) {
  const observations = join(fix.directory, "observations");
  const scratch = join(fix.directory, "results");
  mkdirSync(observations);
  mkdirSync(scratch);
  return { observations, scratch };
}

test("validator accepts a newer child observation and records the refreshed base", t => {
  const fix = fixture(t);
  const { observations, scratch } = setup(fix);
  const path = writeObservation(observations, "observation-steccm43_123", observation());
  const result = run(fix, observations, scratch);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(readFileSync(join(scratch, "validate-result.json"), "utf8"));
  assert.deepEqual(value.rejectedStacks, []);
  assert.match(value.baseSha, /^[0-9a-f]{40}$/);
  assert.equal(readFileSync(path, "utf8").length > 0, true);
});

test("validator rejects malformed and unknown observations without deleting them", t => {
  const fix = fixture(t);
  const { observations, scratch } = setup(fix);
  const malformed = writeObservation(observations, "observation-steccm43_123", "{");
  const unknown = writeObservation(observations, "observation-unknown_123", observation({ stack: "OTHER" }));
  const result = run(fix, observations, scratch);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(scratch, "validate-result.json"), "utf8")).rejectedStacks,
    ["STECCM43", "UNKNOWN"]);
  assert.equal(readFileSync(malformed, "utf8"), "{");
  assert.ok(readFileSync(unknown, "utf8").includes("OTHER"));
});

test("validator deletes foreign child runs and older duplicate observations", t => {
  const fix = fixture(t);
  const { observations, scratch } = setup(fix);
  const foreign = writeObservation(observations, "observation-steccm43_999", observation({ sourceRunId: 999 }));
  const older = writeObservation(observations, "observation-steccm43_123", observation({
    observedAt: "2030-01-01T00:00:00.000Z"
  }));
  const newer = writeObservation(observations, "observation-STECCM43_124", observation({
    sourceRunId: 124, observedAt: "2030-01-01T00:00:00.000Z"
  }));
  const result = run(fix, observations, scratch, "123,124");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(scratch, "validate-result.json"), "utf8")).rejectedStacks, []);
  assert.equal(readdirSync(join(observations, "observation-steccm43_999")).length, 0);
  assert.equal(readdirSync(join(observations, "observation-steccm43_123")).length, 0);
  assert.ok(readFileSync(newer, "utf8").includes('"sourceRunId":124'));
});

test("validator accepts an empty directory and reports clone failures as faults", t => {
  const fix = fixture(t);
  const { observations, scratch } = setup(fix);
  const empty = run(fix, observations, scratch);
  assert.equal(empty.status, 0, empty.stderr);
  const missingRepo = join(fix.directory, "missing-writer");
  rmSync(missingRepo, { recursive: true, force: true });
  const failed = run({ ...fix, repo: missingRepo }, observations, scratch, "123", {
    STATE_REPO_URL: join(fix.directory, "not-a-repo")
  });
  assert.notEqual(failed.status, 0);
});
