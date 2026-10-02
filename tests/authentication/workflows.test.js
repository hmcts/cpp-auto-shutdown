import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const root = new URL("../../", import.meta.url);
const workflow = name => parse(readFileSync(new URL(`.github/workflows/${name}.yaml`, root), "utf8"));

test("live probe is manual, main-only, acknowledged and environment-gated", () => {
  const probe = workflow("github-app-write-probe");
  assert.deepEqual(Object.keys(probe.on), ["workflow_dispatch"]);
  assert.deepEqual(probe.permissions, { contents: "read" });
  assert.deepEqual(probe.concurrency, { group: "github-app-write-probe", "cancel-in-progress": false });
  assert.equal(probe.on.workflow_dispatch.inputs.confirm_write.default, false);
  assert.equal(probe.on.workflow_dispatch.inputs.confirm_write.type, "boolean");
  const job = probe.jobs.probe;
  assert.equal(job.environment, "github-app-write-probe");
  assert.equal(job["timeout-minutes"], 10);
  assert.equal(job.if, "github.repository == 'hmcts/cpp-auto-shutdown' && github.ref == 'refs/heads/main' && inputs.confirm_write");
  assert.equal(job.needs, undefined);
  assert.equal(job.steps[0].with["persist-credentials"], false);
  assert.equal(job.steps[0].with.ref, "${{ github.sha }}");
  const app = job.steps.find(step => step.id === "app-token");
  const configuration = job.steps.find(step => step.name === "Check administrator configuration");
  assert.ok(job.steps.indexOf(configuration) < job.steps.indexOf(app));
  assert.equal(configuration.env.PRIVATE_KEY, "${{ secrets.CPP_GITHUB_MANAGEMENT_PRIVATE_KEY }}");
  for (const input of ["APP_ID", "PRIVATE_KEY", "EXPECTED_INSTALLATION_ID"]) {
    assert.ok(configuration.run.includes(`$${input}`));
  }
  assert.equal(app.uses, "actions/create-github-app-token@v3");
  assert.deepEqual(app.with, {
    "app-id": "${{ vars.CPP_GITHUB_MANAGEMENT_APP_ID }}",
    "private-key": "${{ secrets.CPP_GITHUB_MANAGEMENT_PRIVATE_KEY }}",
    owner: "hmcts", repositories: "cpp-auto-shutdown", "permission-contents": "write"
  });
  assert.equal(job.steps.at(-1).run, "bash scripts/app-write-probe.sh");
  assert.equal(job.steps.at(-1).env.APP_TOKEN, "${{ steps.app-token.outputs.token }}");
  assert.equal(job.steps.at(-1).env.APP_SLUG, "${{ steps.app-token.outputs.app-slug }}");
  assert.equal(job.steps.at(-1).env.APP_INSTALLATION_ID, "${{ steps.app-token.outputs.installation-id }}");
  assert.equal(job.steps.at(-1).env.CONFIRM_WRITE, "${{ inputs.confirm_write }}");
  assert.ok(job.steps.every(step => !step["continue-on-error"]));
});

test("offline CI runs distinct suites using explicit directory inclusion", () => {
  const checkNames = [];
  for (const [name, directory, command] of [
    ["dashboard-tests", "dashboard", "npm run test:dashboard"],
    ["data-validation", "data-validation", "npm run test:data"],
    ["authentication-tests", "authentication", "npm run test:auth"]
  ]) {
    const ci = workflow(name);
    assert.deepEqual(ci.permissions, { contents: "read" });
    for (const event of ["push", "pull_request"]) {
      const paths = ci.on[event].paths;
      assert.ok(paths.includes(`tests/${directory}/**`));
      assert.ok(!paths.includes("tests/**"));
      assert.ok(paths.every(path => !path.startsWith("!")));
      assert.ok(paths.includes(`.github/workflows/${name}.yaml`));
    }
    for (const [id, job] of Object.entries(ci.jobs)) {
      checkNames.push(job.name || id);
      assert.equal(job.environment, undefined);
      const runs = job.steps.map(step => step.run).filter(Boolean);
      assert.ok(runs.includes(command));
      assert.ok(!runs.includes("npm test"));
      assert.ok(!runs.includes("bash scripts/app-write-probe.sh"));
      assert.ok(job.steps.every(step => !step.uses?.includes("create-github-app-token")));
      for (const run of runs.filter(run => /^npm (ci|install)\b/.test(run))) {
        assert.equal(run, "npm ci --ignore-scripts", "dependency installation must not execute lifecycle scripts");
      }
      if (name !== "dashboard-tests") assert.ok(runs.includes("npm ci --ignore-scripts"));
    }
  }
  assert.equal(new Set(checkNames).size, checkNames.length, "suite job check names must be unique");
  const authPaths = workflow("authentication-tests").on.push.paths;
  assert.ok(authPaths.includes("scripts/app-write-probe.sh"));
  assert.ok(authPaths.includes(".github/workflows/github-app-write-probe.yaml"));
  for (const event of ["push", "pull_request"]) {
    for (const name of ["dashboard-tests", "data-validation", "deploy-github-pages"]) {
      assert.ok(workflow("authentication-tests").on[event].paths.includes(`.github/workflows/${name}.yaml`),
        "contract tests must run when an inspected workflow changes");
    }
  }
  for (const name of ["dashboard-tests", "data-validation"]) {
    assert.ok(!workflow(name).on.push.paths.includes("tests/authentication/**"));
  }
});

test("suite runners use portable quoted patterns and aggregate only offline checks", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.equal(scripts["test:dashboard"], 'node --test "tests/dashboard/**/*.test.js"');
  assert.equal(scripts["test:data"], 'node --test "tests/data-validation/**/*.test.js"');
  assert.equal(scripts["test:auth"], 'node --test "tests/authentication/**/*.test.js"');
  assert.equal(scripts.test, "npm run test:dashboard && npm run test:data && npm run test:auth");
  assert.deepEqual(workflow("deploy-github-pages").on.push.paths, ["docs/**"]);
});