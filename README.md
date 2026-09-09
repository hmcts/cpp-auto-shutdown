# cpp-auto-shutdown

GitHub-driven startup/shutdown for CRIME non-production environments, replacing the
Confluence-driven process.

## Environment Board (dashboard)

A static dashboard for Delivery Managers showing which stacks are up, when they shut
down, and whether an exception request will actually take effect.

- **Design spec:** [docs/DESIGN.md](docs/DESIGN.md) — build against this
- **Page:** [docs/index.html](docs/index.html) — currently renders bundled sample data
- **Sample data:** [config/stacks.yaml](config/stacks.yaml) and
  [state/environments/](state/environments/)

The page is a design reference, not live. Set `USE_LIVE = true` in `docs/index.html`
to fetch real observed state; the fetch, polling and failure handling are already
written. Enable Pages under **Settings → Pages → Source: GitHub Actions** to publish it.

### Data model in one line

`config/stacks.yaml` is declared intent (schedule, ownership, exceptions).
`state/environments/*.json` is what live verification observed. They are kept separate
so configuration can never be mistaken for observation.

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
