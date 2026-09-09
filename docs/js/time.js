/* Time handling, all anchored to Europe/London.
 *
 * Every function takes an explicit `now` so behaviour is testable across BST
 * boundaries rather than depending on the machine clock. Schedules are wall
 * clock times, so comparisons must be made in London local time, never UTC. */

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const LONDON = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false
});

/** Wall clock in London for an instant: { date: 'YYYY-MM-DD', minutes, hour, minute }. */
export function londonClock(now = new Date()) {
  const p = LONDON.formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  const hour = Number(p.hour === "24" ? "0" : p.hour);
  const minute = Number(p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour, minute,
    minutes: hour * 60 + minute
  };
}

/** "HH:MM" to minutes past midnight. */
export function toMinutes(hhmm) {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/* Day-of-week is derived at noon UTC so a BST offset can never tip the
 * calculation into the previous or next day. */
export function dayOfWeek(isoDate) {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

export function isWeekend(isoDate) {
  const d = dayOfWeek(isoDate);
  return d === 0 || d === 6;
}

/** Age of an observation in hours. Accepts a real ISO `observedAt`. */
export function ageInHours(record, now = new Date()) {
  if (!record || !record.observedAt) return null;
  return (now.getTime() - Date.parse(record.observedAt)) / 3_600_000;
}

export function formatDate(isoDate) {
  const [, m, d] = isoDate.split("-");
  return `${d} ${MONTHS[Number(m) - 1]}`;
}

export function formatAge(hours) {
  if (hours == null) return "never";
  if (hours < 1) return `${Math.round(hours * 60)} min ago`;
  if (hours < 24) return `${hours.toFixed(1)} hours ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/* Compare two London wall-clock points, {date, minutes}. Comparing in wall clock
 * rather than UTC keeps schedule times and observations on the same footing and
 * avoids converting a local time back to an instant across a DST change. */
export function compareClock(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.minutes - b.minutes;
}

export function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** js-yaml turns unquoted `2026-09-08` into a Date. Normalise to a string. */
export function toIsoDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
