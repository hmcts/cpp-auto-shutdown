import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../docs/js/data.js";

test("loadConfig combines stack and exception YAML documents", async t => {
  const oldLocation = globalThis.location;
  const oldYaml = globalThis.jsyaml;
  const oldFetch = globalThis.fetch;
  t.after(() => {
    if (oldLocation === undefined) delete globalThis.location;
    else globalThis.location = oldLocation;
    if (oldYaml === undefined) delete globalThis.jsyaml;
    else globalThis.jsyaml = oldYaml;
    globalThis.fetch = oldFetch;
  });

  globalThis.location = { search: "?ref=feature-branch" };
  const stackDoc = {
    stacks: [{
      id: "DEVCCM01", environment: "dev", components: ["AKS"], owner: "Owner",
      used_for: "Testing", urls: [], notes: ""
    }]
  };
  const exceptionDoc = {
    exceptions: [{
      request: 42, reference: "CPP-42", stacks: ["DEVCCM01"],
      start: "2026-09-15", end: "2026-09-16", window: "24h",
      requester: "Owner", approver: null, applied: false, justification: "Testing"
    }]
  };
  const calls = [];
  globalThis.jsyaml = {
    load(text) {
      return text === "stack document" ? stackDoc : exceptionDoc;
    }
  };
  globalThis.fetch = async url => {
    calls.push(String(url));
    return {
      ok: true,
      text: async () => String(url).endsWith("/config/stacks.yaml")
        ? "stack document" : "exception document"
    };
  };

  const config = await loadConfig();
  assert.deepEqual(new Set(calls), new Set([
    "https://raw.githubusercontent.com/hmcts/cpp-auto-shutdown/feature-branch/config/stacks.yaml",
    "https://raw.githubusercontent.com/hmcts/cpp-auto-shutdown/feature-branch/config/exceptions.yaml"
  ]));
  assert.equal(config.stacks[0].id, "DEVCCM01");
  assert.equal(config.exceptions[0].issue, 42);
  assert.equal(config.exceptions[0].start, "2026-09-15");
});
