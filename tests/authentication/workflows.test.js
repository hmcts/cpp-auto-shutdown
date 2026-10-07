import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  const setup = job.steps.find(step => step.uses === "actions/setup-node@v4");
  assert.equal(setup.with["node-version"], "22");
  const app = job.steps.find(step => step.id === "app-token");
  const decode = job.steps.find(step => step.id === "app-key");
  assert.equal(decode.env.PRIVATE_KEY_BASE64, "${{ secrets.CPP_GITHUB_MANAGEMENT_PRIVATE_KEY }}");
  assert.ok(job.steps.indexOf(decode) < job.steps.indexOf(app));
  assert.ok(decode.run.startsWith("set +x\nset -euo pipefail\n"));
  const configuration = job.steps.find(step => step.name === "Check administrator configuration");
  assert.ok(job.steps.indexOf(configuration) < job.steps.indexOf(app));
  assert.equal(configuration.env.PRIVATE_KEY, "${{ secrets.CPP_GITHUB_MANAGEMENT_PRIVATE_KEY }}");
  for (const input of ["APP_ID", "PRIVATE_KEY", "EXPECTED_INSTALLATION_ID"]) {
    assert.ok(configuration.run.includes(`$${input}`));
  }
  assert.equal(app.uses, "actions/create-github-app-token@v3");
  assert.deepEqual(app.with, {
    "app-id": "${{ vars.CPP_GITHUB_MANAGEMENT_APP_ID }}",
    "private-key": "${{ steps.app-key.outputs.private-key }}",
    owner: "hmcts", repositories: "cpp-auto-shutdown", "permission-contents": "write"
  });
  assert.equal(job.steps.at(-1).run, "bash scripts/app-write-probe.sh");
  assert.equal(job.steps.at(-1).env.APP_TOKEN, "${{ steps.app-token.outputs.token }}");
  assert.equal(job.steps.at(-1).env.APP_SLUG, "${{ steps.app-token.outputs.app-slug }}");
  assert.equal(job.steps.at(-1).env.APP_INSTALLATION_ID, "${{ steps.app-token.outputs.installation-id }}");
  assert.equal(job.steps.at(-1).env.CONFIRM_WRITE, "${{ inputs.confirm_write }}");
  assert.ok(job.steps.every(step => !step["continue-on-error"]));
});

test("App key decoding accepts encoded RSA PEM and fails without secret-bearing diagnostics", () => {
  const decode = workflow("github-app-write-probe").jobs.probe.steps.find(step => step.id === "app-key");
  const script = decode.run.split("<<'NODE'\n")[1].split("\nNODE")[0];
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const directory = mkdtempSync(join(tmpdir(), "app-key-test-"));
  try {
    for (const type of ["pkcs1", "pkcs8"]) {
      const pem = privateKey.export({ type, format: "pem" });
      const encoded = Buffer.from(pem).toString("base64");
      const output = join(directory, type);
      const result = spawnSync(process.execPath, ["--input-type=module"], {
        input: script, encoding: "utf8",
        env: { ...process.env, PRIVATE_KEY_BASE64: encoded, GITHUB_OUTPUT: output }
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.ok(result.stdout.trim().split("\n").every(line => line.startsWith("::add-mask::")));
      assert.ok(!result.stdout.includes(encoded));
      const value = readFileSync(output, "utf8");
      const delimiter = value.split("\n")[0].slice("private-key<<".length);
      assert.ok(value.endsWith(`${delimiter}\n`));
      const decoded = value.slice(value.indexOf("\n") + 1, -`${delimiter}\n`.length);
      assert.equal(createPrivateKey(decoded).export({ type: "pkcs8", format: "pem" }),
        privateKey.export({ type: "pkcs8", format: "pem" }));
      for (const line of decoded.trim().split("\n")) assert.ok(result.stdout.includes(`::add-mask::${line}\n`));
    }
    for (const invalid of ["", "not-base64!", "YWJj=", Buffer.from("not a key").toString("base64"),
      Buffer.from("-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----\n").toString("base64"),
      Buffer.from(ec.export({ type: "pkcs8", format: "pem" })).toString("base64"),
      privateKey.export({ type: "pkcs8", format: "pem" })]) {
      const result = spawnSync(process.execPath, ["--input-type=module"], {
        input: script, encoding: "utf8",
        env: { ...process.env, PRIVATE_KEY_BASE64: invalid, GITHUB_OUTPUT: join(directory, "invalid") }
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "App private key must be base64-encoded PEM containing a valid RSA private key\n");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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