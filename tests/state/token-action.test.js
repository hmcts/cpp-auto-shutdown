import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../..", import.meta.url));
const actionPath = join(root, ".github/actions/state-write-token/action.yml");
test("state token action scopes the App token to this repository", () => {
  const action = parse(readFileSync(actionPath, "utf8"));
  assert.equal(action.runs.using, "composite");
  assert.ok(action.outputs.token.value.includes("steps.app-token.outputs.token"));
  assert.deepEqual(Object.keys(action.inputs), ["app-id", "installation-id", "private-key-base64"]);
  const token = action.runs.steps.find(step => step.id === "app-token");
  assert.equal(token.uses, "actions/create-github-app-token@v3");
  assert.equal(token.with.owner, "hmcts");
  assert.equal(token.with.repositories, "cpp-auto-shutdown");
  assert.equal(token.with["permission-contents"], "write");
  assert.ok(action.runs.steps.find(step => step.run?.includes("app-key-decode.mjs")));
});

test("key decoder accepts encoded PKCS#1 and PKCS#8 RSA keys and masks the normalized key", t => {
  const decoder = join(root, "scripts/state/app-key-decode.mjs");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const directory = mkdtempSync(join(tmpdir(), "state-token-key-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const type of ["pkcs1", "pkcs8"]) {
    const pem = privateKey.export({ type, format: "pem" });
    const output = join(directory, type); writeFileSync(output, "");
    const result = spawnSync(process.execPath, [decoder], { encoding: "utf8",
      env: { ...process.env, PRIVATE_KEY_BASE64: Buffer.from(pem).toString("base64"), GITHUB_OUTPUT: output } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("::add-mask::"));
    const written = readFileSync(output, "utf8");
    const delimiter = written.split("\n")[0].slice("private-key<<".length);
    const decoded = written.slice(written.indexOf("\n") + 1, -`${delimiter}\n`.length);
    assert.equal(createPrivateKey(decoded).asymmetricKeyType, "rsa");
    assert.ok(result.stdout.includes(`::add-mask::${decoded.trim().split("\n")[0]}`));
  }
});

test("key decoder rejects malformed base64, raw PEM, invalid and EC keys without secret diagnostics", t => {
  const decoder = join(root, "scripts/state/app-key-decode.mjs");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const invalid = ["not-base64!", "YWJj=", Buffer.from("not a key").toString("base64"),
    privateKey.export({ type: "pkcs8", format: "pem" }),
    Buffer.from(ec.export({ type: "pkcs8", format: "pem" })).toString("base64")];
  for (const secret of invalid) {
    const directory = mkdtempSync(join(tmpdir(), "state-token-invalid-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const output = join(directory, "output");
    const result = spawnSync(process.execPath, [decoder], { encoding: "utf8",
      env: { ...process.env, PRIVATE_KEY_BASE64: secret, GITHUB_OUTPUT: output } });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "App private key must be base64-encoded PEM containing a valid RSA private key\n");
    assert.ok(!result.stderr.includes(secret));
  }
});
