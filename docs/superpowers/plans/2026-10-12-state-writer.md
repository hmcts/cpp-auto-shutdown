# GitHub State Writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an offline-tested GitHub Actions observe → write → reconcile loop for simulated 402/404 runs and the 416 schedule planner.

**Architecture:** Focused Bash scripts create observations, validate against the current state-repository base, merge, push, and coordinate outcomes; Node ES modules parse config, validate schemas, and reuse the dashboard schedule functions. Reusable workflows call the scripts and mint a scoped App token only in protected write jobs; all Git-write tests use isolated temporary bare repositories.

**Tech Stack:** Bash, jq, Git, Node.js 22+ ES modules, Ajv 8 / ajv-formats 3, yaml 2, GitHub Actions YAML, Node `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-12-state-writer-design.md`; source design: `/Users/charles.luo/dev/platops-cpp/services/cpp-auto-shutdown-draft/README.md` §§3–7, 12, 14.

## Global Constraints

- Use existing Node 22+ runtime and existing dependencies only: `ajv` 8, `ajv-formats` 3, `yaml` 2; add no dependencies.
- New Bash scripts begin `#!/usr/bin/env bash`, `set +x`, `set -uo pipefail`; use GitHub `::notice::`, `::warning::`, `::error::` annotations.
- Workflows have top-level `permissions: contents: read`; write jobs use protected environment `state-writer`; never add concurrency groups to write jobs.
- Use action versions `actions/checkout@v4`, `actions/setup-node@v4`, `actions/create-github-app-token@v3`, and artifact actions `@v4`.
- All component/action behavior is simulated; no Azure access. `custom-auto-startup-shutdown.yaml` is dispatch-only; intended cron is documented, never enabled.
- Keep schemas unchanged (`dev` and `ste` only); do not widen to `sit` or `nft`.
- Offline tests use `mkdtemp()` and local bare repos; never write checked-in `config/**` or `state/**`, access network, use a real token, or change the existing probe workflow/tests.
- In orchestrated mode all observation `sourceRunId` values and `EXPECTED_RUN_IDS` equal `github.run_id`; retry only `stale-base`.
- Push normally, never forced. Porcelain `[rejected]`/non-fast-forward means `stale-base`; `[remote rejected]` (including pre-receive hook rejection) means `git-failed`.
- Keep macOS/Linux portability: no GNU-only `date -d`, `sed -i`, `base64 -w`, or `shuf`; use Node date parsing / Bash `$RANDOM`; do not expand empty arrays under `set -u`.
- End every task with a focused passing test and a commit message trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/state/schema-validate.mjs`, `config-stack.mjs` | Ajv 2020 schema validation and case-insensitive YAML stack lookup. |
| `scripts/state/observation-create.sh` | Simulated component fragments and schema-checked observation assembly. |
| `scripts/state/state-write-validate.sh` | Refresh state clone, discard foreign/old duplicates, reject malformed, invalid, unknown, or stale observations. |
| `scripts/state/state-write-merge.sh` | Replace accepted records in-place per environment and validate changed JSON. |
| `scripts/state/state-write-push.sh` | Base SHA check, stage only state, commit, normal push, outcome JSON. |
| `scripts/state/state-write.sh` | Retry stale base, combine outcomes and always emit workflow outputs. |
| `scripts/state/reconciliation-resolve-targets.sh`, `state-write-alert.sh` | Reconcile matrix selection and GitHub/optional Slack alerts. |
| `scripts/state/schedule-plan.mjs` | Plan from config, exceptions, observed state and dashboard schedule library. |
| `.github/actions/state-write-token/action.yml` | Validate/mask the App key and mint scoped token using the probe's contract. |
| `.github/workflows/full-environment-start.yaml`, `full-environment-shutter.yaml` | Manual/reusable simulated 402 and 404 workflows. |
| `.github/workflows/state-reconciliation.yaml` | One stack, protected writer, three unrolled observation attempts. |
| `.github/workflows/custom-auto-startup-shutdown.yaml` | 416 planning, child matrices, one write, serialized reconciliation. |
| `tests/state/helpers.js`, `tests/state/*.test.js` | Isolated state/Git fixtures and focused script, planner, and workflow contract tests. |
| `package.json`, `.github/workflows/state-writer-tests.yaml` | State test command in aggregate runner and focused offline CI. |
| `README.md`, `.github/copilot-instructions.md` | Operator setup, workflow/outcome notes, development commands and conventions. |

---

### Task 1: Schema and Configuration Helpers

**Files:** Create `scripts/state/schema-validate.mjs`, `scripts/state/config-stack.mjs`, `tests/state/schema-config.test.js`; modify `package.json`.

**Interfaces:** `schema-validate.mjs <schema> <json>` returns 0 valid, 1 invalid (Ajv errors stderr), 2 usage/I/O error. `config-stack.mjs <stacks.yaml> <stack>` prints `{id,environment,components}`; unknown id returns 1. Add `test:state: node --test "tests/state/**/*.test.js"`; append `npm run test:state` to `npm test`.

