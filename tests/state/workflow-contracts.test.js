import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../..", import.meta.url));
const workflow = name => parse(readFileSync(join(root, `.github/workflows/${name}.yaml`), "utf8"));

test("start and shutter are manual/reusable workflows with consistent inputs and permissions", () => {
  for (const [name, pipeline, expected, order] of [
    ["full-environment-start", 402, "started", ["PAAS", "IaaS", "AKS"]],
    ["full-environment-shutter", 404, "stopped", ["AKS", "IaaS", "PAAS"]]
  ]) {
    const value = workflow(name);
    assert.deepEqual(Object.keys(value.on), ["workflow_dispatch", "workflow_call"]);
    assert.deepEqual(value.permissions, { contents: "read" });
    for (const trigger of [value.on.workflow_dispatch, value.on.workflow_call]) {
      assert.deepEqual(Object.keys(trigger.inputs), ["stack", "stateWriteMode", "simulate"]);
      assert.equal(trigger.inputs.stack.required, true);
      assert.equal(trigger.inputs.stateWriteMode.default, "direct");
      assert.equal(trigger.inputs.simulate.default, "success");
    }
    const env = value.jobs.environment;
    const names = env.steps.map(step => step.name || step.id || "");
    const simulation = order.map(component => names.indexOf(`Simulate ${component}`));
    assert.ok(simulation.every(index => index >= 0));
    assert.deepEqual(simulation, [...simulation].sort((a, b) => a - b));
    const observation = env.steps.find(step => step.id === "observation");
    assert.equal(observation.if, "always()");
    assert.ok(observation.run.includes(`--pipeline ${pipeline}`));
    assert.ok(observation.run.includes(`--expected-state ${expected}`));
    const upload = env.steps.find(step => step.uses === "actions/upload-artifact@v4");
    assert.equal(upload.if, "always()");
    assert.equal(upload.with["if-no-files-found"], "warn");
    assert.ok(!env.steps.some(step => step.uses === "./.github/actions/state-write-token"));
    const writer = value.jobs["state-write"];
    assert.equal(writer.needs, "environment");
    assert.match(writer.if, /always\(\)/);
    assert.match(writer.if, /direct/);
    assert.equal(writer.environment, "state-writer");
    assert.ok(writer.steps.some(step => step.uses === "./.github/actions/state-write-token"));
    assert.ok(writer.steps.some(step => step.run === "bash scripts/state/state-write.sh"));
    for (const output of ["writeOutcome", "alertRequired", "reconciliationRequired", "requestedStacks",
      "requestedStates", "acceptedStacks", "rejectedStacks", "baseSha"]) assert.ok(writer.outputs[output]);
    assert.equal(value.concurrency, undefined);
  }
});
