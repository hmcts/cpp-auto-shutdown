/* Loading config and observed state.
 *
 * The repo is public, so the browser reads both files straight from
 * raw.githubusercontent.com. A state change therefore needs NO Pages rebuild —
 * see DESIGN.md §2. raw sends `access-control-allow-origin: *` and caches for
 * 300s, which is finer-grained than the pipelines that write the state anyway.
 *
 * Never fetch api.github.com from the browser: 60 requests/hour per IP,
 * unauthenticated, and viewers share egress IPs. */

import { toIsoDate } from "./time.js";

export const REPO = "hmcts/cpp-auto-shutdown";

/** ?ref= lets the page be demoed from a branch before it is merged. */
export function dataRef() {
  const ref = new URLSearchParams(location.search).get("ref");
  return ref && /^[\w.\-/]{1,100}$/.test(ref) ? ref : "main";
}

const rawBase = () => `https://raw.githubusercontent.com/${REPO}/${dataRef()}`;

async function getText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.text();
}

/* ---- config/stacks.yaml -------------------------------------------------- */

/* Normalise a YAML stack entry. Config carries identity and ownership only —
 * schedule alterations live in exceptions, never on the stack. */
function normaliseStack(raw) {
  return {
    id: raw.id,
    env: String(raw.environment || "").toUpperCase(),
    components: raw.components || [],
    owner: raw.owner || "",
    use: raw.used_for || "",
    // urls may be plain strings, or {role, url} pairs
    urls: (raw.urls || []).map(u =>
      typeof u === "string" ? { role: "", url: u } : { role: u.role || "", url: u.url }),
    notes: raw.notes || ""
  };
}

function normaliseException(raw) {
  return {
    issue: raw.request,
    reference: raw.reference || "",
    stacks: raw.stacks || [],
    start: toIsoDate(raw.start),
    end: toIsoDate(raw.end),
    window: String(raw.window || "24h"),
    requester: raw.requester || "",
    approver: raw.approver || null,
    applied: Boolean(raw.applied),
    justification: raw.justification || ""
  };
}

export async function loadConfig() {
  const text = await getText(`${rawBase()}/config/stacks.yaml`);
  if (!globalThis.jsyaml) throw new Error("js-yaml failed to load");
  const doc = globalThis.jsyaml.load(text);
  return {
    stacks: (doc.stacks || []).map(normaliseStack),
    exceptions: (doc.exceptions || []).map(normaliseException)
  };
}

/* ---- state/environments/<env>.json --------------------------------------- */

export async function loadState(env) {
  const text = await getText(`${rawBase()}/state/environments/${env.toLowerCase()}.json`);
  const doc = JSON.parse(text);
  return doc.stacks || {};
}

/* ---- bank holidays ------------------------------------------------------- */

/** England & Wales, from gov.uk. Cached for the session; it changes yearly. */
export async function loadBankHolidays() {
  try {
    const res = await fetch("https://www.gov.uk/bank-holidays.json");
    if (!res.ok) throw new Error(String(res.status));
    const doc = await res.json();
    const out = {};
    for (const event of doc["england-and-wales"].events) out[event.date] = event.title;
    return out;
  } catch (err) {
    // Non-fatal: without it the board simply treats a bank holiday as a weekday.
    console.warn("Bank holidays unavailable, continuing without them:", err.message);
    return {};
  }
}
