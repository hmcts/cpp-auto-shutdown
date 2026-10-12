#!/usr/bin/env node
import { readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "yaml";
import { resolveSchedule } from "../../docs/js/schedule.js";
import { londonClock, toIsoDate } from "../../docs/js/time.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
function usage() { throw new Error("Usage: schedule-plan.mjs [--now ISO] [--environments dev,ste] [--stacks id,id] [--force] [--bank-holidays FILE]"); }
function parseArgs(args) {
  const options = { force: false };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--force") { options.force = true; continue; }
    if (!["--now", "--environments", "--stacks", "--bank-holidays"].includes(key) || !args[index + 1]) usage();
    options[key] = args[++index];
  }
  return options;
}
function csv(value) { return value ? new Set(value.split(",").map(item => item.trim().toLowerCase()).filter(Boolean)) : null; }
async function loadBankHolidays(path) {
  let document;
  if (path) document = JSON.parse(await readFile(path, "utf8"));
  else {
    try {
      const response = await fetch("https://www.gov.uk/bank-holidays.json");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      document = await response.json();
    } catch (error) {
      console.warn(`::warning::Could not load bank holidays; continuing without them (${error.message})`);
      return {};
    }
  }
  const events = document?.["england-and-wales"]?.events;
  if (!Array.isArray(events)) {
    if (path) throw new Error("Bank holiday file has no england-and-wales events array");
    console.warn("::warning::Bank holiday response has no england-and-wales events array; continuing without holidays");
    return {};
  }
  return Object.fromEntries(events.map(event => {
    if (typeof event.date !== "string" || typeof event.title !== "string") throw new Error("Bank holiday event is malformed");
    return [toIsoDate(event.date), event.title];
  }));
}
async function readState(stateDir, stack) {
  const path = join(stateDir, `${stack.environment}.json`);
  if (!existsSync(path)) return "none";
  const document = JSON.parse(await readFile(path, "utf8"));
  if (document.environment !== stack.environment || !document.stacks || typeof document.stacks !== "object") {
    throw new Error(`Invalid state document: ${path}`);
  }
  return document.stacks[stack.id]?.aggregateStatus ?? "none";
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const now = options["--now"] ? new Date(options["--now"]) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("--now must be a valid ISO timestamp");
  const stacksPath = process.env.STACKS_FILE || join(root, "config/stacks.yaml");
  const exceptionsPath = process.env.EXCEPTIONS_FILE || join(root, "config/exceptions.yaml");
  const stateDir = process.env.STATE_DIR || join(root, "state/environments");
  const config = parse(await readFile(stacksPath, "utf8"));
  const exceptionDocument = parse(await readFile(exceptionsPath, "utf8"));
  if (!Array.isArray(config?.stacks) || !Array.isArray(exceptionDocument?.exceptions)) {
    throw new Error("Stacks config and exceptions config must contain arrays");
  }
  const exceptions = exceptionDocument.exceptions.map(exception => ({
    ...exception, start: toIsoDate(exception.start), end: toIsoDate(exception.end)
  }));
  const bankHolidays = await loadBankHolidays(options["--bank-holidays"]);
  const selectedEnvironments = csv(options["--environments"]);
  const selectedStacks = csv(options["--stacks"]);
  const clock = londonClock(now);
  const start = [];
  const stop = [];
  const requested = [];
  for (const stack of config.stacks) {
    if (selectedEnvironments && !selectedEnvironments.has(String(stack.environment).toLowerCase())) continue;
    if (selectedStacks && !selectedStacks.has(String(stack.id).toLowerCase())) continue;
    if (typeof stack.id !== "string" || typeof stack.environment !== "string") throw new Error("Configured stack is missing id or environment");
    const desired = resolveSchedule(stack, { ...clock, exceptions, bankHolidays }).status;
    const observed = await readState(stateDir, stack);
    if (options.force || observed !== desired) {
      const target = { stack: stack.id.toLowerCase(), environment: stack.environment };
      if (desired === "started") start.push(target); else stop.push(target);
      requested.push(`${target.stack}:${desired}`);
    }
  }
  const summary = { start, stop, requestedStacks: requested.join(","), hasWork: requested.length > 0 };
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    await appendFile(output, `start=${JSON.stringify(start)}\nstop=${JSON.stringify(stop)}\nrequestedStacks=${summary.requestedStacks}\nhasWork=${summary.hasWork}\n`);
  }
  console.log(JSON.stringify(summary));
}

main().catch(error => {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
});