- [ ] **Step 1: Add failing tests.** Tests use `spawnSync(process.execPath,...)`; valid checked-in `ste.json` passes; temporary `environment:"prod"` fails with Ajv diagnostic; `steccm43` resolves to `{id:"STECCM43",environment:"ste",components:["AKS","IaaS","PaaS"]}`; unknown stack exits 1.
- [ ] **Step 2: Run `node --test tests/state/schema-config.test.js`; verify missing module failures.**
- [ ] **Step 3: Implement.** `schema-validate.mjs` imports `Ajv2020` from `ajv/dist/2020.js` and `addFormats`, creates strict all-errors validator, reads and parses both files, reports invalid errors to stderr/exit 1 and usage/IO to stderr/exit 2. `config-stack.mjs` imports `parse` from `yaml`, requires a `.stacks` array, finds case-insensitively, prints only the three-field JSON contract, reports unknown/config errors to stderr.
- [ ] **Step 4: Run focused tests; expected PASS.**
- [ ] **Step 5: Commit** `feat: add state schema and config helpers` plus required trailer.

### Task 2: Simulated Observation Assembly

**Files:** Create `scripts/state/observation-create.sh`, `tests/state/observation-create.test.js`.

**Interface:** `--stack S --pipeline 402|404 --expected-state started|stopped --simulate MODE --output-dir D [--run-id N] [--requested true|false] [--config FILE]`; outputs `D/observation-<lower-stack>/observation.json`, or exit 1 and no observation for `unverifiable:<component>`.

- [ ] **Step 1: Write tests** for success, action-failed, partial, unverifiable, case-insensitive stack id, `requested`, null unused components, observation fields, aggregate status, and Ajv wrapper `{environment:"ste",stacks:{STECCM43:record}}`. Use `mkdtemp`/cleanup. Assert unverifiable mode creates no JSON.
- [ ] **Step 2: Run `node --test tests/state/observation-create.test.js`; expected fail.**
- [ ] **Step 3: Implement script.** Parse only known long options (no `eval`); validate pipeline/run ids and expected state; resolve metadata using Task 1 helper. Build fragment per declared component: success => expected; action-failed => opposite for every component; partial => opposite only for first declared; unverifiable => omit named fragment, emit warning and exit without observation. Every produced fragment is `{requested,status,verified:true,reason}`; non-declared component values are null. Aggregate unique declared statuses to common state or `partial`. Use `jq -n`, UTC `new Date().toISOString()` (via Node, not platform date extensions), validate the wrapped record with schema helper before atomically writing output. Append `observationPath` and `aggregateStatus` to `$GITHUB_OUTPUT` if present; otherwise print `key=value`. Log only single-line annotations.
- [ ] **Step 4: Run tests; expected PASS. Commit** `feat: add simulated state observations` with trailer.

