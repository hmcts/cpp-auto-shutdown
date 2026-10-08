import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const projectDirectory = fileURLToPath(new URL("../../", import.meta.url));

function stacksDocument() {
  return {
    defaults: {
      timezone: "Europe/London", startup: "06:00", shutdown: "19:00",
      weekdays_only: true, bank_holidays_source: "https://www.gov.uk/bank-holidays.json"
    },
    exception_windows: ["06:00-19:00", "06:00-21:00", "06:00-23:00", "24h"],
    stacks: [{
      id: "TESTSTACK", environment: "ste", components: ["AKS"],
      owner: "Test Owner", used_for: "Schema validation", urls: [], notes: ""
    }]
  };
}

function exceptionsDocument() {
  return {
    exceptions: [{
      request: 105, reference: "TEST-105", stacks: ["TESTSTACK"],
      start: "2026-09-01", end: "2026-09-03", window: "24h",
      requester: "Test Requester", approver: "Test Approver",
      applied: true, justification: "Schema validation"
    }]
  };
}

function stateDocument() {
  return {
    environment: "ste",
    stacks: {
      TESTSTACK: {
        stack: "TESTSTACK", stackComponents: ["AKS"], aggregateStatus: "started",
        observedAt: "2026-09-09T09:30:00Z", sourcePipeline: 1, sourceRunId: 1,
        components: {
          aks: { requested: true, status: "started", verified: true, reason: "Healthy" },
          iaas: null, paas: null
        }
      }
    }
  };
}

