/* The join between declared intent (config) and what verification observed (state).
 *
 * Pure functions, unit tested in tests/model.test.js.
 *
 * Two invariants from the observed-state design drive most of this:
 *   - a failed or missing verification writes NOTHING, so the previous record
 *     stays and `observedAt` simply stops advancing. A failed check is therefore
 *     only detectable as age, never as an explicit "unknown" value.
 *   - a null component means "not part of this stack", not "stopped". */

import { ageInHours } from "./time.js";
import { resolveSchedule, exceptionFor, nextExceptionFor } from "./schedule.js";

/* Hours after which an observation stops being trustworthy. Still a guess — it should
 * follow the actual pipeline run cadence (379 every 30 min, 416 hourly). */
export const STALE_HOURS = 4;

export const COMPONENTS = ["aks", "iaas", "paas"];
export const COMPONENT_LABELS = { aks: "AKS", iaas: "IaaS", paas: "PaaS" };

/**
 * Combine one stack's config and state into everything the row needs.
 * `observed` is what the state file says; `schedule.status` is what config
 * expects. Disagreement between them is drift.
 */
export function buildRow(stack, record, context) {
  const schedule = resolveSchedule(stack, context);
  const age = ageInHours(record, context.now);

  const observed = record ? record.aggregateStatus : "unknown";
  const stale = record ? (age === null || age > STALE_HOURS) : true;

  // Only compare when we have a fresh, unambiguous reading. A partial result
  // is neither started nor stopped, so drift cannot be judged from it.
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
