/* The join between declared intent (config) and what verification observed (state).
 *
 * Pure functions, unit tested in tests/model.test.js.
 *
 * Two invariants from the observed-state design drive most of this:
 *   - a failed or missing verification writes NOTHING, so the previous record
 *     stays and `observedAt` simply stops advancing. A failed check is therefore
 *     only detectable as age, never as an explicit "unknown" value.
 *   - a null component means "not part of this stack", not "stopped". */

import { ageInHours, londonClock, compareClock } from "./time.js";
import { resolveSchedule, exceptionFor, nextExceptionFor, dueTransitions } from "./schedule.js";

/* Staleness is measured against the schedule, not a fixed duration.
 *
 * `observedAt` only advances when something ACTS on a stack: 416 triggers only
 * the stacks needing action, and 379 invokes 375 only on a mismatch. Under
 * healthy operation a stack is therefore observed about twice a day — once at
 * startup, once at shutdown — so any flat threshold short enough to be useful
 * would flag every stack overnight, and one long enough to survive a bank
 * holiday weekend (83h between a Friday shutdown and a Tuesday startup) would
 * catch nothing.
 *
 * So: a record is stale once TWO consecutive scheduled transitions have passed
 * without a new observation. One missed transition is tolerated because the
 * pipeline already alerts and the next run retries — flagging there would only
 * duplicate an alert the platform team has, and would flap on failures that
 * self-heal. Two missed transitions means it has not self-healed, which is the
 * thing only this board can say. */

/* Backstop for stacks with no transitions to count — one under a long 24h
 * exception, or too newly added to have two behind it. Nothing acts on such a
 * stack, so nothing observes it either, and its record would otherwise age
 * forever unnoticed. 72h says: three days with no verification at all means we
 * have lost sight of it.
 *
 * This deliberately does NOT apply to stacks that do transition. A legitimate
 * Friday-to-Tuesday gap over a bank holiday runs to about 83 hours, so applying
 * an age cap there would flag healthy stacks every long weekend — which is the
 * whole reason the primary rule counts transitions instead of hours. */
export const MAX_OBSERVATION_AGE_HOURS = 72;

export const COMPONENTS = ["aks", "iaas", "paas"];
export const COMPONENT_LABELS = { aks: "AKS", iaas: "IaaS", paas: "PaaS" };

/**
 * Has this record stopped being maintained?
 *
 * Stale once two consecutive due transitions have passed with no new
 * observation. Falls back to an age cap where the schedule provides nothing to
 * measure against: 24h stacks, and stacks too newly scheduled to have two
 * transitions behind them yet.
 */
export function isStale(stack, record, age, context) {
  if (!record || !record.observedAt) return true;

  const transitions = dueTransitions(stack, context, 2);
  if (transitions.length < 2) {
    return age !== null && age > MAX_OBSERVATION_AGE_HOURS;
  }

  const observed = londonClock(new Date(record.observedAt));
  return compareClock(observed, transitions[1]) < 0;
}

/**
 * Combine one stack's config and state into everything the row needs.
 * `observed` is what the state file says; `schedule.status` is what config
 * expects. Disagreement between them is drift.
 */
export function buildRow(stack, record, context) {
  const schedule = resolveSchedule(stack, context);
  const age = ageInHours(record, context.now);

  const observed = record ? record.aggregateStatus : "unknown";
  const stale = isStale(stack, record, age, context);

  // Only compare when we have a reading we trust. A partial result is neither
  // started nor stopped, so drift cannot be judged from it.
  //
  // A single missed transition leaves the record fresh by design, so the case
  // that matters most — a startup that failed this morning — still surfaces
  // here as drift, immediately, rather than waiting on staleness.
  const drift = Boolean(record) && !stale
    && observed !== "partial" && observed !== "unknown"
    && observed !== schedule.status;

  const activeException = exceptionFor(context.exceptions, stack.id, context.date, false);
  const nextException = nextExceptionFor(context.exceptions, stack.id, context.date);

  return {
    stack, record, schedule, observed, age, stale, drift,
    exception: activeException || nextException,
    exceptionIsLive: Boolean(activeException && activeException.applied),
    needsAttention: drift || stale || observed === "unknown" || observed === "partial"
  };
}

/** Per-component readings, for stacks made of more than one component. */
export function componentReadings(record) {
  if (!record) return [];
  return COMPONENTS
    .filter(key => record.components && record.components[key])
    .map(key => {
      const c = record.components[key];
      return {
        key,
        label: COMPONENT_LABELS[key],
        status: c.status,
        verified: c.verified,
        reason: c.reason,
        word: !c.verified ? "not known" : c.status === "started" ? "up" : "down"
      };
    });
}

/**
 * Exception lifecycle in outcome language. Never Git vocabulary: a DM does not
 * think in merges. The two blocked states are separate because they need
 * different people — one needs an approver, the other is a platform failure
 * after approval already happened.
 */
export function exceptionStatus(exception, isLive, today, formatDate) {
  if (!exception) return null;

  if (exception.end < today) {
    return { key: "ended", label: "Ended", warning: null };
  }
  if (!exception.applied) {
    const deadline = formatDate(exception.start);
    return exception.approver
      ? {
          key: "blocked", label: "Approved, not applied",
          warning: `Won't apply — stack still shuts down. Chase the platform team before ${deadline}`
        }
      : {
          key: "blocked", label: "Not approved",
          warning: `Won't apply — stack still shuts down. Needs approving before ${deadline}`
        };
  }
  if (isLive) {
    return { key: "live", label: "Active now", warning: null };
  }
  return { key: "live", label: `Approved from ${formatDate(exception.start)}`, warning: null };
}

/** State pill wording. `partial` is not "unknown" — it is known, and wrong. */
export function stateLabel(observed) {
  switch (observed) {
    case "started": return "Up";
    case "stopped": return "Shut down";
    case "partial": return "Partly up";
    default:        return "Not known";
  }
}
