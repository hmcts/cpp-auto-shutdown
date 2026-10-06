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

test("authentication CI uses main-only pushes and focused path filters", () => {
  const ci = workflow("authentication-tests");
  assert.deepEqual(Object.keys(ci.on), ["push", "pull_request", "workflow_dispatch"]);
  assert.deepEqual(ci.on.push.branches, ["main"]);
  assert.equal(ci.on.pull_request.branches, undefined);
  const expectedPaths = [
    "tests/authentication/**",
    "scripts/app-write-probe.sh",
    ".github/workflows/github-app-write-probe.yaml",
    ".github/workflows/authentication-tests.yaml",
    ".github/workflows/deploy-github-pages.yaml",
    "package.json"
  ];
  for (const event of ["push", "pull_request"]) {
    assert.deepEqual(ci.on[event].paths, expectedPaths);
  }
});

test("authentication CI runs only its offline suite without privileged credentials", () => {
  const ci = workflow("authentication-tests");
  assert.deepEqual(ci.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(ci.jobs), ["authentication-tests"]);
  const job = ci.jobs["authentication-tests"];
  assert.equal(job.environment, undefined);
  assert.equal(job.steps[0].with["persist-credentials"], false);
  const runs = job.steps.map(step => step.run).filter(Boolean);
  assert.ok(runs.includes("npm run test:auth"));
  assert.ok(runs.includes("bash -n scripts/app-write-probe.sh"));
  assert.ok(runs.includes("npm ci --ignore-scripts"));
  assert.ok(!runs.includes("npm test"));
  assert.ok(!runs.includes("bash scripts/app-write-probe.sh"));
  assert.ok(job.steps.every(step => !step.uses?.includes("create-github-app-token")));
  for (const run of runs.filter(run => /^npm (ci|install)\b/.test(run))) {
    assert.equal(run, "npm ci --ignore-scripts", "dependency installation must not execute lifecycle scripts");
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