#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

if (process.argv.length !== 4) {
  console.error("Usage: config-stack.mjs <stacks.yaml> <stack-id>");
  process.exit(2);
}

try {
  const document = parse(await readFile(process.argv[2], "utf8"));
  if (!document || !Array.isArray(document.stacks)) throw new Error("Configuration has no stacks array");
  const stack = document.stacks.find(item => item && typeof item.id === "string" &&
    item.id.toLowerCase() === process.argv[3].toLowerCase());
  if (!stack) {
    console.error(`Unknown stack: ${process.argv[3]}`);
    process.exitCode = 1;
  } else if (typeof stack.environment !== "string" || !Array.isArray(stack.components)) {
    throw new Error(`Invalid stack configuration: ${stack.id}`);
  } else {
    console.log(JSON.stringify({ id: stack.id, environment: stack.environment, components: stack.components }));
  }
} catch (error) {
  console.error(`Stack configuration failed: ${error.message}`);
  process.exitCode = 2;
}
