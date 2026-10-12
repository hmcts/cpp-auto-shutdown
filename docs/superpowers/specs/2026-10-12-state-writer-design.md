# State writer in GitHub Actions — design

Status: approved for planning (2026-10-12). Source design: `cpp-auto-shutdown-draft/README.md`
(sections 3–7, 12, 14). This spec adapts it from Azure DevOps to GitHub Actions in this repo.

## 1. Goal

Prove, end to end inside GitHub, the observe → write → reconcile loop that keeps
`state/environments/<env>.json` equal to what was last observed, so state drift
(state that disagrees with reality, or with the schedule) is detected and corrected by
the next run instead of persisting.

| ADO | GitHub workflow | Role |
|---|---|---|
| 416 `run-custom-auto-startup-shutdown` | `custom-auto-startup-shutdown.yaml` | Scheduler: decides which stacks to start/stop, calls 402/404, writes once |
| 402 `cpp-full-environment-start` | `full-environment-start.yaml` | Start one stack (simulated), observe, write (direct) or publish (orchestrated) |
| 404 `cpp-full-environment-shutter` | `full-environment-shutter.yaml` | Stop one stack (simulated), observe, write or publish |
| (reconciler) | `state-reconciliation.yaml` | Re-observe and re-write one stack, 3 attempts |

## 2. Scope and non-goals

In scope: the four workflows; Bash state-writer scripts with the draft's names and
contracts; Node helpers (schema validation, config lookup, planning); alerting via
`::error` and the job summary (Slack only if a `SLACK_WEBHOOK_URL` secret exists);
offline tests.

Non-goals (this iteration):
- No Azure access. Start/stop legs and component observers are **simulated**.
- No Confluence or Azure Blob reads. The plan uses this repo's config and state.
- No cron. `custom-auto-startup-shutdown.yaml` is `workflow_dispatch` only; the intended
  schedule (three runs a day: 06:00, 19:00, 21:00 Europe/London) is documented in a
  comment and the README, to be enabled after review.
- Schemas are not widened (`dev`, `ste` only — draft §14.1.5 stays open).
- The existing probe workflow and the dashboard are not changed.

## 3. Data sources for the plan (416)

`scripts/state/schedule-plan.mjs` reads:
- `config/stacks.yaml` (stacks, environment, components),
- `config/exceptions.yaml` (only `applied: true` entries matter, as in `schedule.js`),
- `state/environments/*.json` (last observed state),
- bank holidays from `https://www.gov.uk/bank-holidays.json` (england-and-wales); on
  failure, warn and continue with none. `--bank-holidays FILE` injects a local file (tests).

It imports `docs/js/schedule.js` (`resolveSchedule`) and `docs/js/time.js`
(`londonClock`, `toIsoDate`) so the scheduler and the dashboard cannot disagree about intent.

For each stack: `desired = resolveSchedule(...).status`; observed = the stack's
`aggregateStatus` (missing record → none). The stack is planned when observed ≠ desired
(including `partial` and missing), or always when `--force`. Filters: `--environments`
(comma list), `--stacks` (comma list, case-insensitive), `--now` (ISO timestamp override).

Output (`$GITHUB_OUTPUT` when set, and a JSON summary on stdout):
- `start` / `stop`: JSON arrays of `{"stack": "<lower-case id>", "environment": "<env>"}`,
- `requestedStacks`: comma list of `stack:expectedState` (e.g. `steccm43:stopped`),
- `hasWork`: `true|false`.

## 4. Workflows

All workflows: top-level `permissions: contents: read`; scripts run with
`set -uo pipefail`; no secrets printed; action versions match existing workflows
(`actions/checkout@v4`, `actions/setup-node@v4`, `actions/create-github-app-token@v3`,
plus `actions/upload-artifact@v4` / `actions/download-artifact@v4`).

### 4.1 `full-environment-start.yaml` / `full-environment-shutter.yaml`

Triggers: `workflow_dispatch` and `workflow_call`, same inputs:

| Input | Default | Notes |
|---|---|---|
| `stack` | required | lower-case accepted |
| `stateWriteMode` | `direct` | `none` \| `direct` \| `orchestrated`; 416 passes `orchestrated` |
| `simulate` | `success` | `success`, `action-failed`, `partial`, `unverifiable:<aks\|iaas\|paas>` |

Job `environment` (no GitHub environment, no secrets):
1. Checkout; setup Node 22; `npm ci --ignore-scripts`.
2. Simulated legs, logged in order (start: PAAS → IAAS → AKS; shutter: AKS → IAAS → PAAS).
   `action-failed` fails the first leg; later steps still observe.