### Task 3: Test Git Fixtures and State Observation Validation

**Files:** Create `tests/state/helpers.js`, `scripts/state/state-write-validate.sh`, `tests/state/state-write-validate.test.js`.

**Interface:** script args `--observations-dir D --expected-run-ids A,B --scratch-dir S`; env `STATE_REPO_URL`, `STATE_BRANCH`, `STATE_REPO_DIR`; writes `validate-result.json` `{rejectedStacks,baseSha}`. Empty/all-rejected is exit 0; Git/tool faults are nonzero.

- [ ] **Step 1: Create fixture helper and failing tests.** `helpers.js` creates a `mkdtemp()` root and bare `main`, seeds a normal repo with copies of `config/stacks.yaml`, three schemas and `state/environments/dev.json` + `ste.json`, commits using fixture-local identity, clones the writer checkout, and cleans via `t.after`. All subprocess environments use private HOME, `GIT_CONFIG_NOSYSTEM=1`, global config `/dev/null`, `GIT_ALLOW_PROTOCOL=file`, protocol allowlist for file only. Cover accepted valid record, invalid JSON/schema, unknown stack, payload/path mismatch, older-than-live, child-run exclusion, duplicate newest timestamp and run-id tie break, `observation-STACK_<runId>` basename handling, empty directory, and failed clone. Assert file deletion for discarded non-child/old duplicate, retention for rejected, result ordering/contents.
- [ ] **Step 2: Run state validation tests and confirm failure.**
- [ ] **Step 3: Implement `state-write-validate.sh`.** Parse flags, verify required commands and dirs; clone only when working copy absent; fetch, reset to `origin/$STATE_BRANCH`, clean, record base SHA. Derive stack from directory basename by stripping leading `observation-` and trailing `_<digits>`, uppercase. Parse expected run ids as comma list. Discard/delete nonchild observations; for each normalized stack retain greatest `(observedAt,sourceRunId)`, deleting other duplicates. For each survivor, reject (keep file and list path-derived stack) unreadable/malformed JSON, mismatched record.stack, unconfigured stack, failed schema, or timestamp not strictly newer than configured live state. Wrap record with its configured environment and uppercase ID so schema conditionals apply; use schema from refreshed working copy. An absent environment/record means no previous observation. Write compact sorted unique rejected names and baseSha atomically. Operational faults remain nonzero, never disguised as rejection.
- [ ] **Step 4: Run `node --test tests/state/state-write-validate.test.js`; expected PASS. Commit** `feat: validate state observations` plus trailer.

### Task 4: In-Place State Merge

**Files:** Create `scripts/state/state-write-merge.sh`, `tests/state/state-write-merge.test.js`.

**Interface:** args `--observations-dir D --scratch-dir S`; consumes validate result and `STATE_REPO_DIR`; writes `merge-result.json` `{acceptedStacks,sourcePipelines,sourceRunIds}`; no Git/network action.

- [ ] **Step 1: Test replacement (not append), preserving unrelated and orphan stack entries/key order; multiple environments; create absent environment as `{"environment":"<env>","stacks":{}}`; leave rejected records untouched; exact source metadata; invalid changed document errors.**
- [ ] **Step 2: Run focused tests and confirm absent implementation.**
- [ ] **Step 3: Implement.** Read rejected set from validation result; resolve each remaining record's config identity/environment; replace `stacks[ID]` only. Use Node's JSON object update to preserve insertion order of unrelated keys; write trailing newline. Validate each changed state document against current environment-state schema. Aggregate sorted uppercase accepted names and unique numeric source pipelines/run ids. Write merge result atomically. No accepted inputs is a valid empty result.
- [ ] **Step 4: Run merge tests; expected PASS. Commit** `feat: merge accepted state observations` plus trailer.

### Task 5: Normal Git Push and Precise Failure Classification

