# Environment Board — build spec (v1)

Design output for the dashboard build story.

In this repo:
- `docs/index.html` — the page (markup only)
- `docs/styles.css` — design system
- `docs/js/` — ES modules, no bundler and no framework:
  - `time.js` Europe/London clock helpers
  - `schedule.js` schedule resolution — pure, unit tested
  - `model.js` config/state join, staleness, drift, exception lifecycle — pure, unit tested
  - `data.js` fetching and normalising both files
  - `dom.js` escaping helpers
  - `render.js` DOM output
  - `main.js` wiring
- `tests/` — `npm test` (node's built-in runner, no dependencies)
- `config/stacks.yaml` — sample configuration (declared intent)
- `state/environments/dev.json`, `ste.json` — sample observed state

Run locally with `npm run serve` and open http://localhost:8000.
Add `?ref=BRANCH` to read data from a branch before it is merged.

## 1. Purpose and audience

Delivery Managers, not engineers. It answers four questions: is my stack up, when does it
shut down, whose is it, and is my exception request actually going to take effect.

It replaces the manually maintained EA Confluence "Environment Status" table.

## 2. Hosting and data flow

Static site, GitHub Pages, public. No framework, no build step.

Because the repo is public the browser fetches source files directly — there is no
server-side merge, no generated `data.json`, and no rebuild when state changes:

    https://raw.githubusercontent.com/hmcts/cpp-auto-shutdown/main/config/stacks.yaml
    https://raw.githubusercontent.com/hmcts/cpp-auto-shutdown/main/state/environments/<env>.json

- `raw.githubusercontent.com` sends `access-control-allow-origin: *` and `cache-control: max-age=300`.
- Poll every 60s AND on `visibilitychange` (a DM may leave the tab open all day).
- Pages redeploy is only needed when the HTML/JS itself changes.
- Freshness ceiling is ~5 min (CDN), but the state file itself only changes every 30–60 min
  (379 every 30 min, 416 hourly), so this is as fresh as the data ever gets.
- `config/stacks.yaml` is YAML, parsed in the browser with `js-yaml` 4.1.0 from cdnjs.
  DECIDED: YAML stays, because config is the file humans read and review in PRs, and it
  carries explanatory comments that JSON cannot. Note that js-yaml turns an unquoted
  `2026-09-08` into a `Date`; `toIsoDate()` normalises it.
- Bank holidays come from `https://www.gov.uk/bank-holidays.json` (england-and-wales), which
  sends `access-control-allow-origin: *`. If it is unavailable the board carries on and simply
  treats the day as an ordinary weekday.

On fetch failure: keep the last good render, show a banner stating the data could not be
refreshed and when it last loaded. Never silently show stale data as if it were current.

## 3. Data contract

Two files, joined on stack ID. The dashboard is read-only; it writes to neither.

**config/stacks.yaml** — declared intent. Supplies: stack id, environment, stack components
(Full AKS / AKS / IaaS / PaaS), owner (DM name), used-for, URLs, notes, baseline schedule and
alterations, and exceptions (including requester, approver, date window, window preset,
applied/merged status, Jira ref, issue number).

**state/environments/<env>.json** — observed state. One record per stack, replaced in place,
never appended. Per the observed-state design:

    {
      "stack": "steccm13",
      "stackComponents": ["AKS"],
      "aggregateStatus": "started",         // started | stopped | partial
      "observedAt": "2026-09-03T04:12:25Z", // last SUCCESSFUL verified observation
      "sourcePipeline": 402,
      "sourceRunId": 825735,
      "components": {
        "paas": null,                       // null = not part of this stack
        "iaas": null,
        "aks": { "requested": true, "status": "started",
                 "verified": true, "reason": "All requested AKS workloads ready" }
      }
    }

Invariants the UI must respect:
- A failed or missing verification writes NOTHING. The old record stays and `observedAt`
  stops advancing. `unknown` is never persisted. So a failed check is only detectable as age.
- `null` component means "not part of this stack" — not "stopped", not "missing".

Join edge cases:
- In config, no state record  -> "Never checked".
- In state, not in config     -> orphan; show with a "no longer in configuration" marker
                                 rather than dropping silently. Whether pipeline 167
                                 deletes the record or writes a tombstone is still open.
- `stackComponents` disagreeing with config's declared components -> surface as inconsistency.

## 4. Views

Three tabs, single page, shared filter state:

1. **Environments** (default) — the board.
2. **Calendar** — month grid, exceptions as bars spanning their date range, bank holidays marked.
3. **Exceptions** — Active now / Upcoming / Finished, grouped, with requester, approver and status.

Environment switcher: DEV, STE (SIT and NFT present but disabled, "reserved for expansion").

## 5. Environments tab — six columns

| # | Column        | Source                                                        |
|---|---------------|---------------------------------------------------------------|
| 1 | Stack         | config — id + component chips (AKS / IaaS / PaaS)              |
| 2 | Owner (DM)    | config                                                         |
| 3 | Used for      | config                                                         |
| 4 | State now     | **state** — aggregateStatus + per-component line + age flags   |
| 5 | Shuts down    | config — effective stop time today                             |
| 6 | Exception req | config — lifecycle state + date window + request link          |

Five of six columns are config. Only column 4 comes from the state file.

Each column answers exactly one question. Column 5 must NOT restate the exception (which
request, whose, what dates) — that belongs to column 6. Column 5 says only what time it goes
off today, with a short qualifier: `later than baseline`, `weekend hours`,
`extended by exception`.

Summary tiles above the table: Up now / Shut down / Needs attention.
Filters: free-text search, owner select, and a single "Needs attention only" toggle.

## 6. Derivation rules

**Baseline**: 06:00 start, 19:00 stop.
**Shutdown delays**: 21:00, 23:00, 24h.
**Weekend / bank holiday presets**: 06:00–19:00, 06:00–21:00, 06:00–23:00, 24h.
**Bank holidays**: from https://www.api.gov.uk/gds/bank-holidays/ (England & Wales).
Startup is suppressed on a bank holiday unless the stack has a weekend/BH preset or an
active exception. Cache the response; it changes yearly.

**State now** — from the state record, never inferred from the clock:
- `started` -> "Up"
- `stopped` -> "Shut down"
- `partial` -> "Partly up" (warning colour) — components disagree
- no record -> "Not known" + flag "Never checked"

Beneath the pill, for any stack with more than one component, show the per-component line:
`AKS up · PaaS down`. Single-component stacks show nothing (it would only repeat the pill).

**Staleness**: if `now - observedAt > STALE_HOURS` (default 4, DECISION NEEDED) flag
"Last checked Xh ago — a check may have failed". The displayed value is still real, just old.

**Drift**: observed status != what config expects right now, on a fresh non-partial record.
Show as a quiet per-row flag "Not what the schedule says — ask the platform team".
NOT a summary tile and NOT a filter in v1.

## 7. Exception lifecycle

Four states, driven by whether the change has been approved and applied.

| State                   | Condition                          | Consequence shown                                               |
|-------------------------|------------------------------------|-----------------------------------------------------------------|
| Not approved            | not applied, no approver           | Won't apply — stack still shuts down. Needs approving before <date> |
| Approved, not applied   | not applied, approver present      | Won't apply — stack still shuts down. Chase the platform team    |
| Approved from <date>    | applied, window in the future      | —                                                                |
| Active now              | applied, today inside window       | —                                                                |
| Ended                   | window has passed                  | —                                                                |

The two blocked states are deliberately separate because they need different people:
one needs an approver, the other is a platform failure after approval. Avoid the word
"yet" — it implies progress that is not happening.

Automation reads only applied/merged configuration, so an unapplied request has no effect.
This is the one piece of pipeline mechanics a DM must understand, so it stays on the row.

Calendar and Exceptions tab must derive their labels from the same function as the table so
the three views cannot drift apart.

## 8. Detail row (expand per stack)

- Per-component verification: component, status, verified flag, and the `reason` string
- `observedAt` age, with the stale explanation if applicable
- `sourcePipeline` and `sourceRunId`, linked to the ADO run
- URLs and notes from config

## 9. Acceptance criteria

- [ ] Three tabs: Environments, Calendar, Exceptions
- [ ] Environments shows the six columns above, sourced as specified
- [ ] State is read from the state file and never inferred from the clock
- [ ] `partial` renders as "Partly up" with the per-component line
- [ ] Stale and never-checked render differently and are not conflated
- [ ] Exception states use the outcome wording in §7, with consequence text on blocked states
- [ ] Baseline, delays, weekend presets and bank-holiday suppression all honoured
- [ ] Data refreshes without a redeploy; failed fetch keeps last good render and warns
- [ ] Works on a laptop screen without horizontal page scroll; light and dark themes
- [ ] No secrets or tokens in client-side code
- [ ] All user-written text (owner, used_for, notes, justification) is HTML-escaped before
      it reaches the DOM — these fields originate in issue forms
- [ ] Tabs follow the APG tablist pattern: arrow keys, Home/End, roving tabindex
- [ ] Schedule rules covered by unit tests, including BST boundaries