3. `observation-create.sh` with `if: always()` — resolves components from
   `config/stacks.yaml` (case-insensitive id), writes one simulated fragment per declared
   component and assembles `observation.json`:
   `success` → every component reports the expected state; `action-failed` → every
   component reports the opposite; `partial` → the first declared component reports the
   opposite; `unverifiable:<c>` → no fragment for `c`, so no `observation.json` (exit 1,
   step `continue-on-error`). `sourcePipeline` 402/404 (integer); `sourceRunId`
   `github.run_id`; `observedAt` UTC now.
4. Upload artifact `observation-<stack>` (`if: always()`, `if-no-files-found: warn`).

Job `state-write` (direct mode only, `needs: environment`, `if: always()`): §4.3 with
`requestedStacks = <stack>:<expected>`, then reconcile (`uses: state-reconciliation.yaml`)
or alert jobs gated on its outputs.

### 4.2 `custom-auto-startup-shutdown.yaml` (416)

Trigger: `workflow_dispatch` (inputs `force`, `environments`, `stacks`, `simulate`, `now`).
Jobs:
1. `plan` → outputs from §3.
2. `start` / `stop`: matrix over the plan arrays (`fail-fast: false`), `uses:` the
   402/404 reusable workflows with `stateWriteMode: orchestrated`; skipped when empty.
3. `state-write` (`if: always() && needs.plan.outputs.hasWork == 'true'`): download all
   `observation-*` artifacts (pattern, not merged) into `observations/`, then §4.3 with
   `EXPECTED_RUN_IDS = github.run_id` and `REQUESTED_STACKS` from the plan.
4. `resolve-targets` + `reconcile`: when `reconciliationRequired == 'true'`, run
   `reconciliation-resolve-targets.sh`, then matrix (`max-parallel: 1`, `fail-fast: false`)
   `uses: ./.github/workflows/state-reconciliation.yaml`.
5. `alert`: when `alertRequired == 'true'` → `state-write-alert.sh`.

All children run inside the same workflow run, so observations share `sourceRunId`;
validation de-duplicates by stack and checks freshness by `observedAt`.

No `concurrency` group on any write job: GitHub cancels pending runs in a group, which
would silently drop writes. Contention is handled by stale-base retry.

### 4.3 Write job (shared shape)

Runs in GitHub environment `state-writer` (administrators: deployment branch `main` only).
Steps: checkout; setup Node 22; `npm ci --ignore-scripts`; App token via the local
composite action `.github/actions/state-write-token` (same secret contract and
decode/validation as the probe workflow: `CPP_GITHUB_MANAGEMENT_APP_ID`,
`CPP_GITHUB_MANAGEMENT_INSTALLATION_ID`, `CPP_GITHUB_MANAGEMENT_PRIVATE_KEY`; token
scoped to `hmcts/cpp-auto-shutdown`, `permission-contents: write`); `state-write.sh`.
Job outputs: `writeOutcome`, `alertRequired`, `reconciliationRequired`, `requestedStacks`,
`requestedStates`, `acceptedStacks`, `rejectedStacks`, `baseSha`.
`stateWriteMode: none` and `orchestrated` skip the job inside 402/404.

### 4.4 `state-reconciliation.yaml`

Triggers: `workflow_call` and `workflow_dispatch`; inputs `stack`, `expectedState`,
`triggeringRunId`. One job in environment `state-writer`. Three attempts unrolled as
steps (`attempt1..3`), each `continue-on-error: true`; attempts 2–3 run only if no
earlier attempt wrote `succeeded`. Each attempt clears the previous observation, runs
`observation-create.sh --simulate success --requested true` (every declared component
`requested: true`), then `state-write.sh` with `MAX_RETRIES=1`. If none succeeded:
`state-write-alert.sh` then fail the job. Never triggers another reconciler.

## 5. Scripts (`scripts/state/`)

Bash scripts: `#!/usr/bin/env bash`, `set +x`, `set -uo pipefail`, `jq`, `git`; log with
`::notice::` / `::warning::` / `::error::`; outputs appended to `$GITHUB_OUTPUT` when set,
otherwise printed as `key=value`. Never print tokens.

