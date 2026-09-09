/* Rendering. All user-supplied text goes through esc(); see dom.js. */

import { esc, safeUrl, $ } from "./dom.js";
import { formatDate, formatAge, isWeekend } from "./time.js";
import { BASELINE_START } from "./schedule.js";
import { componentReadings, exceptionStatus, stateLabel, COMPONENTS, COMPONENT_LABELS }
  from "./model.js";

const ISSUES = "https://github.com/hmcts/cpp-auto-shutdown/issues";
const ADO = "https://dev.azure.com/hmcts-cpp/cpp-apps/_build/results?buildId=";

/* Column 5 says only what time it goes off today. Which request caused it
 * belongs to column 6 — the two must not repeat each other. Baseline needs no
 * qualifier: 19:00 is simply what every stack does. */
const QUALIFIER = {
  exception: "changed by exception",
  baseline: "", bankHoliday: "", weekendOff: ""
};

function shutdownCell(schedule, observed) {
  const pair = (big, small) =>
    `<span class="when">${big}<span class="sub">${small}</span></span>`;

  if (schedule.kind === "bankHoliday") {
    return pair("&mdash;", `${esc(schedule.detail || "Bank holiday")} &mdash; not started today`);
  }
  if (schedule.kind === "weekendOff") return pair("&mdash;", "Weekends are not scheduled");
  if (observed === "stopped") {
    return pair("&mdash;", `Already down &middot; next start ${esc(schedule.start || BASELINE_START)}`);
  }
  if (!schedule.stop) return pair("Stays on", "Running 24h by exception");
  const q = QUALIFIER[schedule.kind];
  return pair(esc(schedule.stop), `today${q ? ` &middot; ${q}` : ""}`);
}

function componentLine(record) {
  const parts = componentReadings(record);
  if (parts.length < 2) return "";
  const rendered = parts.map(p => {
    const cls = !p.verified ? "no" : p.status === "started" ? "ok" : "";
    return `<b>${esc(p.label)}</b> <span class="${cls}">${esc(p.word)}</span>`;
  });
  return `<span class="cstate">${rendered.join('<span class="sep">·</span>')}</span>`;
}

export function renderBoard(rows, today) {
  const body = $("#tbody");

  body.innerHTML = rows.map(row => {
    const { stack, record, schedule } = row;
    const status = exceptionStatus(row.exception, row.exceptionIsLive, today, formatDate);

    const exceptionCell = status
      ? `<span class="pill ${status.key === "live" ? "effect"
            : status.key === "ended" ? "expired" : "notmerged"}">${esc(status.label)}</span>
         ${status.warning ? `<span class="excwarn">${esc(status.warning)}</span>` : ""}
         <span class="win">${esc(formatDate(row.exception.start))} &ndash; ${esc(formatDate(row.exception.end))}</span>
         <a href="${ISSUES}/${encodeURIComponent(row.exception.issue)}" class="reqlink">Request #${esc(row.exception.issue)}</a>`
      : `<span class="muted">None</span>`;

    const chips = COMPONENTS.map(key => {
      const label = COMPONENT_LABELS[key];
      const on = stack.components.includes(label);
      return `<span class="comp${on ? " on" : ""}">${esc(label)}</span>`;
    }).join("");

    const urls = stack.urls.length
      ? stack.urls.map(u => `<li>${u.role ? `<span class="url-role">${esc(u.role)}</span>` : ""}<a href="${safeUrl(u.url)}">${esc(String(u.url).replace(/^https:\/\//, ""))}</a></li>`).join("")
      : `<li class="muted" style="font-size:12.5px">No URLs recorded</li>`;

    const componentDetail = record
      ? componentReadings(record).map(p =>
          `<p class="kv"><b>${esc(p.label)}</b> &mdash; ${esc(p.status)}${
            p.verified ? "" : ", could not be confirmed"}<br><span class="rsn">${esc(p.reason)}</span></p>`).join("")
      : `<p class="kv">This stack is in the schedule but has never been successfully checked, so there is no result to show.</p>`;

    const provenance = record
      ? `<p class="kv">Last checked <b>${esc(formatAge(row.age))}</b>${
           row.stale ? " — older than expected. A check has probably failed; the last known result is kept and the platform team is alerted." : ""}</p>
         <p class="kv tech">Pipeline ${esc(record.sourcePipeline)} ·
           <a href="${ADO}${encodeURIComponent(record.sourceRunId)}">run ${esc(record.sourceRunId)}</a></p>`
      : `<p class="kv">No successful check on record.</p>`;

    return `
    <tr class="row ${row.needsAttention ? "attn" : esc(row.observed)}" data-id="${esc(stack.id)}">
      <td class="first">
        <div class="stack-id">${esc(stack.id)}</div>
        <div class="comps">${chips}</div>
        <button class="disclose" data-toggle="${esc(stack.id)}" aria-expanded="false">
          <span class="caret">&rsaquo;</span> Detail</button>
      </td>
      <td class="owner"><span class="nm">${esc(stack.owner)}</span></td>
      <td class="use">${esc(stack.use)}</td>
      <td>
        <span class="pill ${esc(row.observed)}">${esc(stateLabel(row.observed))}</span>
        ${componentLine(record)}
        ${row.drift ? `<span class="flag">Not what the schedule says &mdash; ask the platform team</span>` : ""}
        ${!row.drift && row.stale && record ? `<span class="flag">Last checked ${esc(formatAge(row.age))} &mdash; expected updates have not arrived</span>` : ""}
        ${!record ? `<span class="flag">Never checked</span>` : ""}
      </td>
      <td>${shutdownCell(schedule, row.observed)}</td>
      <td class="exc-cell">${exceptionCell}</td>
    </tr>
    <tr class="detail hidden" data-detail="${esc(stack.id)}">
      <td colspan="6">
        <div class="detail-grid">
          <div class="dl"><div class="dt">Components</div>${componentDetail}</div>
          <div class="dl"><div class="dt">Verification</div>${provenance}</div>
          <div class="dl"><div class="dt">Endpoints</div><ul>${urls}</ul></div>
          <div class="dl"><div class="dt">Notes</div><p>${esc(stack.notes) || "&mdash;"}</p></div>
        </div>
      </td>
    </tr>`;
  }).join("");
}

