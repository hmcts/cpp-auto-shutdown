import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveSchedule, exceptionFor, nextExceptionFor, BASELINE_START, BASELINE_STOP
} from "../docs/js/schedule.js";
import { londonClock, toMinutes, isWeekend, toIsoDate } from "../docs/js/time.js";

/* Config carries no schedule: every stack runs the baseline and only an applied
 * exception changes it. */
const stack = (over = {}) => ({ id: "DEVCCM01", ...over });
const at = hhmm => toMinutes(hhmm);
const exception = (over = {}) => ([{
  stacks: ["DEVCCM01"], start: WEEKDAY, end: WEEKDAY, window: "24h", applied: true, ...over
}]);

const WEEKDAY = "2026-09-09";   // Wednesday
const SATURDAY = "2026-09-12";
const SUNDAY = "2026-09-13";
const BANK_HOLIDAY = "2026-08-31";
const holidays = { [BANK_HOLIDAY]: "Summer bank holiday" };

const ctx = (date, hhmm, extra = {}) =>
  ({ date, minutes: at(hhmm), exceptions: [], bankHolidays: holidays, ...extra });

test("baseline: up inside 06:00-19:00, down outside", () => {
  assert.equal(resolveSchedule(stack(), ctx(WEEKDAY, "10:00")).status, "started");
  assert.equal(resolveSchedule(stack(), ctx(WEEKDAY, "05:59")).status, "stopped");
  assert.equal(resolveSchedule(stack(), ctx(WEEKDAY, "19:00")).status, "stopped");
  assert.equal(resolveSchedule(stack(), ctx(WEEKDAY, "18:59")).status, "started");
});

test("baseline boundaries are inclusive of start, exclusive of stop", () => {
  assert.equal(resolveSchedule(stack(), ctx(WEEKDAY, BASELINE_START)).status, "started");
  assert.equal(resolveSchedule(stack(), ctx(WEEKDAY, BASELINE_STOP)).status, "stopped");
});

test("every stack runs the same baseline — config carries no schedule", () => {
  const result = resolveSchedule(stack(), ctx(WEEKDAY, "10:00"));
  assert.equal(result.kind, "baseline");
  assert.equal(result.start, BASELINE_START);
  assert.equal(result.stop, BASELINE_STOP);
});

test("weekends are never scheduled without an exception", () => {
  assert.equal(resolveSchedule(stack(), ctx(SATURDAY, "10:00")).kind, "weekendOff");
  assert.equal(resolveSchedule(stack(), ctx(SUNDAY, "10:00")).status, "stopped");
});

test("bank holiday suppresses startup and names the holiday", () => {
  const result = resolveSchedule(stack(), ctx(BANK_HOLIDAY, "10:00"));
  assert.equal(result.status, "stopped");
  assert.equal(result.kind, "bankHoliday");
  assert.equal(result.detail, "Summer bank holiday");
});

test("an exception delays the shutdown for its dates only", () => {
  const exceptions = exception({ window: "06:00-23:00" });
  const during = resolveSchedule(stack(), ctx(WEEKDAY, "22:00", { exceptions }));
  assert.equal(during.status, "started");
  assert.equal(during.stop, "23:00");
  assert.equal(during.kind, "exception");

  // Past the exception's own window, and on a day it does not cover.
  assert.equal(resolveSchedule(stack(), ctx(WEEKDAY, "23:30", { exceptions })).status, "stopped");
  assert.equal(resolveSchedule(stack(), ctx("2026-09-10", "22:00", { exceptions })).kind, "baseline");
});

test("a 24h exception reports no stop time", () => {
  const result = resolveSchedule(stack(), ctx(WEEKDAY, "03:00", { exceptions: exception() }));
  assert.equal(result.status, "started");
  assert.equal(result.stop, null);
  assert.equal(result.kind, "exception");
});

test("weekend running is just an exception covering those dates", () => {
  const exceptions = exception({ start: SATURDAY, end: SUNDAY, window: "06:00-19:00" });
  assert.equal(resolveSchedule(stack(), ctx(SATURDAY, "10:00", { exceptions })).status, "started");
  assert.equal(resolveSchedule(stack(), ctx(SATURDAY, "20:00", { exceptions })).status, "stopped");
  assert.equal(resolveSchedule(stack(), ctx(SUNDAY, "10:00", { exceptions })).status, "started");
});

test("an applied exception outranks a bank holiday", () => {
  const exceptions = exception({ start: BANK_HOLIDAY, end: BANK_HOLIDAY });
  const result = resolveSchedule(stack(), ctx(BANK_HOLIDAY, "23:00", { exceptions }));
  assert.equal(result.status, "started");
  assert.equal(result.kind, "exception");
});

test("an UNAPPLIED exception changes nothing", () => {
  const exceptions = exception({ applied: false });
  const result = resolveSchedule(stack(), ctx(WEEKDAY, "23:00", { exceptions }));
  assert.equal(result.status, "stopped");
  assert.equal(result.kind, "baseline");
});

test("exceptionFor respects the date window and applied flag", () => {
  const list = [{ stacks: ["A"], start: "2026-09-10", end: "2026-09-12", applied: true }];
  assert.ok(exceptionFor(list, "A", "2026-09-10"));
  assert.ok(exceptionFor(list, "A", "2026-09-12"));
  assert.equal(exceptionFor(list, "A", "2026-09-13"), null);
  assert.equal(exceptionFor(list, "B", "2026-09-11"), null);

  const unapplied = [{ ...list[0], applied: false }];
  assert.equal(exceptionFor(unapplied, "A", "2026-09-11"), null);
  assert.ok(exceptionFor(unapplied, "A", "2026-09-11", false));
});

test("nextExceptionFor picks the soonest future window", () => {
  const list = [
    { stacks: ["A"], start: "2026-10-01", end: "2026-10-02", applied: true },
    { stacks: ["A"], start: "2026-09-20", end: "2026-09-21", applied: true }
  ];
  assert.equal(nextExceptionFor(list, "A", "2026-09-09").start, "2026-09-20");
});

/* Timezone: schedules are wall clock, so a BST instant must read as local time.
 * 2026-06-01T09:30Z is 10:30 in London (BST); in winter the offset is zero. */
test("londonClock returns London wall clock across BST and GMT", () => {
  const summer = londonClock(new Date("2026-06-01T09:30:00Z"));
  assert.equal(summer.date, "2026-06-01");
  assert.equal(summer.hour, 10);
  assert.equal(summer.minutes, 630);

  const winter = londonClock(new Date("2026-12-01T09:30:00Z"));
  assert.equal(winter.hour, 9);
});

test("londonClock rolls the date correctly late in the evening in BST", () => {
  // 23:30 UTC on 30 June is 00:30 on 1 July in London.
  const clock = londonClock(new Date("2026-06-30T23:30:00Z"));
  assert.equal(clock.date, "2026-07-01");
  assert.equal(clock.hour, 0);
});

test("day-of-week is stable regardless of BST offset", () => {
  assert.equal(isWeekend("2026-09-12"), true);
  assert.equal(isWeekend("2026-09-13"), true);
  assert.equal(isWeekend("2026-09-14"), false);
  assert.equal(isWeekend("2026-06-14"), true);   // Sunday, during BST
});

test("toIsoDate normalises the Dates js-yaml produces from unquoted dates", () => {
  assert.equal(toIsoDate(new Date("2026-09-08T00:00:00Z")), "2026-09-08");
  assert.equal(toIsoDate("2026-09-08"), "2026-09-08");
});
