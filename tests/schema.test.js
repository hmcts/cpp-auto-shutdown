import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

let validatorsPromise;
function getValidators() {
  validatorsPromise ??= Promise.all([
    "schemas/stacks.schema.json",
    "schemas/exceptions.schema.json",
    "schemas/environment-state.schema.json"
  ].map(async path => ajv.compile(await readJson(path))));
  return validatorsPromise;
}

async function validateSamples() {
  const [validateStacks, validateExceptions, validateState] = await getValidators();
  const files = (await readdir("state/environments", { withFileTypes: true }))
    .filter(file => file.isFile() && file.name.endsWith(".json"))
    .map(file => file.name).sort();
  for (const name of ["dev.json", "ste.json"]) {
    assert.ok(files.includes(name), `Missing state/environments/${name}`);
  }
  const cases = [
    ["config/stacks.yaml", validateStacks, parse],
    ["config/exceptions.yaml", validateExceptions, parse],
    ...files.map(name => [`state/environments/${name}`, validateState, JSON.parse])
  ];

  for (const [dataPath, validate, decode] of cases) {
    const data = decode(await readFile(dataPath, "utf8"));
    assert.equal(validate(data), true,
      `${dataPath}: ${JSON.stringify(validate.errors)}`);
  }
}

test("checked-in configuration and state satisfy their schemas", async () => {
  await validateSamples();
});

test("an additional invalid environment JSON file fails sample validation", async () => {
  const filename = `extra-invalid-${randomUUID()}.json`;
  const path = `state/environments/${filename}`;
  await writeFile(path, '{"environment":"invalid","stacks":{}}');
  try {
    await assert.rejects(validateSamples(), error => {
      assert.ok(error.message.includes(filename), error.message);
      assert.match(error.message, /"keyword":"enum"/);
      return true;
    });
  } finally {
    await unlink(path);
  }
});

const componentNames = [
  ["AKS", "aks"],
  ["IaaS", "iaas"],
  ["PaaS", "paas"]
];

function stateWithComponent(state, name, key) {
  const copy = structuredClone(state);
  const record = copy.stacks.STECCM11;
  const component = record.components.aks;
  record.stackComponents = [name];
  record.components = { aks: null, iaas: null, paas: null, [key]: component };
  return copy;
}

test("component membership requires an object for every used component and null for every unused one", async () => {
  const [, , validate] = await getValidators();
  const state = JSON.parse(await readFile("state/environments/ste.json", "utf8"));

  for (const [name, key] of componentNames) {
    const used = stateWithComponent(state, name, key);
    used.stacks.STECCM11.components[key].source = "pipeline";
    assert.equal(validate(used), true, `${name}: ${JSON.stringify(validate.errors)}`);

    const usedComponentNull = structuredClone(used);
    usedComponentNull.stacks.STECCM11.components[key] = null;
    assert.equal(validate(usedComponentNull), false, `${name} must be an object`);
    assert.ok(validate.errors.some(error =>
      error.instancePath.endsWith(`/components/${key}`) &&
      error.keyword === "type" && error.params.type === "object"),
    `${name}: ${JSON.stringify(validate.errors)}`);

    const absentComponentObject = structuredClone(used);
    const [otherName, otherKey] = componentNames.find(([other]) => other !== name);
    absentComponentObject.stacks.STECCM11.stackComponents = [otherName];
    absentComponentObject.stacks.STECCM11.components[otherKey] = {
      requested: true, status: "started", verified: true, reason: "Healthy"
    };
    assert.equal(validate(absentComponentObject), false, `${name} must be null when absent`);
    assert.ok(validate.errors.some(error =>
      error.instancePath.endsWith(`/components/${key}`) &&
      error.keyword === "type" && error.params.type === "null"),
    `${name}: ${JSON.stringify(validate.errors)}`);
  }
});

test("state records require all three component keys", async () => {
  const [, , validate] = await getValidators();
  const state = JSON.parse(await readFile("state/environments/ste.json", "utf8"));

  for (const [name, key] of componentNames) {
    const withoutKey = stateWithComponent(state, name, key);
    delete withoutKey.stacks.STECCM11.components[key];
    assert.equal(validate(withoutKey), false, `missing ${key}`);
    assert.ok(validate.errors.some(error =>
      error.keyword === "required" && error.params.missingProperty === key),
    `${key}: ${JSON.stringify(validate.errors)}`);
  }
});

test("configuration and state reject out-of-range enum values", async () => {
  const [validateStacks, validateExceptions, validateState] = await getValidators();
  const stacks = parse(await readFile("config/stacks.yaml", "utf8"));
  const exceptions = parse(await readFile("config/exceptions.yaml", "utf8"));
  const state = JSON.parse(await readFile("state/environments/ste.json", "utf8"));

  const cases = [
    ["stack environment", validateStacks, stacks, data => { data.stacks[0].environment = "prod"; }],
    ["stack component", validateStacks, stacks, data => { data.stacks[0].components[0] = "VM"; }],
    ["available window", validateStacks, stacks, data => { data.exception_windows[0] = "overnight"; }],
    ["exception window", validateExceptions, exceptions, data => { data.exceptions[0].window = "overnight"; }],
    ["state environment", validateState, state, data => { data.environment = "prod"; }],
    ["state component", validateState, state, data => {
      data.stacks.STECCM11.stackComponents[0] = "VM";
      data.stacks.STECCM11.components.aks = null;
    }],
    ["aggregate status", validateState, state, data => { data.stacks.STECCM11.aggregateStatus = "unknown"; }],
    ["component status", validateState, state, data => { data.stacks.STECCM11.components.aks.status = "unknown"; }]
  ];
  for (const [name, validate, original, mutate] of cases) {
    const invalid = structuredClone(original);
    mutate(invalid);
    assert.equal(validate(invalid), false, `${name}: out-of-range value accepted`);
    assert.ok(validate.errors.some(error => error.keyword === "enum"),
      `${name}: ${JSON.stringify(validate.errors)}`);
  }
});
