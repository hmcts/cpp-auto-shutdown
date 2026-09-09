/* Schedule resolution — what configuration says a stack SHOULD be doing.
 *
 * Pure functions, no DOM, no clock of their own. This is the part that decides
 * whether someone's environment is up during a release, so it is unit tested
 * in tests/schedule.test.js.
 *
 * EVERY stack runs the same baseline: 06:00-19:00, weekdays only. There are no
 * permanent per-stack alterations — the always-on stacks from the EA Confluence
 * page do not carry over. An applied exception is the only thing that can change
 * any of it, and exceptions are always dated, so they expire.
 *
 * Weekend and bank holiday running is therefore just an exception whose date
 * range covers those days; it needs no separate rule.
 *
 * Precedence, highest first:
 *   1. an applied exception covering today
 *   2. bank holiday -> stays down
 *   3. weekend      -> stays down
 *   4. baseline 06:00-19:00 */

import { toMinutes, isWeekend, addDays, compareClock } from "./time.js";

export const BASELINE_START = "06:00";
export const BASELINE_STOP = "19:00";

/** Exception whose window covers `date`. `appliedOnly` ignores unapplied requests. */
export function exceptionFor(exceptions, stackId, date, appliedOnly = true) {
  return exceptions.find(e =>
    e.stacks.includes(stackId) &&
    (!appliedOnly || e.applied) &&
    e.start <= date && date <= e.end) || null;
}

export function nextExceptionFor(exceptions, stackId, date) {
  return exceptions
    .filter(e => e.stacks.includes(stackId) && e.start > date)
    .sort((a, b) => a.start.localeCompare(b.start))[0] || null;
}

/**
 * Resolve the effective schedule for a stack at a moment in time.
 * Returns { status, start, stop, kind } where `stop` is null when the stack
 * is not due to shut down today, and `kind` explains which rule applied.
 */
export function resolveSchedule(stack, { date, minutes, exceptions = [], bankHolidays = {} }) {
  const exception = exceptionFor(exceptions, stack.id, date, true);
  if (exception) {
    if (exception.window === "24h") {
      return { status: "started", start: null, stop: null, kind: "exception" };
    }
    const [start, stop] = exception.window.split("-");
    const inHours = minutes >= toMinutes(start) && minutes < toMinutes(stop);
    return { status: inHours ? "started" : "stopped", start, stop, kind: "exception" };
  }

  const bankHoliday = bankHolidays[date];
  if (bankHoliday) {
    return { status: "stopped", start: null, stop: null,
             kind: "bankHoliday", detail: bankHoliday };
  }
  if (isWeekend(date)) {
    return { status: "stopped", start: null, stop: null, kind: "weekendOff" };
  }

  const inHours = minutes >= toMinutes(BASELINE_START) && minutes < toMinutes(BASELINE_STOP);
  return {
    status: inHours ? "started" : "stopped",
    start: BASELINE_START, stop: BASELINE_STOP,
    kind: "baseline"
  };
}

/**
 * Scheduled start/stop times that have already fallen due, most recent first,
 * as London wall-clock points { date, minutes }.
 *
 * Each one is a moment an action should have run and therefore produced a
 * verified observation. Days on which the stack never runs — weekends and bank
 * holidays it has not opted into — contribute nothing, which is what stops a
 * quiet Sunday from looking like a failure. Stacks that run 24 hours have no
 * transitions at all and are judged by the age backstop instead.
 */
export function dueTransitions(stack, context, limit = 2, lookbackDays = 14) {
  const now = { date: context.date, minutes: context.minutes };
  const found = [];
  let date = context.date;

  for (let day = 0; day < lookbackDays && found.length < limit; day++) {
    const resolved = resolveSchedule(stack, { ...context, date, minutes: 0 });

    // A day only has transitions if the stack both starts and stops on it.
    if (resolved.start && resolved.stop) {
      for (const time of [resolved.stop, resolved.start]) {   // newest first
        const point = { date, minutes: toMinutes(time) };
        if (compareClock(point, now) <= 0) found.push(point);
        if (found.length >= limit) break;
      }
    }
    date = addDays(date, -1);
  }
  return found;
}
