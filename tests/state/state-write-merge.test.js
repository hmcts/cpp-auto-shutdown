import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { command, fixture, observation, writeObservation } from "./helpers.js";

const script = new URL("../../scripts/state/state-write-merge.sh", import.meta.url);
function setup(fix, records = {}) {
  const observations = join(fix.directory, "observations");
  const scratch = join(fix.directory, "results");
  mkdirSync(observations);
  mkdirSync(scratch);
  writeFileSync(join(scratch, "validate-result.json"), JSON.stringify({ rejectedStacks: ["OTHER"], baseSha: "abc" }));
  for (const [folder, record] of Object.entries(records)) writeObservation(observations, folder, record);
  return { observations, scratch };
}
function run(fix, paths) {
  return command("bash", [script.pathname, "--observations-dir", paths.observations,
    "--scratch-dir", paths.scratch], { cwd: fix.directory, env: {
    ...fix.env, STATE_REPO_DIR: fix.repo
  } });
}

test("merge replaces a record in place and leaves unrelated and rejected records alone", t => {
  const fix = fixture(t);
  const old = observation({ observedAt: "2029-01-01T00:00:00.000Z" });
  const state = { environment: "ste", stacks: { BEFORE: old, STECCM43: old, ORPHAN: old } };
  writeFileSync(join(fix.repo, "state/environments/ste.json"), JSON.stringify(state, null, 2) + "\n");
  const rejected = "not-json";
  const paths = setup(fix, {
    "observation-steccm43_123": observation(),
    "observation-other_123": rejected
  });
  const result = run(fix, paths);
  assert.equal(result.status, 0, result.stderr);
  const merged = JSON.parse(readFileSync(join(fix.repo, "state/environments/ste.json"), "utf8"));
  assert.deepEqual(Object.keys(merged.stacks), ["BEFORE", "STECCM43", "ORPHAN"]);
  assert.equal(merged.stacks.STECCM43.observedAt, "2030-01-01T00:00:00.000Z");
  assert.equal(merged.stacks.ORPHAN.observedAt, "2029-01-01T00:00:00.000Z");
  assert.equal(readFileSync(join(paths.observations, "observation-other_123/observation.json"), "utf8"), rejected);
  assert.deepEqual(JSON.parse(readFileSync(join(paths.scratch, "merge-result.json"), "utf8")), {
    acceptedStacks: ["STECCM43"], sourcePipelines: [404], sourceRunIds: [123]
  });
});

test("merge creates a missing environment state file", t => {
  const fix = fixture(t);
  rmSync(join(fix.repo, "state/environments/ste.json"));
  const paths = setup(fix, { "observation-steccm43_123": observation() });
  const result = run(fix, paths);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(readFileSync(join(fix.repo, "state/environments/ste.json"), "utf8"));
  assert.equal(state.environment, "ste");
  assert.deepEqual(Object.keys(state.stacks), ["STECCM43"]);
});

test("merge rejects a changed state document that fails schema validation", t => {
  const fix = fixture(t);
  const paths = setup(fix, { "observation-steccm43_123": observation({ aggregateStatus: "unknown" }) });
  const result = run(fix, paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /schema|valid/i);
});