async function temporarySamples(t) {
  const directory = await mkdtemp(join(tmpdir(), "data-validation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "config"));
  await mkdir(join(directory, "state/environments"), { recursive: true });
  await writeFile(join(directory, "config/stacks.yaml"), JSON.stringify(stacksDocument()));
  await writeFile(join(directory, "config/exceptions.yaml"), JSON.stringify({ exceptions: [] }));
  for (const environment of ["dev", "ste"]) {
    await writeFile(join(directory, `state/environments/${environment}.json`),
      JSON.stringify({ environment, stacks: {} }));
  }
  return directory;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

let validatorsPromise;
function getValidators() {
  validatorsPromise ??= Promise.all([
    "schemas/stacks.schema.json",
    "schemas/exceptions.schema.json",
    "schemas/environment-state.schema.json"
  ].map(async path => ajv.compile(await readJson(new URL(`../../${path}`, import.meta.url)))));
  return validatorsPromise;
}

function validateExceptionDocument(data, validate, dataPath = "config/exceptions.yaml") {
  assert.equal(validate(data), true,
    `${dataPath}: ${JSON.stringify(validate.errors)}`);
  for (const exception of data.exceptions) {
    assert.ok(exception.start <= exception.end,
      `${dataPath}: request ${exception.request} has end ${exception.end} before start ${exception.start}`);
  }
}

async function validateSamples(directory = projectDirectory) {
  const [validateStacks, validateExceptions, validateState] = await getValidators();
  const stateDirectory = join(directory, "state/environments");
  const files = (await readdir(stateDirectory, { withFileTypes: true }))
    .filter(file => file.isFile() && file.name.endsWith(".json"))
    .map(file => file.name).sort();
  for (const name of ["dev.json", "ste.json"]) {
    assert.ok(files.includes(name), `Missing ${join(stateDirectory, name)}`);
  }
  const cases = [
    [join(directory, "config/stacks.yaml"), validateStacks, parse],
    [join(directory, "config/exceptions.yaml"), validateExceptions, parse],
    ...files.map(name => [join(stateDirectory, name), validateState, JSON.parse])
  ];

  for (const [dataPath, validate, decode] of cases) {
    const data = decode(await readFile(dataPath, "utf8"));
    if (validate === validateExceptions) {
      validateExceptionDocument(data, validate, dataPath);
    } else {
      assert.equal(validate(data), true,
        `${dataPath}: ${JSON.stringify(validate.errors)}`);
    }
  }
}

test("checked-in configuration and state satisfy their schemas", async () => {
  await validateSamples();
});

test("sample validation accepts empty stacks in every environment and empty exceptions", async t => {
  await validateSamples(await temporarySamples(t));
});

test("an additional invalid environment JSON file fails sample validation", async t => {
  const directory = await temporarySamples(t);
  const filename = "extra-invalid.json";
  await writeFile(join(directory, "state/environments", filename), '{"environment":"invalid","stacks":{}}');
  await assert.rejects(validateSamples(directory), error => {
    assert.ok(error.message.includes(filename), error.message);
    assert.match(error.message, /"keyword":"enum"/);
    return true;
  });
});

const componentNames = [
  ["AKS", "aks"],
  ["IaaS", "iaas"],
  ["PaaS", "paas"]
];

test("inline configuration, exceptions and populated state satisfy their schemas", async () => {
  const validators = await getValidators();
  const documents = [stacksDocument(), exceptionsDocument(), stateDocument()];
  for (const [index, validate] of validators.entries()) {
    assert.equal(validate(documents[index]), true, JSON.stringify(validate.errors));
  }
});

test("state schema accepts empty stacks but rejects missing or non-object stacks", async () => {
  const [, , validate] = await getValidators();
  for (const environment of ["dev", "ste"]) {
    assert.equal(validate({ environment, stacks: {} }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ environment }), false, "stacks is required even when empty");
    assert.ok(validate.errors.some(error =>
      error.keyword === "required" && error.params.missingProperty === "stacks"),
    JSON.stringify(validate.errors));
    for (const stacks of [null, [], ""]) {
      assert.equal(validate({ environment, stacks }), false, "stacks must be an object");
      assert.ok(validate.errors.some(error =>
        error.instancePath === "/stacks" && error.keyword === "type"),
      JSON.stringify(validate.errors));
    }
  }
});

function stateWithComponent(state, name, key) {
  const copy = structuredClone(state);
  const record = copy.stacks.TESTSTACK;
  const component = record.components.aks;
  record.stackComponents = [name];
  record.components = { aks: null, iaas: null, paas: null, [key]: component };
  return copy;
}

test("component membership requires an object for every used component and null for every unused one", async () => {
  const [, , validate] = await getValidators();
  const state = stateDocument();

  for (const [name, key] of componentNames) {
    const used = stateWithComponent(state, name, key);
    used.stacks.TESTSTACK.components[key].source = "pipeline";
    assert.equal(validate(used), true, `${name}: ${JSON.stringify(validate.errors)}`);

    const usedComponentNull = structuredClone(used);
    usedComponentNull.stacks.TESTSTACK.components[key] = null;
    assert.equal(validate(usedComponentNull), false, `${name} must be an object`);
    assert.ok(validate.errors.some(error =>
      error.instancePath.endsWith(`/components/${key}`) &&
      error.keyword === "type" && error.params.type === "object"),
    `${name}: ${JSON.stringify(validate.errors)}`);

    const absentComponentObject = structuredClone(used);
    const [otherName, otherKey] = componentNames.find(([other]) => other !== name);
    absentComponentObject.stacks.TESTSTACK.stackComponents = [otherName];
    absentComponentObject.stacks.TESTSTACK.components[otherKey] = {
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
  const state = stateDocument();

  for (const [name, key] of componentNames) {
    const withoutKey = stateWithComponent(state, name, key);
    delete withoutKey.stacks.TESTSTACK.components[key];
    assert.equal(validate(withoutKey), false, `missing ${key}`);
    assert.ok(validate.errors.some(error =>
      error.keyword === "required" && error.params.missingProperty === key),
    `${key}: ${JSON.stringify(validate.errors)}`);
  }
});

test("configuration and state reject out-of-range enum values", async () => {
  const [validateStacks, validateExceptions, validateState] = await getValidators();
  const stacks = stacksDocument();
  const exceptions = exceptionsDocument();
  const state = stateDocument();

  const cases = [
    ["stack environment", validateStacks, stacks, data => { data.stacks[0].environment = "prod"; }],
    ["stack component", validateStacks, stacks, data => { data.stacks[0].components[0] = "VM"; }],
    ["available window", validateStacks, stacks, data => { data.exception_windows[0] = "overnight"; }],
    ["exception window", validateExceptions, exceptions, data => { data.exceptions[0].window = "overnight"; }],
    ["state environment", validateState, state, data => { data.environment = "prod"; }],
    ["state component", validateState, state, data => {
      data.stacks.TESTSTACK.stackComponents[0] = "VM";
      data.stacks.TESTSTACK.components.aks = null;
    }],
    ["aggregate status", validateState, state, data => { data.stacks.TESTSTACK.aggregateStatus = "unknown"; }],
    ["component status", validateState, state, data => { data.stacks.TESTSTACK.components.aks.status = "unknown"; }]
  ];
  for (const [name, validate, original, mutate] of cases) {
    const invalid = structuredClone(original);
    mutate(invalid);
    assert.equal(validate(invalid), false, `${name}: out-of-range value accepted`);
    assert.ok(validate.errors.some(error => error.keyword === "enum"),
      `${name}: ${JSON.stringify(validate.errors)}`);
  }
});

test("exception date windows cannot end before they start", async () => {
  const [, validateExceptions] = await getValidators();
  const exceptions = exceptionsDocument();
  const reversed = structuredClone(exceptions);
  reversed.exceptions[0].start = "2026-09-10";
  reversed.exceptions[0].end = "2026-09-09";

  assert.throws(
    () => validateExceptionDocument(reversed, validateExceptions),
    /request 105.*end .* before start/
  );

  const sameDay = structuredClone(exceptions);
  sameDay.exceptions[0].end = sameDay.exceptions[0].start;
  assert.doesNotThrow(() => validateExceptionDocument(sameDay, validateExceptions));
});
