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
  assert.equal(config.exceptions[0].reference, "CPP-42");
  assert.equal(config.exceptions[0].start, "2026-09-15");
});

async function withData(stacks, exceptions, run) {
  const previousFetch = globalThis.fetch;
  const previousYaml = globalThis.jsyaml;
  const previousLocation = globalThis.location;
  globalThis.location = { search: "" };
  globalThis.fetch = async url => ({
    ok: true,
    text: async () => url.endsWith("/config/stacks.yaml") ? "stacks" : "exceptions"
  });
  globalThis.jsyaml = { load: text => text === "stacks" ? stacks : exceptions };
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousYaml === undefined) delete globalThis.jsyaml;
    else globalThis.jsyaml = previousYaml;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
}

test("loadConfig normalises URLs and YAML dates", async () => {
  await withData({ stacks: [{
    id: "DEVCCM01", environment: "dev", components: ["AKS"], owner: "Owner",
    urls: ["https://example.org"]
  }] }, { exceptions: [{
    request: 105, stacks: ["DEVCCM01"], applied: true, window: "24h",
    start: new Date("2026-09-01T00:00:00.000Z"), end: "2026-09-03"
  }] }, async () => {
    const config = await loadConfig();
    assert.equal(config.stacks[0].env, "DEV");
    assert.deepEqual(config.stacks[0].urls, [{ role: "", url: "https://example.org" }]);
    assert.equal(config.exceptions[0].start, "2026-09-01");
    assert.equal(config.exceptions[0].applied, true);
  });
});

test("empty configuration arrays are valid but missing or malformed arrays fail closed", async () => {
  await withData({ stacks: [] }, { exceptions: [] }, async () => {
    assert.deepEqual(await loadConfig(), { stacks: [], exceptions: [] });
  });
  for (const [stacks, exceptions] of [
    [{ stacks: [] }, {}], [{}, { exceptions: [] }],
    [null, { exceptions: [] }], [{ stacks: [] }, null],
    [{ stacks: {} }, { exceptions: [] }], [{ stacks: [] }, { exceptions: {} }]
  ]) {
    await withData(stacks, exceptions, async () => {
      await assert.rejects(loadConfig(), /Invalid stack or exception configuration/);
    });
  }
});

test("a failed exceptions fetch does not silently discard approved exceptions", async () => {
  await withData({ stacks: [] }, { exceptions: [] }, async () => {
    globalThis.fetch = async url => ({
      ok: !url.endsWith("/config/exceptions.yaml"),
      status: 404, statusText: "Not Found", text: async () => "stacks"
    });
    await assert.rejects(loadConfig(), /404 Not Found/);
  });
});