**Files:** Create `scripts/state/state-write-push.sh`, `tests/state/state-write-push.test.js`.

**Interface:** arg `--scratch-dir S`; consumes validate/merge JSON and state working repo; writes `{writeOutcome,writtenCommitSha}`; exits 0 only on succeeded, 1 otherwise.

- [ ] **Step 1: Test clean push and only state paths staged, no-change result/warning, remote moved since base, non-fast-forward stale result, hook `[remote rejected]` => git-failed, other Git errors => git-failed, and no token in output or URL.** Use temp bare repos only; create `pre-receive` hook that exits nonzero with a non-rejection reason.
- [ ] **Step 2: Run tests to confirm failure.**
- [ ] **Step 3: Implement.** Set local identity `cpp-github-management[bot]` / `devops-team@hmcts.net`; fetch and compare remote SHA with validate `baseSha` before staging. Mismatch => stale-base with no commit. Stage only `state/environments/`. Empty staged diff => succeeded/base SHA with warning. Commit including stack/source pipeline/run-id metadata. With token, pass it only through transient `git -c http.extraheader="AUTHORIZATION: basic ..."`; no URL or persistent config. Capture push porcelain output privately. Classify exact `[rejected]` or non-fast-forward/fetch-first as stale-base; `[remote rejected]`/hook/auth/network/other as git-failed. Write JSON for all outcomes before exit; never expose token or raw sensitive command output.
- [ ] **Step 4: Run focused tests; expected PASS. Commit** `feat: push state updates safely` plus trailer.

### Task 6: Retry Wrapper and Stable Outputs

**Files:** Create `scripts/state/state-write.sh`, `tests/state/state-write.test.js`.

**Interface:** env `OBSERVATIONS_DIR`, `RESULTS_DIR`, `MAX_RETRIES` default 3, `EXPECTED_RUN_IDS`, `REQUESTED_STACKS`, `STATE_REPO_URL` default GitHub repo, `STATE_BRANCH=main`, `STATE_REPO_DIR` default `$RESULTS_DIR/../state-repo`, optional `STATE_WRITE_TOKEN`, `RETRY_SLEEP_MIN/MAX=2/10`; output fields `writeOutcome`, `alertRequired`, `reconciliationRequired`, `requestedStacks`, `requestedStates`, `acceptedStacks`, `rejectedStacks`, `baseSha` to `$GITHUB_OUTPUT` or stdout. Exit 0 for succeeded/partial/rejected/stale-base; 1 for git-failed/script-failure.

- [ ] **Step 1: Test full real-child outcomes** succeeded, partial, rejected, stale-base recovering on retry, exhausted stale-base, git-failed hook, and missing/failing child => script-failure. Parse GITHUB_OUTPUT; assert exact outputs/exit codes, request state map and no token. Set retry min=max=0. Deterministic stale race uses a temporary `git` executable shim in tests: on first matching push, use a separate fixture clone to commit/push a concurrent descendant, then delegate original push; subsequent calls pass through. Do not add a production arbitrary-command hook.
- [ ] **Step 2: Run tests and confirm failure.**
- [ ] **Step 3: Implement.** Install EXIT trap before child calls. Normalize comma `stack:state` inputs to uppercase unique array/map; JSON-array input yields uppercase names and `{}` state map. Each try gets a fresh scratch subdirectory; validator, merger, pusher run in order. Child validation/merge nonzero or missing/malformed result => script-failure and both arrays empty. Missing requested observation gets added to rejected. Empty merge => rejected. Succeeded push => partial if rejects exist, otherwise succeeded. Stale => accepted empty, rejected union prior rejected+merged; retry only stale-base. Git-failed stops, no retries. Trap warns if accepted+rejected does not equal requested, sets reconcile true only partial/rejected/stale-base, alert true only git-failed/script-failure/unrecognized, never both, and writes each compact JSON output line. Use `$RANDOM` for configured wait; zero is permitted in tests. Never lose a recognized outcome because an output file is missing.
- [ ] **Step 4: Run `node --test tests/state/state-write.test.js`; expected PASS. Commit** `feat: orchestrate state write retries` plus trailer.

