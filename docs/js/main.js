/* Wiring: load data, build rows, render, refresh. */

import { $, $$, esc } from "./dom.js";
import { londonClock, formatDate } from "./time.js";
import { buildRow } from "./model.js";
import { loadConfig, loadState, loadBankHolidays, dataRef } from "./data.js";
import { renderBoard, renderSummary, renderCalendar, renderExceptions } from "./render.js";

const POLL_MS = 60_000;

const state = {
  config: { stacks: [], exceptions: [] },
  observed: {},                  // env -> { stackId: record }
  bankHolidays: {},
  filters: { query: "", owner: "all", env: "DEV", attentionOnly: false },
  calendar: null
};

/* ---- data ---------------------------------------------------------------- */

async function loadAll() {
  const [config, bankHolidays] = await Promise.all([loadConfig(), loadBankHolidays()]);
  state.config = config;
  state.bankHolidays = bankHolidays;
  await loadEnv(state.filters.env);
}

async function loadEnv(env) {
  if (!state.observed[env]) state.observed[env] = {};
  state.observed[env] = await loadState(env);
}

/* ---- derive -------------------------------------------------------------- */

function context() {
  const clock = londonClock();
  return {
    now: new Date(),
    date: clock.date,
    minutes: clock.minutes,
    exceptions: state.config.exceptions,
    bankHolidays: state.bankHolidays
  };
}

function rowsForEnv(ctx) {
  const env = state.filters.env;
  const observed = state.observed[env] || {};
  return state.config.stacks
    .filter(s => s.env === env)
    .map(s => buildRow(s, observed[s.id] || null, ctx));
}

function applyFilters(rows) {
  const { query, owner, attentionOnly } = state.filters;
  const q = query.trim().toLowerCase();
  return rows.filter(row => {
    if (attentionOnly && !row.needsAttention) return false;
    if (owner !== "all" && row.stack.owner !== owner) return false;
    if (!q) return true;
    return [row.stack.id, row.stack.use, row.stack.owner, row.stack.notes]
      .join(" ").toLowerCase().includes(q);
  });
}

/* ---- render -------------------------------------------------------------- */

function render() {
  const ctx = context();
  const all = rowsForEnv(ctx);
  const visible = applyFilters(all);

  renderBoard(visible, ctx.date);
  renderSummary(all);
  $("#shown").textContent = `${visible.length} of ${all.length} stacks`;

  if (!state.calendar) {
    state.calendar = { year: Number(ctx.date.slice(0, 4)), month: Number(ctx.date.slice(5, 7)) };
  }
  renderCalendar(state.config.exceptions, { ...state.calendar, today: ctx.date, bankHolidays: state.bankHolidays });
  renderExceptions(state.config.exceptions, ctx.date);

  $("#cnt-stacks").textContent = state.config.stacks.length;
  $("#cnt-exc").textContent = state.config.exceptions.filter(e => e.end >= ctx.date).length;

  const upcoming = Object.keys(state.bankHolidays).filter(d => d >= ctx.date).sort()[0];
  $("#bh-note").innerHTML = upcoming
    ? `Next bank holiday <b>${esc(formatDate(upcoming))}</b> &mdash; stacks stay down unless excepted`
    : `Bank holidays are checked before every startup`;

  const clock = londonClock();
  $("#stamp").textContent =
    `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")} · Europe/London`;
}

function refreshOwners() {
  const select = $("#owner");
  const names = [...new Set(state.config.stacks
    .filter(s => s.env === state.filters.env).map(s => s.owner))].sort();
  select.innerHTML = `<option value="all">Anyone</option>` +
    names.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
  state.filters.owner = "all";
}

function setStatus(text, isError) {
  const chip = $("#src-chip");
  chip.textContent = text;
  chip.classList.toggle("chip-error", Boolean(isError));
}

/* ---- events -------------------------------------------------------------- */

/* Tabs follow the APG tablist pattern: arrows move between tabs, Home/End jump
 * to the ends, and only the selected tab is in the tab order. */
function wireTabs() {
  const tabs = $$(".tab");
  const panels = { "tab-board": "view-board", "tab-cal": "view-cal", "tab-exc": "view-exc" };

  const select = tab => {
    tabs.forEach(t => {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(`#${panels[t.id]}`).classList.toggle("hidden", !on);
    });
    tab.focus();
  };

  tabs.forEach((tab, i) => {
    tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", event => {
      const moves = {
        ArrowRight: (i + 1) % tabs.length,
        ArrowLeft: (i - 1 + tabs.length) % tabs.length,
        Home: 0,
        End: tabs.length - 1
      };
      if (event.key in moves) {
        event.preventDefault();
        select(tabs[moves[event.key]]);
      }
    });
  });
}

function wireControls() {
  $("#q").addEventListener("input", e => { state.filters.query = e.target.value; render(); });
  $("#owner").addEventListener("change", e => { state.filters.owner = e.target.value; render(); });

  $("#attn").addEventListener("click", e => {
    state.filters.attentionOnly = !state.filters.attentionOnly;
    e.currentTarget.setAttribute("aria-pressed", String(state.filters.attentionOnly));
    render();
  });

  $$(".env").forEach(button => button.addEventListener("click", async () => {
    $$(".env").forEach(b => b.setAttribute("aria-pressed", "false"));
    button.setAttribute("aria-pressed", "true");
    state.filters.env = button.dataset.env;
    refreshOwners();
    try {
      await loadEnv(state.filters.env);
      setStatus(`Live · ${dataRef()}`, false);
    } catch (err) {
      setStatus("Could not load this environment", true);
      console.error(err);
    }
    render();
  }));

  $("#tbody").addEventListener("click", event => {
    const button = event.target.closest("[data-toggle]");
    if (!button) return;
    const id = button.dataset.toggle;
    const detail = document.querySelector(`tr[data-detail="${CSS.escape(id)}"]`);
    const open = !detail.classList.toggle("hidden");
    document.querySelector(`tr.row[data-id="${CSS.escape(id)}"]`).classList.toggle("open", open);
    button.setAttribute("aria-expanded", String(open));
  });

  $("#prev").addEventListener("click", () => {
    state.calendar.month--;
    if (state.calendar.month < 1) { state.calendar.month = 12; state.calendar.year--; }
    render();
  });
  $("#next").addEventListener("click", () => {
    state.calendar.month++;
    if (state.calendar.month > 12) { state.calendar.month = 1; state.calendar.year++; }
    render();
  });
}

/* ---- refresh ------------------------------------------------------------- */

/* On failure keep the last good render and say so. Never silently show stale
 * data as though it were current. */
async function refresh() {
  try {
    state.config = await loadConfig();
    await loadEnv(state.filters.env);
    setStatus(`Live · ${dataRef()}`, false);
    render();
  } catch (err) {
    setStatus("Refresh failed — showing last loaded data", true);
    console.error(err);
  }
}

async function start() {
  wireTabs();
  wireControls();
  try {
    await loadAll();
    refreshOwners();
    setStatus(`Live · ${dataRef()}`, false);
    render();
  } catch (err) {
    console.error(err);
    setStatus("Could not load data", true);
    $("#tbody").innerHTML = `<tr><td colspan="6" style="padding:24px">
      <b>Could not load environment data.</b><br>
      Tried <code>${esc(dataRef())}</code> on <code>hmcts/cpp-auto-shutdown</code>.
      If this branch is not merged yet, append <code>?ref=BRANCH-NAME</code> to the URL.
      <br><span class="muted">${esc(err.message)}</span></td></tr>`;
    return;
  }

  setInterval(refresh, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
}

start();
