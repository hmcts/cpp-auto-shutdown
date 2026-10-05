# cpp-auto-shutdown

GitHub-driven startup/shutdown for CRIME non-production environments, replacing the
Confluence-driven process.

## Environment Board (dashboard)

A static dashboard for Delivery Managers showing which stacks are up, when they shut
down, and whether an exception request will actually take effect.

- **Design spec:** [docs/DESIGN.md](docs/DESIGN.md)
- **Page:** [docs/index.html](docs/index.html) + [docs/js/](docs/js/)
- **Sample data:** [config/stacks.yaml](config/stacks.yaml),
  [config/exceptions.yaml](config/exceptions.yaml), and
  [state/environments/](state/environments/)

The page reads the configuration and state files live from `raw.githubusercontent.com`.
Because this repo is public, a state change needs **no Pages rebuild** — only changes to the
page itself do.
It polls every 60 seconds and on tab focus; if a fetch fails it keeps the last good
render and says so rather than showing stale data as current.

### Running it

```shell
npm run serve     # http://localhost:8000
npm ci --ignore-scripts  # install test-only dependencies without lifecycle scripts
npm test          # all offline suites, never the live write probe
npm run test:dashboard  # dashboard unit tests only (tests/dashboard/, no dependencies needed)
npm run test:data       # schema/data validation only (tests/data-validation/)
npm run test:auth       # offline probe safety tests only (tests/authentication/)
```

`npm install --ignore-scripts` may be used instead. The static dashboard itself does not require
these packages to be served.

Add `?ref=BRANCH-NAME` to read data from a branch that has not been merged yet, e.g.
`http://localhost:8000/?ref=DTSPO-34135`.

To publish: **Settings → Pages → Source: GitHub Actions**. The deploy workflow runs on
pushes to `main` that touch `docs/**`.

### Data model in one line

`config/stacks.yaml` is stack intent, `config/exceptions.yaml` is workflow-owned dated
requests, and `state/environments/*.json` is what live verification observed. They are kept
separate so configuration can never be mistaken for observation.
All stacks use the shared baseline defined in [docs/js/schedule.js](docs/js/schedule.js),
not schedule fields in the stack configuration.

### Authentication checks and manual write proof

Authentication CI runs only `npm run test:auth`. It uses dummy credentials and stubbed
Git commands and isolated local bare repositories, never a real installation token
or a remote push. Dashboard and data
validation CI each run their own suite with explicit test-directory path filters.
Dashboard and authentication CI run automatically on relevant PR changes and relevant
pushes to `main`, not feature-branch pushes. Package manifest changes can intentionally
trigger multiple suites. Authentication CI watches its tests, probe script, its own
workflow, the manual probe workflow, the Pages workflow and `package.json`. It does not
run for changes only to dashboard/data-validation workflows or `package-lock.json`.
The Pages workflow remains watched because its trigger contract is checked by the
authentication suite. The suites have distinct job check names. These path-filtered checks must not be made universally
required without an always-reporting gate, otherwise unrelated PRs can stay pending.

The `Manual GitHub App write probe` workflow is separate and uses `workflow_dispatch`
only. It must be merged to the default branch before GitHub allows manual dispatch.
It runs only from `main` in `hmcts/cpp-auto-shutdown`, after the operator explicitly
acknowledges a root-level marker commit. It does not start or stop environments or
modify configuration, observed state, or dashboard files.

Before any live run, an authorized administrator must:

1. Verify that the existing `cpp-github-management` App installation covers this
    repository with `contents: write`, and that its direct-write bypass works under
    all effective branch protection and organization/repository rulesets. Keep force
    pushes disabled and existing protections intact.
2. Configure the `github-app-write-probe` environment with a deployment branch policy
    allowing only the `main` branch, required reviewers and prevention of self-review.
    Referencing an environment in YAML alone does not configure these protections.
3. Provision the following **new workflow configuration contract**, using the approved
    credential source for that same App. These names do not imply existing secrets:

    | Environment setting | Value |
    | --- | --- |
    | Variable `CPP_GITHUB_MANAGEMENT_APP_ID` | Verified numeric App ID |
    | Variable `CPP_GITHUB_MANAGEMENT_INSTALLATION_ID` | Verified numeric installation ID |
    | Secret `CPP_GITHUB_MANAGEMENT_PRIVATE_KEY` | Approved PEM private key |

    Keep the key exclusively in this protected environment. Do not place it in a
    repository or organization secret accessible to arbitrary branch workflows.
    The key can mint other tokens for the App, so repository scoping in this workflow
    does not replace protection of the key itself.

    The ADO `cpp-ghauth` key is base64 encoded. The token action expects PEM, so any
    conversion/provisioning must be performed securely by the administrator, not
    through committed files, logs or chat. Do not use a PAT, another App, or the
    default `GITHUB_TOKEN` as a substitute.

After reviewed merge and prerequisite verification, an authorized operator can
dispatch the workflow from `main`, select the acknowledgement and obtain environment
approval. It creates a short-lived repository-scoped token, verifies the App slug
and installation ID, then writes `app-write-probe-<run-id>-<attempt>.txt` through an
ordinary non-force push. It then fetches `main` and verifies that the fetched history
contains the probe commit. A subsequent legitimate fast-forward is accepted.
The run prints the marker, probe commit SHA and observed main SHA without credentials.
Capture the run link, App identity and both SHAs as evidence. A stale-base push
rejection, failed fetch or history that excludes the probe commit is a failure, not
permission to force-push or weaken rules. Tokens are revoked at job completion by
the token action.

Retain the workflow as manual-only after proof. Remove markers only through a
normal reviewed PR if cleanup is needed. Root markers do not match the Pages
workflow's `docs/**` trigger. Offline test success is not proof of live permissions.
Marker proof covers only the root-marker write under its applicable rules. It does
not establish authorization to write protected configuration or observed-state paths.

This workflow proves GitHub App write access, not ADO credential retrieval or
execution of the ADO token template.

### Structure

```
docs/index.html      markup
docs/styles.css      design system, light and dark
docs/js/schedule.js  when a stack should run   (pure, unit tested)
docs/js/model.js     config/state join, drift  (pure, unit tested)
docs/js/data.js      fetching and normalising
docs/js/render.js    DOM output (everything escaped — see dom.js)
docs/js/main.js      wiring
tests/dashboard/      dashboard unit tests (node --test)
tests/data-validation/  schema and data validation tests
tests/authentication/   offline authentication and probe safety tests
scripts/app-write-probe.sh  manual workflow's marker-only Git push
```

No framework and no bundler: ES modules are served as-is.

## Contributing

The probe requires Bash, Git and standard system utilities. The offline tests require
Node.js 22, npm and Git. GitHub-hosted Ubuntu runners provide these tools. Neither
the scripts nor tests require Homebrew, actionlint, ShellCheck or pre-commit.

If you already use pre-commit, optional repository hooks can be run with:
```shell
pre-commit run --all-files --show-diff-on-failure
```