### Task 7: Reconciliation Target Resolver and Alerts

**Files:** Create `scripts/state/reconciliation-resolve-targets.sh`, `scripts/state/state-write-alert.sh`, `tests/state/reconciliation-alert.test.js`.

**Interfaces:** resolver consumes `WRITE_OUTCOME`, `REQUESTED_STACKS`, `REJECTED_STACKS`, `REQUESTED_STATES`; emits `stacksJson` and `matrix`. Alert accepts `--case C [--details TEXT]`; writes GitHub error/summary and optional Slack JSON post.

- [ ] **Step 1: Test partial/rejected uses rejected; stale uses requested; unknown outcome warns and fails safe to requested; missing/invalid expected state errors; exact include matrix; alert without Slack URL prints run link/error/summary; webhook never appears in output.**
- [ ] **Step 2: Run focused tests and confirm failure.**
- [ ] **Step 3: Implement.** Validate JSON with jq; expected states only `started|stopped`; resolver writes `[{"stack":"STECCM43","expectedState":"stopped"}]` and `{"include":[...]}`. If any target has no valid state, emit `::error::`, `alertRequired=true`, exit 1 and no partial matrix. Alert maps git-failed/script-failure/partial/rejected/stale-base/reconciliation-resolve-failed/reconciliation-invoke-failed to explanatory title/body; include `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` in Markdown `$GITHUB_STEP_SUMMARY`. For nonempty `SLACK_WEBHOOK_URL`, POST jq-built JSON with curl; POST errors yield warning only. Never log webhook URL or tokens.
- [ ] **Step 4: Run tests; expected PASS. Commit** `feat: add state reconciliation alerts` plus trailer.

### Task 8: Schedule Planner

**Files:** Create `scripts/state/schedule-plan.mjs`, `tests/state/schedule-plan.test.js`.

**Interface:** `node scripts/state/schedule-plan.mjs [--now ISO] [--environments dev,ste] [--stacks id,id] [--force] [--bank-holidays FILE]`; imports `resolveSchedule` from `../../docs/js/schedule.js`, `londonClock`, `toIsoDate` from `../../docs/js/time.js`. Outputs JSON `start`, `stop`, `requestedStacks`, `hasWork` to GITHUB_OUTPUT plus stdout summary.

- [ ] **Step 1: Test deterministic weekday in/out baseline hours, weekend, injected bank holiday, applied exception, matching state omitted, partial/missing/mismatching state included, force, env/stack filters and exact JSON output.** Use fixed `--now`, local bank-holiday file, temp config/state where needed; never network in tests.
- [ ] **Step 2: Run tests; expected fail.**
- [ ] **Step 3: Implement.** YAML parse stacks/exceptions; normalize exception dates with `toIsoDate`, consider only `applied:true`; parse bank-holiday file or fetch gov.uk `england-and-wales.events`. Fetch/shape failure emits warning and uses `{}`. Use `londonClock(new Date(now))` and `resolveSchedule` for each filtered stack. Observed is configured record `aggregateStatus`, missing => none. Include if observed differs or force. Partition lower-case stack/environment objects into start/stop and `stack:expectedState` list. Output `true|false` hasWork. Malformed local files/CLI arguments fail nonzero; do not hide as missing state. No host timezone or GNU date.
- [ ] **Step 4: Run tests; expected PASS. Commit** `feat: plan schedule state transitions` plus trailer.

### Task 9: Protected App Token Action

**Files:** Create `.github/actions/state-write-token/action.yml`, `tests/state/token-action.test.js`.