| Script | Contract |
|---|---|
| `observation-create.sh` | `--stack S --pipeline 402\|404 --expected-state started\|stopped --simulate MODE --output-dir D [--run-id N] [--requested true\|false] [--config FILE]` → `D/observation-<stack>/observation.json`; exit 1 with no file when unverifiable. Fragment `{requested, status, verified, reason}`; `aggregateStatus` = common status of declared components else `partial`. |
| `state-write.sh` | Wrapper (draft §4). Env: `OBSERVATIONS_DIR`, `RESULTS_DIR`, `MAX_RETRIES` (3), `EXPECTED_RUN_IDS`, `REQUESTED_STACKS`, `STATE_REPO_URL` (default `https://github.com/hmcts/cpp-auto-shutdown.git`), `STATE_BRANCH` (`main`), `STATE_REPO_DIR` (default `$RESULTS_DIR/../state-repo`), `STATE_WRITE_TOKEN` (optional), `RETRY_SLEEP_MIN`/`MAX` (2/10; tests 0). Retries only `stale-base`. EXIT trap emits all outputs and warns if accepted+rejected ≠ requested. Exit 0 for succeeded/partial/rejected/stale-base, 1 for git-failed/script-failure. |
| `state-write-validate.sh` | Draft §14.1.2: discarded / rejected / passed; stack from directory name minus `observation-` prefix and `_<runId>` suffix, upper-cased; ties → higher `sourceRunId`. Writes `validate-result.json` `{rejectedStacks, baseSha}`. |
| `state-write-merge.sh` | Draft §14.1.3: replace `stacks.<ID>` in place (key order kept), create missing env file, re-validate, `merge-result.json` `{acceptedStacks, sourcePipelines, sourceRunIds}`. |
| `state-write-push.sh` | Draft §14.1.4. Token via `-c http.extraheader="AUTHORIZATION: basic <base64(x-access-token:TOKEN)>"` only when `STATE_WRITE_TOKEN` is set, never in the URL. Stale-base on SHA mismatch or `[rejected]`/non-fast-forward; any other failure git-failed; no change → succeeded with sha = baseSha and a warning. Commits as `cpp-github-management[bot]` / `devops-team@hmcts.net`; stages only `state/environments/`. Writes `push-result.json` `{writeOutcome, writtenCommitSha}`. |
| `reconciliation-resolve-targets.sh` | Draft §6: partial/rejected → `rejectedStacks`; stale-base → all requested; else all requested + warning. Fails (exit 1) if a target has no expected state. Emits `stacksJson` and `matrix` (`{"include":[{"stack":"STECCM43","expectedState":"stopped"}]}`). |
| `state-write-alert.sh` | `--case C [--details TEXT]`: `::error::`, appends to `$GITHUB_STEP_SUMMARY`, posts JSON to `SLACK_WEBHOOK_URL` if set (post failure is a warning). Includes the run link. |
| `schema-validate.mjs` | `node schema-validate.mjs <schema> <json>`: ajv 2020 + ajv-formats; exit 0 valid, 1 invalid (errors on stderr), 2 usage/IO. |
| `config-stack.mjs` | `node config-stack.mjs <stacks.yaml> <stackId>` → `{"id","environment","components"}`; case-insensitive; exit 1 if unknown. |
| `schedule-plan.mjs` | §3. |

## 6. Drift handling

- Every 402/404 run observes, even after a failed leg, so state reflects reality.
- A write is accepted only when strictly newer than the live record; older or invalid
  observations become `rejectedStacks` and are reconciled.
- 416 plans from **observed** state, so a stack that disagrees with the schedule is acted
  on at the next run (self-healing); `force` re-asserts every stack.
- One write per 416 run; pushes are never forced; stale base is retried.

## 7. Testing

`npm run test:state` → `node --test "tests/state/**/*.test.js"`, included in `npm test`.
CI `.github/workflows/state-writer-tests.yaml` (PR and push to `main`, paths
`scripts/state/**`, `tests/state/**`, the four workflows, `.github/actions/**`,
`schemas/**`, `package.json`). Tests are offline: `mkdtemp()` + local bare repos, no
network, no tokens, and never write the checked-in `config/**` or `state/**`.

Minimum cases: observation-create (each simulate mode; output valid against the schema);
validate (each group, prefix/suffix stripping, ties, empty dir, clone failure → non-zero);
merge (in place, new env file, rejected untouched); push (clean, stale-base after remote
advance, git-failed via a rejecting `pre-receive` hook, no change, no token in output);
wrapper (succeeded, partial, rejected, stale-base recovering on retry, git-failed,
script-failure — outputs and exit codes); resolve-targets; alert without Slack;
schedule-plan (weekday in/out of hours, weekend, bank holiday, applied exception, already
in state, force, missing record); workflow contracts (YAML parses, triggers, permissions,
`state-writer` environment on write jobs, no `concurrency` on write jobs, `max-parallel: 1`
on reconcile, 416 has no `schedule` trigger). Existing `npm test` suites must still pass.

## 8. Documentation

README section "State writer (GitHub Actions)": workflows, simulate inputs, administrator
setup of the `state-writer` environment, intended cron, outcomes table. Update
`.github/copilot-instructions.md` with the new commands and conventions.

## 9. Open items

- Real Azure action/observation (bridge to ADO or full port) — next iteration.
- Enable cron after review; widen schemas for `sit`/`nft`.
- Confirm the App may push directly to `main` for `state/environments/**` under current
  rulesets (the probe only proved a root-marker write).
