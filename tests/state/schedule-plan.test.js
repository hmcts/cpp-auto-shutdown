import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url));
const planner = join(root, "scripts/state/schedule-plan.mjs");
function fixture(t, exceptions = "exceptions: []\n") {
  const directory = mkdtempSync(join(tmpdir(), "schedule-plan-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, "stacks.yaml");
  const exceptionFile = join(directory, "exceptions.yaml");
  const stateDir = join(directory, "state"); mkdirSync(stateDir);
  writeFileSync(config, "stacks:\n  - id: STECCM43\n    environment: ste\n    components: [AKS, IaaS, PaaS]\n  - id: DEVCCM01\n    environment: dev\n    components: [AKS]\n");
  writeFileSync(exceptionFile, exceptions);
  writeFileSync(join(stateDir, "ste.json"), JSON.stringify({ environment: "ste", stacks: {} }));
  writeFileSync(join(stateDir, "dev.json"), JSON.stringify({ environment: "dev", stacks: {} }));
  const holidays = join(directory, "holidays.json");
  writeFileSync(holidays, JSON.stringify({ "england-and-wales": { events: [] } }));
  return { directory, config, exceptionFile, stateDir, holidays };
}
function run(files, args, output = "") {
  return spawnSync(process.execPath, [planner, ...args], { cwd: root, encoding: "utf8",
    env: { ...process.env, STACKS_FILE: files.config, EXCEPTIONS_FILE: files.exceptionFile,
      STATE_DIR: files.stateDir, GITHUB_OUTPUT: output } });
}
function summary(result) { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); }

test("planner starts during baseline weekday hours and stops outside them", t => {
  const files = fixture(t);
  const start = summary(run(files, ["--now", "2026-10-12T08:00:00Z", "--environments", "ste",
    "--stacks", "steccm43", "--bank-holidays", files.holidays]));
  assert.deepEqual(start.start, [{ stack: "steccm43", environment: "ste" }]);
  assert.deepEqual(start.stop, []);
  assert.equal(start.hasWork, true);
  assert.equal(start.requestedStacks, "steccm43:started");
  const output = join(files.directory, "github-output");
  const stop = summary(run(files, ["--now", "2026-10-12T20:00:00Z", "--environments", "ste",
    "--stacks", "steccm43", "--bank-holidays", files.holidays], output));
  assert.deepEqual(stop.stop, [{ stack: "steccm43", environment: "ste" }]);
  assert.match(readFileSync(output, "utf8"), /^start=/);
});

test("planner stops on weekends and injected bank holidays unless applied exception overrides", t => {
  const files = fixture(t);
  const holidayFile = join(files.directory, "holidays.json");
  writeFileSync(holidayFile, JSON.stringify({ "england-and-wales": { events: [{ date: "2026-10-12", title: "Test holiday" }] } }));
  const weekend = summary(run(files, ["--now", "2026-10-17T10:00:00Z", "--stacks", "steccm43",
    "--bank-holidays", holidayFile]));
  assert.deepEqual(weekend.stop, [{ stack: "steccm43", environment: "ste" }]);
  const holiday = summary(run(files, ["--now", "2026-10-12T08:00:00Z", "--stacks", "steccm43",
    "--bank-holidays", holidayFile]));
  assert.deepEqual(holiday.stop, [{ stack: "steccm43", environment: "ste" }]);
  writeFileSync(files.exceptionFile, `exceptions:\n  - stacks: [STECCM43]\n    start: 2026-10-17\n    end: 2026-10-17\n    window: 24h\n    applied: true\n`);
  const exception = summary(run(files, ["--now", "2026-10-17T10:00:00Z", "--stacks", "steccm43",
    "--bank-holidays", holidayFile]));
  assert.deepEqual(exception.start, [{ stack: "steccm43", environment: "ste" }]);
});

test("planner omits matching observations and includes partial, missing, stale-state and forced stacks", t => {
  const files = fixture(t);
  const stePath = join(files.stateDir, "ste.json");
  writeFileSync(stePath, JSON.stringify({ environment: "ste", stacks: { STECCM43: { aggregateStatus: "started" } } }));
  const atWork = ["--now", "2026-10-12T08:00:00Z", "--environments", "ste", "--stacks", "steccm43",
    "--bank-holidays", files.holidays];
  assert.equal(summary(run(files, atWork)).hasWork, false);
  writeFileSync(stePath, JSON.stringify({ environment: "ste", stacks: { STECCM43: { aggregateStatus: "partial" } } }));
  assert.equal(summary(run(files, atWork)).hasWork, true);
  writeFileSync(stePath, JSON.stringify({ environment: "ste", stacks: {} }));
  assert.equal(summary(run(files, [...atWork, "--force"])).hasWork, true);
  assert.equal(summary(run(files, [...atWork, "--environments", "dev", "--stacks", "devccm01"])).hasWork, true);
});