**Interface:** inputs app id, installation id, base64 private key; outputs repo-scoped token. Use exact probe secrets: `CPP_GITHUB_MANAGEMENT_APP_ID`, `CPP_GITHUB_MANAGEMENT_INSTALLATION_ID`, `CPP_GITHUB_MANAGEMENT_PRIVATE_KEY`.

- [ ] **Step 1: Tests** parse action YAML; assert steps/config, token action params, and Node decoder behavior for generated PKCS#1/PKCS#8 RSA, malformed/noncanonical base64, invalid key, EC, and raw PEM; generic diagnostics never include secret.
- [ ] **Step 2: Run test and confirm failure.**
- [ ] **Step 3: Implement action.** Composite checks positive integer IDs/nonempty key with xtrace off. Node validates canonical base64 round-trip, RSA PEM header and `createPrivateKey`, masks key lines + whole pkcs8 PEM using escaped `::add-mask::`, emits PEM through random-delimited GITHUB_OUTPUT. Then use `actions/create-github-app-token@v3`, owner `hmcts`, repositories `cpp-auto-shutdown`, permission contents write. Write jobs map protected environment secrets to inputs; no token/key in logs. Do not touch probe workflow.
- [ ] **Step 4: Run tests; expected PASS. Commit** `feat: add protected state writer token action` plus trailer.

### Task 10: Manual/Reusable Start and Shutter Workflows

**Files:** Create `.github/workflows/full-environment-start.yaml`, `full-environment-shutter.yaml`; create/extend `tests/state/workflow-contracts.test.js`.

**Interfaces:** `workflow_dispatch` + `workflow_call`; inputs `stack` required, `stateWriteMode` default direct (`none|direct|orchestrated`), `simulate` default success (`success`, `action-failed`, `partial`, `unverifiable:<aks|iaas|paas>`). Observation artifact `observation-<stack>`.

- [ ] **Step 1: Write YAML contract tests** for triggers/inputs, permissions, simulation order, observation `always`, artifact upload always/warn, direct-only write job, protected environment/token action, writer outputs and no concurrency.
- [ ] **Step 2: Run and observe missing workflows.**
- [ ] **Step 3: Implement both full YAML workflows.** Simulated environment job: checkout, Node 22, `npm ci --ignore-scripts`, log start legs PAAS→IAAS→AKS or shutter AKS→IAAS→PAAS; action-failed marks first simulated leg failed while subsequent observation still runs. Always call observation script with pipeline 402/404, expected started/stopped, simulate, run id `github.run_id`, requested true; always upload artifact with `if-no-files-found: warn`. Direct-only `state-write` job downloads artifact, is `if: always()` after environment, uses environment `state-writer`, checkout with `persist-credentials:false`, Node/npm setup, token composite, writer with requested `stack:expected`, expected run id, repo/branch/token/retry/results paths. Expose all spec writer outputs and gate alert/reconciliation by the respective output. `none` and `orchestrated` do not write. No secrets in observation job. Keep definitions identical except pipeline id, expected state and leg order.
- [ ] **Step 4: Run workflow tests; expected PASS. Commit** `feat: add reusable environment action workflows` plus trailer.

### Task 11: Reconciliation and 416 Scheduler

**Files:** Create `.github/workflows/state-reconciliation.yaml`, `.github/workflows/custom-auto-startup-shutdown.yaml`; extend `tests/state/workflow-contracts.test.js`.

**Interfaces:** Reconciler has `workflow_call` + dispatch inputs `stack`, `expectedState`, `triggeringRunId`; 416 is dispatch-only with `force`, `environments`, `stacks`, `simulate`, `now`.

