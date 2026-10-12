#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

if (process.argv.length !== 4) {
  console.error("Usage: schema-validate.mjs <schema.json> <document.json>");
  process.exit(2);
}

try {
  const [schemaText, documentText] = await Promise.all([
    readFile(process.argv[2], "utf8"), readFile(process.argv[3], "utf8")
  ]);
  const schema = JSON.parse(schemaText);
  const document = JSON.parse(documentText);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(document)) {
    console.error(JSON.stringify(validate.errors));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Schema validation failed: ${error.message}`);
  process.exitCode = 2;
}
