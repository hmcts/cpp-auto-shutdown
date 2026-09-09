/* Schedule resolution — what configuration says a stack SHOULD be doing.
 *
 * Pure functions, no DOM, no clock of their own. This is the part that decides
 * whether someone's environment is up during a release, so it is unit tested
 * in tests/schedule.test.js.
 *
 * Precedence, highest first:
 *   1. an applied exception covering today
 *   2. bank holiday        -> no startup unless the stack opts in
 *   3. weekend             -> no startup unless a weekend preset is set
 *   4. baseline 06:00-19:00, optionally with a later shutdown */

import { toMinutes, isWeekend } from "./time.js";

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
    const stop = exception.window === "24h" ? null : exception.window.split("-")[1];
    return { status: "started", start: BASELINE_START, stop, kind: "exception" };
  }

  const bankHoliday = bankHolidays[date] || null;
  const special = Boolean(bankHoliday) || isWeekend(date);

  // Bank holidays and weekends only run if the stack has opted in with a preset.
  if (special && !stack.weekend) {
    return {
      status: "stopped", start: BASELINE_START, stop: null,
      kind: bankHoliday ? "bankHoliday" : "weekendOff",
      detail: bankHoliday
    };
  }

  const window = special ? stack.weekend : (stack.stop || BASELINE_STOP);
  if (window === "24h") {
    return { status: "started", start: null, stop: null, kind: "allDay" };
  }

  const [start, stop] = special ? window.split("-") : [BASELINE_START, window];
  const inHours = minutes >= toMinutes(start) && minutes < toMinutes(stop);

  return {
    status: inHours ? "started" : "stopped",
    start, stop,
    kind: special ? "weekend"
        : (stack.stop && stack.stop !== BASELINE_STOP ? "extended" : "baseline")
  };
}
