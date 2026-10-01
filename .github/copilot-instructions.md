# Copilot instructions

## Commands

- Install test-only schema dependencies with `npm ci` (or `npm install`), then run all
  tests with `npm test`. Run only dashboard unit tests (`tests/dashboard/**/*.test.js`, no dependencies)
  with `npm run test:dashboard`, or only data validation (`tests/data-validation/**/*.test.js`) with
  `npm run test:data`.
- Run one test file with `node --test tests/dashboard/model.test.js` or
  `node --test tests/data-validation/schema.test.js`.
- Filter to one test by name, for example:
  `node --test --test-name-pattern="baseline boundaries are inclusive" tests/dashboard/schedule.test.js`.
- Serve the dashboard locally with `npm run serve`, then open
  `http://localhost:8000`.
- There is no separate build or lint script. Run the configured repository checks with
  `pre-commit run --all-files --show-diff-on-failure`.

## Architecture

This is a static, framework-free dashboard served from `docs/`; browser ES modules are
used directly without a build step. `docs/js/data.js` fetches the YAML configuration,
per-environment observed-state JSON, and England/Wales bank holidays. `model.js` joins
configured stack identity with observations and derives row status; `schedule.js` and
`time.js` resolve schedules and London wall-clock dates; `render.js` generates the board,
calendar, and exception views; `main.js` wires loading, refresh, filters, and navigation.

`config/stacks.yaml` describes declared stack intent; workflow-owned dated requests live in
`config/exceptions.yaml`; and `state/environments/*.json` records the last successful live
observation. Their contracts are defined by `schemas/stacks.schema.json`,
`schemas/exceptions.schema.json`, and `schemas/environment-state.schema.json`; `npm run test:data`
validates both YAML files and every environment JSON file. Keep these contracts separate:
the dashboard is read-only, and a failed verification leaves the last observed record in
place. CI is split: `dashboard-tests.yaml` runs dashboard unit tests on `docs/js/**` and `tests/dashboard/**`
changes, and `data-validation.yaml` runs data validation on `config/**`,
`state/environments/**`, and `schemas/**` changes. The Pages workflow publishes `docs/` on pushes to `main` that change `docs/**`;
state/config changes are read from the public repository at runtime and do not require a
Pages rebuild.

## Codebase conventions

- Keep schedule and model rules as pure functions, with explicit time/context inputs.
  Put London timezone and date helpers in `time.js`; do not use the machine's local
  timezone for schedule decisions. Cover BST/GMT boundaries in `tests/schedule.test.js`.
- Every stack uses the weekday baseline of 06:00–19:00 Europe/London. An applied,
  date-bounded exception is the only override and takes precedence over weekends and
  bank holidays; unapplied exceptions do not affect the schedule.
- Preserve the intent/observation distinction: missing records mean “never checked,”
  `partial` is a known mixed result, and `null` components mean the stack does not have
  that component. Staleness is based on missed scheduled transitions, with the 72-hour
  backstop only when fewer than two due transitions are available.
- Centralize exception lifecycle wording/derivation in `model.js` so all dashboard views
  agree. Add or update tests in `tests/model.test.js` when changing derived states.
- Owner, usage, notes, justification, and other issue-form values are user-written even
  when they arrive through repository files. Never interpolate them unescaped into
  `innerHTML`: use `esc()` in HTML templates or the escaping `html` tagged template from
  `dom.js`. Use `safeUrl()` for `href` values; it permits only HTTP(S) URLs.
- Keep browser data requests on the public raw-file URLs in `data.js`; do not switch to
  `api.github.com`, whose unauthenticated rate limit is shared by dashboard viewers.
- Follow `security.md` for vulnerability reports; do not report vulnerabilities in
  public issues or pull requests.
