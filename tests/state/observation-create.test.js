import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = join(root, "scripts/state/observation-create.sh");
const directory = () => mkdtempSync(join(tmpdir(), "observation-create-"));
const run = (outputDir, simulate, extra = []) => spawnSync("bash", [script,
  "--stack", "steccm43", "--pipeline", "402", "--expected-state", "started",
  "--simulate", simulate, "--output-dir", outputDir, "--run-id", "123", ...extra
], { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" } });

test("observation modes produce schema-valid component records", t => {
  const output = directory();
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const cases = [
    ["success", ["started", "started", "started"], "started"],
    ["action-failed", ["stopped", "stopped", "stopped"], "stopped"],
    ["partial", ["stopped", "started", "started"], "partial"]
  ];
  for (const [simulate, statuses, aggregate] of cases) {
    const result = run(output, simulate, ["--requested", "false"]);
    assert.equal(result.status, 0, result.stderr);
    const path = join(output, "observation-steccm43", "observation.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(record.stack, "STECCM43");
    assert.deepEqual(record.stackComponents, ["AKS", "IaaS", "PaaS"]);
    assert.deepEqual([record.components.aks.status, record.components.iaas.status,
      record.components.paas.status], statuses);
    assert.deepEqual([record.components.aks.requested, record.components.iaas.requested,
      record.components.paas.requested], [false, false, false]);
    assert.equal(record.aggregateStatus, aggregate);
    assert.equal(record.sourcePipeline, 402);
    assert.equal(record.sourceRunId, 123);
    const wrapped = join(output, "wrapped.json");
    const schema = join(root, "schemas/environment-state.schema.json");
    const document = JSON.stringify({ environment: "ste", stacks: { STECCM43: record } });
    const validation = spawnSync(process.execPath, ["--input-type=module", "-e",
      "import Ajv from 'ajv/dist/2020.js'; import addFormats from 'ajv-formats'; import fs from 'node:fs'; const a=new Ajv({strict:true}); addFormats(a); const v=a.compile(JSON.parse(fs.readFileSync(process.argv[1]))); if(!v(JSON.parse(process.argv[2]))) { console.error(JSON.stringify(v.errors)); process.exit(1); }",
      schema, document], { cwd: root, encoding: "utf8" });
    assert.equal(validation.status, 0, validation.stderr);
    assert.equal(readdirSync(join(output, "observation-steccm43")).includes("observation.json"), true);
  }
});

test("unverifiable component omits the observation", t => {
  const output = directory();
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const result = run(output, "unverifiable:iaas");
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /::warning::/);
  assert.equal(readdirSync(join(output, "observation-steccm43")).includes("observation.json"), false);
});