export function renderSummary(rows) {
  const count = predicate => rows.filter(predicate).length;
  const attention = count(r => r.needsAttention);
  $("#strip").innerHTML = `
    <div class="stat"><span class="k"><i class="dot up"></i>Up now</span>
      <span class="v">${count(r => r.observed === "started")}</span>
      <span class="n">of ${rows.length} stacks</span></div>
    <div class="stat"><span class="k"><i class="dot down"></i>Shut down</span>
      <span class="v">${count(r => r.observed === "stopped")}</span>
      <span class="n">as scheduled</span></div>
    <div class="stat${attention ? " alarm" : ""}"><span class="k"><i class="dot wn"></i>Needs attention</span>
      <span class="v">${attention}</span>
      <span class="n">unexpected, unknown or unchecked</span></div>`;
}

export function renderCalendar(exceptions, { year, month, today, bankHolidays }) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  $("#month").textContent = new Intl.DateTimeFormat("en-GB",
    { month: "long", year: "numeric", timeZone: "UTC" }).format(first);

  const offset = (first.getUTCDay() + 6) % 7;               // Monday-first
  const gridStart = new Date(first);
  gridStart.setUTCDate(1 - offset);
  const iso = d => d.toISOString().slice(0, 10);

  let out = `<div class="dow">${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]
    .map(d => `<div>${d}</div>`).join("")}</div>`;
  let any = false;

  for (let w = 0; w < 6; w++) {
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(gridStart);
      d.setUTCDate(gridStart.getUTCDate() + w * 7 + i);
      return d;
    });
    if (days[0].getUTCMonth() !== month - 1 && w > 3) break;

    const cells = days.map(d => {
      const key = iso(d);
      const outside = d.getUTCMonth() !== month - 1;
      const isToday = key === today;
      const weekend = isWeekend(key);
      const holiday = bankHolidays[key];
      return `<div class="day${outside ? " out" : ""}${weekend && !isToday ? " wknd" : ""}${isToday ? " today" : ""}"
        ${holiday ? `title="${esc(holiday)}"` : ""}>
        <span>${d.getUTCDate()}</span>${holiday ? `<span class="bh">BH</span>` : ""}</div>`;
    }).join("");

    const weekStart = iso(days[0]);
    const weekEnd = iso(days[6]);
    const bars = exceptions
      .flatMap(e => e.stacks.map(stackId => ({ e, stackId })))
      .filter(({ e }) => e.start <= weekEnd && e.end >= weekStart)
      .sort((a, b) => a.e.start.localeCompare(b.e.start) || a.stackId.localeCompare(b.stackId))
      .map(({ e, stackId }) => {
        const from = Math.max(0, days.findIndex(d => iso(d) === e.start));
        const endIndex = days.findIndex(d => iso(d) === e.end);
        const to = endIndex === -1 ? 6 : endIndex;
        const live = e.applied && e.start <= today && e.end >= today;
        const status = exceptionStatus(e, live, today, formatDate);
        const cls = e.end < today ? "expired" : e.applied ? "merged" : "unmerged";
        const text = e.applied
          ? (e.end < today ? "ended"
             : `stays on to ${e.window === "24h" ? "midnight" : e.window.split("-")[1]}`)
          : status.label.toLowerCase();
        any = true;
        return `<div class="bar ${cls}" style="grid-column:${from + 1} / ${to + 2}"
          title="${esc(stackId)} — ${esc(status.label)}${status.warning ? `. ${esc(status.warning)}` : ""}. ${esc(e.justification)}">
          <span class="b-stack">${esc(stackId)}</span>
          <span class="b-txt">${esc(text)}</span></div>`;
      }).join("");

    out += `<div class="week"><div class="days">${cells}</div><div class="lanes">${bars}</div></div>`;
  }

  $("#cal").innerHTML = out +
    (any ? "" : `<div class="cal-empty">No exceptions this month.</div>`);
}

