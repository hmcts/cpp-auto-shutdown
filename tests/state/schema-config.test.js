import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url));
const run = (script, args) => spawnSync(process.execPath, [join(root, script), ...args], {
  cwd: root, encoding: "utf8"
});

test("schema validator accepts the checked-in STE state", () => {
  const result = run("scripts/state/schema-validate.mjs", [
    "schemas/environment-state.schema.json", "state/environments/ste.json"
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("schema validator reports invalid environment values", () => {
  const directory = mkdtempSync(join(tmpdir(), "state-schema-"));
  try {
    const stateFile = join(directory, "invalid.json");
    const state = JSON.parse(readFileSync(join(root, "state/environments/ste.json"), "utf8"));
    state.environment = "prod";
    writeFileSync(stateFile, JSON.stringify(state));
    const result = run("scripts/state/schema-validate.mjs", [
      "schemas/environment-state.schema.json", stateFile
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /environment|must be equal to one of the allowed values/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("config lookup resolves a stack id case-insensitively", () => {
  const result = run("scripts/state/config-stack.mjs", ["config/stacks.yaml", "steccm43"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    id: "STECCM43", environment: "ste", components: ["AKS", "IaaS", "PaaS"]
  });
});

test("config lookup rejects an unknown stack", () => {
  const result = run("scripts/state/config-stack.mjs", ["config/stacks.yaml", "unknown"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown/i);
});
