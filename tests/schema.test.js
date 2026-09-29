import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("checked-in configuration and state satisfy their schemas", async () => {
  const cases = [
    ["config/stacks.yaml", "schemas/stacks.schema.json", parse],
    ["config/exceptions.yaml", "schemas/exceptions.schema.json", parse],
    ["state/environments/dev.json", "schemas/environment-state.schema.json", JSON.parse],
    ["state/environments/ste.json", "schemas/environment-state.schema.json", JSON.parse]
  ];

  for (const [dataPath, schemaPath, decode] of cases) {
    const schema = await readJson(schemaPath);
    const validate = ajv.compile(schema);
    const data = decode(await readFile(dataPath, "utf8"));
    assert.equal(validate(data), true,
      `${dataPath}: ${JSON.stringify(validate.errors)}`);
  }
});

test("state schema requires objects for used components and null for unused ones", async () => {
  const schema = await readJson("schemas/environment-state.schema.json");
  const validate = ajv.compile(schema);
  const state = JSON.parse(await readFile("state/environments/ste.json", "utf8"));

  const absentComponentObject = structuredClone(state);
  absentComponentObject.stacks.STECCM11.components.iaas = {};
  assert.equal(validate(absentComponentObject), false);

  const usedComponentNull = structuredClone(state);
  usedComponentNull.stacks.STECCM11.components.aks = null;
  assert.equal(validate(usedComponentNull), false);
});
