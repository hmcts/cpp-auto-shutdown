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
npm ci            # install test-only schema validation dependencies
npm test          # all tests
npm run test:dashboard  # dashboard unit tests only (no dependencies needed)
npm run test:data       # schema/data validation only (tests/data-validation/)
```

`npm install` may be used instead of `npm ci`. The static dashboard itself does not require
these packages to be served.

Add `?ref=BRANCH-NAME` to read data from a branch that has not been merged yet, e.g.
`http://localhost:8000/?ref=DTSPO-34135`.

To publish: **Settings → Pages → Source: GitHub Actions**. The deploy workflow runs on
pushes to `main` that touch `docs/**`.

### Data model in one line

`config/stacks.yaml` is stack intent, `config/exceptions.yaml` is workflow-owned dated
requests, and `state/environments/*.json` is what live verification observed. They are kept
separate so configuration can never be mistaken for observation.

### Structure

```
docs/index.html      markup
docs/styles.css      design system, light and dark
docs/js/schedule.js  when a stack should run   (pure, unit tested)
docs/js/model.js     config/state join, drift  (pure, unit tested)
docs/js/data.js      fetching and normalising
docs/js/render.js    DOM output (everything escaped — see dom.js)
docs/js/main.js      wiring
tests/               dashboard unit tests (node --test)
tests/data-validation/  schema and data validation tests
```

No framework and no bundler: ES modules are served as-is.

## Contributing

We use pre-commit hooks for validating the terraform format and maintaining the documentation automatically.
Install it with:

```shell
$ brew install pre-commit
$ pre-commit install
```

If you add a new hook make sure to run it against all files:
```shell
$ pre-commit run --all-files --show-diff-on-failure
```