export function renderExceptions(exceptions, today) {
  const groups = [
    ["Active now", e => e.start <= today && e.end >= today],
    ["Upcoming",   e => e.start > today],
    ["Finished",   e => e.end < today]
  ];

  $("#excpanel").innerHTML = groups.map(([title, predicate]) => {
    const items = exceptions.filter(predicate).sort((a, b) => a.start.localeCompare(b.start));
    if (!items.length) return "";

    const cards = items.map(e => {
      const live = e.applied && e.start <= today && e.end >= today;
      const status = exceptionStatus(e, live, today, formatDate);
      const cls = e.end < today ? "expired" : e.applied ? "merged" : "unmerged";
      const nights = Math.round(
        (Date.parse(`${e.end}T00:00:00Z`) - Date.parse(`${e.start}T00:00:00Z`)) / 86_400_000) + 1;
      const approval = e.approver === "auto" ? "auto-approved (within policy limits)"
        : e.approver ? `approved by ${e.approver}` : "no approver yet";

      return `<div class="exc ${cls}">
        <div><div class="w">${esc(formatDate(e.start))} &ndash; ${esc(formatDate(e.end))}
          <small>${nights} night${nights === 1 ? "" : "s"} · ${esc(e.window)}</small></div></div>
        <div>
          <div class="stacks">${e.stacks.map(s => `<code>${esc(s)}</code>`).join("")}</div>
          <p class="why">${esc(e.justification)}</p>
          <div class="who">Requested by ${esc(e.requester)} &middot; ${esc(approval)}</div>
          ${e.applied ? "" : `<p class="warn-line">&#9888; ${esc(
            e.approver
              ? `Approved by ${e.approver}, but not yet applied to the schedule.`
              : "Not approved, so it has not been applied to the schedule.")}
            It is having no effect &mdash; the environment will still shut down at its usual
            time, and it needs to be in place before ${esc(formatDate(e.start))}.</p>`}
        </div>
        <div class="right">
          <span class="pill ${status.key === "live" ? "effect" : status.key === "ended" ? "expired" : "notmerged"}">${esc(status.label)}</span>
          <a href="${ISSUES}/${encodeURIComponent(e.issue)}">Request #${esc(e.issue)}</a>
          <span class="muted" style="font-family:var(--mono);font-size:11.5px">${esc(e.reference)}</span>
        </div>
      </div>`;
    }).join("");

    return `<div class="exc-group">
      <h3>${title} <span class="rule"></span>
        <span style="font-family:var(--mono);font-weight:400">${items.length}</span></h3>
      <div class="exc-list">${cards}</div>
    </div>`;
  }).join("");
}
