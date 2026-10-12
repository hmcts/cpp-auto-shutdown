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

test("reconciliation and 416 workflows preserve bounded retry and single-write contracts", () => {
  const reconciliation = workflow("state-reconciliation");
  assert.deepEqual(Object.keys(reconciliation.on), ["workflow_call", "workflow_dispatch"]);
  assert.deepEqual(reconciliation.permissions, { contents: "read" });
  const reconcileJob = reconciliation.jobs.reconcile;
  assert.equal(reconcileJob.environment, "state-writer");
  const attempts = reconcileJob.steps.filter(step => /Attempt [123] observation/.test(step.name || ""));
  const writes = reconcileJob.steps.filter(step => /Attempt [123] state write/.test(step.name || ""));
  assert.equal(attempts.length, 3);
  assert.equal(writes.length, 3);
  assert.ok(writes.every(step => step["continue-on-error"] === true));
  assert.ok(reconcileJob.steps.some(step => step.run?.includes("state-write-alert.sh")));

  const scheduler = workflow("custom-auto-startup-shutdown");
  assert.deepEqual(Object.keys(scheduler.on), ["workflow_dispatch"]);
  assert.deepEqual(scheduler.permissions, { contents: "read" });
  assert.equal(scheduler.concurrency, undefined);
  assert.ok(!("schedule" in scheduler.on));
  const plan = scheduler.jobs.plan;
  for (const output of ["start", "stop", "requestedStacks", "hasWork"]) assert.ok(plan.outputs[output]);
  for (const [name, workflowPath, output] of [["start", "full-environment-start.yaml", "start"],
    ["stop", "full-environment-shutter.yaml", "stop"]]) {
    const child = scheduler.jobs[name];
    assert.equal(child.uses, `./.github/workflows/${workflowPath}`);
    assert.equal(child.strategy["fail-fast"], false);
    assert.equal(child.strategy.matrix.include, `\${{ fromJSON(needs.plan.outputs.${output}) }}`);
    assert.equal(child.with.stateWriteMode, "orchestrated");
  }
  const writer = scheduler.jobs["state-write"];
  assert.deepEqual(writer.needs, ["plan", "start", "stop"]);
  assert.equal(writer.environment, "state-writer");
  const download = writer.steps.find(step => step.uses === "actions/download-artifact@v4");
  assert.equal(download.with.pattern, "observation-*");
  assert.equal(download.with["merge-multiple"], false);
  assert.equal(writer.steps.find(step => step.id === "write").env.EXPECTED_RUN_IDS, "\${{ github.run_id }}");
  assert.ok(scheduler.jobs["resolve-targets"].steps.some(step => step.run?.includes("reconciliation-resolve-targets.sh")));
  const matrix = scheduler.jobs.reconcile.strategy;
  assert.equal(matrix["max-parallel"], 1);
  assert.equal(matrix["fail-fast"], false);
  assert.ok(scheduler.jobs.reconcile.uses.endsWith("state-reconciliation.yaml"));
});

test("reconciliation observations preserve child run and expected action provenance", () => {
  const steps = workflow("state-reconciliation").jobs.reconcile.steps;
  const observations = steps.filter(step => /Attempt [123] observation/.test(step.name || ""));
  assert.equal(observations.length, 3);
  assert.ok(observations.every(step => step.run.includes("--pipeline") && step.run.includes("inputs.expectedState") && step.run.includes("--requested true")));
});
