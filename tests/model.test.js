import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRow, componentReadings, exceptionStatus, stateLabel, isStale,
         MAX_OBSERVATION_AGE_HOURS } from "../docs/js/model.js";
import { formatDate, formatAge, toMinutes, ageInHours } from "../docs/js/time.js";
import { esc, safeUrl } from "../docs/js/dom.js";

const TODAY = "2026-09-09";                        // Wednesday
const NOW = new Date("2026-09-09T10:00:00Z");

const stack = (over = {}) => ({
  id: "DEVCCM01", env: "DEV", components: ["AKS"], owner: "A Person",
  use: "Testing", urls: [], notes: "", ...over
});

const record = (over = {}) => ({
  stack: "DEVCCM01", stackComponents: ["AKS"],
  aggregateStatus: "started",
  observedAt: "2026-09-09T09:30:00Z",             // 30 min before NOW
  sourcePipeline: 402, sourceRunId: 1,
  components: { paas: null, iaas: null,
    aks: { requested: true, status: "started", verified: true, reason: "ready" } },
  ...over
});

const ctx = (over = {}) => ({
  now: NOW, date: TODAY, minutes: toMinutes("10:00"),
  exceptions: [], bankHolidays: {}, ...over
});

/* ---- staleness and missing records --------------------------------------- */

test("a fresh record is not stale and needs no attention", () => {
  const row = buildRow(stack(), record(), ctx());
  assert.equal(row.observed, "started");
  assert.equal(row.stale, false);
  assert.equal(row.needsAttention, false);
});

/* Staleness is measured in scheduled transitions, not hours. A baseline stack
 * transitions at 06:00 and 19:00, so at 10:00 on the 9th the two most recent
 * due transitions are 06:00 on the 9th and 19:00 on the 8th. */

test("an observation after the most recent transition is fresh", () => {
  // 07:24 on the 9th, i.e. after that morning's 06:00 startup.
  const row = buildRow(stack(), record({ observedAt: "2026-09-09T07:24:00Z" }), ctx());
  assert.equal(row.stale, false);
});

test("ONE missed transition is tolerated — the pipeline alerts and retries", () => {
  // Last seen at the 8th's 19:00 shutdown; only the 9th's 06:00 start was missed.
  const row = buildRow(stack(), record({ observedAt: "2026-09-08T19:05:00Z" }), ctx());
  assert.equal(row.stale, false);
  assert.ok(row.age > 14, "record is over 14h old and still not stale — by design");
});

test("TWO missed transitions is stale", () => {
  // Last seen before the 8th's 19:00 shutdown, so that and the 9th's start were missed.
  const row = buildRow(stack(), record({ observedAt: "2026-09-08T12:00:00Z" }), ctx());
  assert.equal(row.stale, true);
  assert.equal(row.needsAttention, true);
});

test("a weekend produces no transitions, so a Friday record survives it", () => {
  // Monday 14 Sep 10:00. A weekday-only stack last observed at Friday's 19:00
  // shutdown has missed only Monday's 06:00 start — the weekend is not counted.
  const monday = ctx({ date: "2026-09-14", now: new Date("2026-09-14T10:00:00Z") });
  const friday = record({ observedAt: "2026-09-11T19:05:00Z" });   // ~63h earlier
  const row = buildRow(stack(), friday, monday);
  assert.ok(row.age > MAX_OBSERVATION_AGE_HOURS - 12, "record is nearly three days old");
  assert.equal(row.stale, false, "nothing was due over the weekend, so nothing was missed");
});

test("a bank holiday is skipped too", () => {
  // Tue 1 Sep, with Mon 31 Aug a bank holiday. Last seen Friday 28th's shutdown:
  // only Tuesday's start was missed.
  const tuesday = ctx({
    date: "2026-09-01", now: new Date("2026-09-01T10:00:00Z"),
    bankHolidays: { "2026-08-31": "Summer bank holiday" }
  });
  const row = buildRow(stack(), record({ observedAt: "2026-08-28T19:05:00Z" }), tuesday);
  assert.equal(row.stale, false);
});

test("a stack under a rolling 24h exception has no transitions, so the age cap applies", () => {
  // A long 24h exception means the stack never starts or stops, so there is
  // nothing to count and only the backstop can judge it.
  // The exception must cover the whole lookback window, otherwise the walk
  // reaches a pre-exception baseline day and finds transitions after all.
  const rolling = ctx({
    exceptions: [{
      stacks: ["DEVCCM01"], start: "2026-08-01", end: "2026-09-30",
      window: "24h", applied: true
    }]
  });
  const fresh = record({ observedAt: "2026-09-08T10:00:00Z" });        // 24h
  const ancient = record({ observedAt: "2026-09-05T10:00:00Z" });      // 96h
  assert.equal(buildRow(stack(), fresh, rolling).stale, false);
  assert.ok(ageInHours(ancient, NOW) > MAX_OBSERVATION_AGE_HOURS);
  assert.equal(buildRow(stack(), ancient, rolling).stale, true);
});

test("isStale reports true when there is no record at all", () => {
  assert.equal(isStale(stack(), null, null, ctx()), true);
});

test("a missing record is 'unknown', never assumed stopped", () => {
  const row = buildRow(stack(), null, ctx());
  assert.equal(row.observed, "unknown");
  assert.equal(row.age, null);
  assert.equal(row.stale, true);
  assert.equal(row.needsAttention, true);
  assert.equal(stateLabel(row.observed), "Not known");
});