- [ ] **Step 1: Add failing workflow assertions** three explicit attempts, cleanup and success gates, no self-trigger; 416 matrix outputs, one write, run-id contract, resolver, max-parallel one, no `schedule` and no concurrency.
- [ ] **Step 2: Run workflow tests to confirm missing workflows fail.**
- [ ] **Step 3: Implement reconciler workflow.** One state-writer job and scoped token; unroll `attempt1..3`, all `continue-on-error:true`; each cleans observation dir, invokes observation with `--simulate success --requested true`, then writer with `MAX_RETRIES=1`. Attempt 2/3 only if prior attempts did not set succeeded. If none succeed, alert and fail job. Never invoke another reconciler.
- [ ] **Step 4: Implement 416 workflow.** Plan job runs Node 22/npm ci and schedule planner. Start/stop reusable jobs use `fromJSON` outputs, `fail-fast:false`, child `stateWriteMode: orchestrated`; no child writes. One state-write job runs after plan/children under state-writer only if plan hasWork, downloads all artifacts by `pattern: observation-*` without merge, sets expected IDs to `${{ github.run_id }}`, and performs one write. Export writer outputs. Resolve targets only when reconciliationRequired; reconciliation reusable matrix uses `max-parallel: 1`, fail-fast false. Alert only on alertRequired. Include comment for intended 06:00/19:00/21:00 Europe/London cron, no schedule trigger. No concurrency group.
- [ ] **Step 5: Run tests; expected PASS. Commit** `feat: add scheduler and reconciliation workflows` plus trailer.

### Task 12: State-Writer CI, Documentation, and Full Regression

**Files:** Create `.github/workflows/state-writer-tests.yaml`; modify `README.md`, `.github/copilot-instructions.md`; finish workflow contract test.

- [ ] **Step 1: Add failing CI contract checks** for push-to-main, PR and dispatch; path filters for `scripts/state/**`, `tests/state/**`, four workflows, `.github/actions/**`, `schemas/**`, package files; contents read; checkout credentials false, Node 22, npm ci ignore scripts, Bash syntax and `npm run test:state`; no environment/token/privileged operation.
- [ ] **Step 2: Run contract test and confirm CI workflow absence fails.**
- [ ] **Step 3: Add CI workflow** with the asserted contract and state-only suite.
- [ ] **Step 4: Document** README heading `State writer (GitHub Actions)`: all four workflows, simulate modes, no Azure, administrator-created `state-writer` environment with deployment branch main only, same three probe secret names, repository-scoped write permission, intended London cron disabled, outcome mapping (succeeded done; partial/rejected/stale-base reconcile; git-failed/script-failure alert), no force push/no concurrency. Explicitly distinguish offline tests from live write permission proof and state probe workflow unchanged. Copilot instructions add `npm run test:state`, single-file invocation, script/workflow contracts, local bare repo isolation and no edits to checked-in config/state in tests. Do not imply `sit`/`nft` support.
- [ ] **Step 5: Run `node --test tests/state/workflow-contracts.test.js`, then `npm test`; expected all state, dashboard, data, and auth suites pass.**
- [ ] **Step 6: Commit** `docs: document GitHub state writer workflows` and trailer.

## Final Self-Review

- **Coverage:** Every spec section is assigned: observation/schema, data sources and plan outputs, both reusable child workflows, single orchestrated write, token protection, validation/merge/push/outcomes, alerts, reconciliation attempts, offline suite, CI, README and Copilot instructions. Existing probe and dashboard stay untouched. Schema widening and real Azure are out of scope.
- **Consistency:** Script env/CLI names and writer output keys are aligned; observation validation wraps `{environment,stacks}`; resolver matrix is GitHub `{include:[{stack,expectedState}]}`; 416 child run ids equal `github.run_id`.
- **Portability:** All planned shell behavior avoids GNU-specific date/base64/sed/shuf; `$RANDOM` is Bash-native. Implementers must avoid empty-array nounset hazards and quote all paths.
- **Risks / spec gaps:** Live App ability to push directly to `main` under actual rulesets remains explicitly unconfirmed; admin must prove this before live writes. The composite action must preserve the probe's base64 RSA PEM secret contract exactly. Live bank holiday fetch intentionally warns/falls back to no holidays; tests use injected file. No other blocking gap found.