/* ---- drift --------------------------------------------------------------- */

test("drift is flagged when a fresh reading contradicts the schedule", () => {
  // Config says stopped at 22:00 baseline, but the stack was observed started.
  const row = buildRow(stack(), record(), ctx({ minutes: toMinutes("22:00") }));
  assert.equal(row.schedule.status, "stopped");
  assert.equal(row.observed, "started");
  assert.equal(row.drift, true);
});

test("no drift when observation agrees with the schedule", () => {
  assert.equal(buildRow(stack(), record(), ctx()).drift, false);
});

test("a stale record never counts as drift — it may simply be out of date", () => {
  const old = record({ observedAt: "2026-09-08T12:00:00Z" });   // two transitions missed
  const row = buildRow(stack(), old, ctx({ minutes: toMinutes("22:00") }));
  assert.equal(row.stale, true);
  assert.equal(row.drift, false);
});

/* The case the whole rule exists to protect: a startup that failed this morning.
 * One transition missed, so the record stays fresh, so drift fires immediately
 * rather than being masked. Under the old flat threshold this was suppressed. */
test("a failed startup shows as drift straight away", () => {
  const overnight = record({
    observedAt: "2026-09-08T19:05:00Z",     // last night's verified shutdown
    aggregateStatus: "stopped"
  });
  const row = buildRow(stack(), overnight, ctx());   // 10:00, config expects started
  assert.equal(row.schedule.status, "started");
  assert.equal(row.observed, "stopped");
  assert.equal(row.stale, false, "one missed transition is tolerated");
  assert.equal(row.drift, true, "so the failure surfaces as drift, not silence");
});

test("a partial reading is never drift — it is neither started nor stopped", () => {
  const partial = record({ aggregateStatus: "partial" });
  const row = buildRow(stack(), partial, ctx({ minutes: toMinutes("22:00") }));
  assert.equal(row.drift, false);
  assert.equal(row.needsAttention, true);
  assert.equal(stateLabel("partial"), "Partly up");
});

/* ---- components ---------------------------------------------------------- */

test("null components are omitted, not reported as stopped", () => {
  const readings = componentReadings(record());
  assert.equal(readings.length, 1);
  assert.equal(readings[0].label, "AKS");
});

test("component words reflect verified state", () => {
  const mixed = record({
    aggregateStatus: "partial",
    components: {
      paas: { requested: true, status: "stopped", verified: true, reason: "db stopped" },
      iaas: { requested: true, status: "started", verified: false, reason: "timed out" },
      aks: { requested: true, status: "started", verified: true, reason: "ready" }
    }
  });
  const byLabel = Object.fromEntries(componentReadings(mixed).map(r => [r.label, r.word]));
  assert.deepEqual(byLabel, { AKS: "up", IaaS: "not known", PaaS: "down" });
});

/* ---- exception lifecycle ------------------------------------------------- */

const exception = (over = {}) => ({
  issue: 121, stacks: ["DEVCCM01"], start: "2026-09-15", end: "2026-09-19",
  window: "24h", approver: null, applied: false, ...over
});

test("unapplied with no approver reads 'Not approved' and warns", () => {
  const status = exceptionStatus(exception(), false, TODAY, formatDate);
  assert.equal(status.label, "Not approved");
  assert.match(status.warning, /still shuts down/);
  assert.match(status.warning, /Needs approving before 15 Sep/);
});

test("unapplied WITH an approver points at the platform team instead", () => {
  const status = exceptionStatus(exception({ approver: "Someone" }), false, TODAY, formatDate);
  assert.equal(status.label, "Approved, not applied");
  assert.match(status.warning, /Chase the platform team/);
});

test("applied and inside the window reads 'Active now'", () => {
  const live = exception({ applied: true, start: "2026-09-08", end: "2026-09-10" });
  assert.equal(exceptionStatus(live, true, TODAY, formatDate).label, "Active now");
});

test("applied but in the future names the start date", () => {
  const status = exceptionStatus(exception({ applied: true }), false, TODAY, formatDate);
  assert.equal(status.label, "Approved from 15 Sep");
  assert.equal(status.warning, null);
});

test("a past window reads 'Ended' whether applied or not", () => {
  const past = exception({ start: "2026-09-01", end: "2026-09-03" });
  assert.equal(exceptionStatus(past, false, TODAY, formatDate).label, "Ended");
});

test("no exception yields no status", () => {
  assert.equal(exceptionStatus(null, false, TODAY, formatDate), null);
});

/* ---- escaping ------------------------------------------------------------ */

test("esc neutralises markup from user-written fields", () => {
  assert.equal(esc(`<img src=x onerror="alert(1)">`),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(esc("Tom & Jerry's"), "Tom &amp; Jerry&#39;s");
  assert.equal(esc(null), "");
});

test("safeUrl allows http(s) and rejects script schemes", () => {
  assert.equal(safeUrl("https://example.gov.uk/"), "https://example.gov.uk/");
  assert.equal(safeUrl("javascript:alert(1)"), "#");
  assert.equal(safeUrl("data:text/html;base64,x"), "#");
  assert.equal(safeUrl(""), "#");
});

/* ---- formatting ---------------------------------------------------------- */

test("formatAge reads naturally at each scale", () => {
  assert.equal(formatAge(0.5), "30 min ago");
  assert.equal(formatAge(3.2), "3.2 hours ago");
  assert.equal(formatAge(26), "1 day ago");
  assert.equal(formatAge(50), "2 days ago");
  assert.equal(formatAge(null), "never");
});
