# Configuration split and schema validation

## Purpose

Separate human-maintained stack definitions from approval-workflow-maintained
exceptions, and make the configuration and observed-state contracts explicit and
machine-validatable.

## Configuration ownership and loading

`config/stacks.yaml` remains the source for `defaults`, `exception_windows`, and
`stacks`. Its `exceptions` list moves without semantic changes to a new
`config/exceptions.yaml`, under an `exceptions` key. Dates in the new YAML file
are quoted strings. Stack definitions remain PR-reviewed; exceptions are written
by the approval workflow and pruned after expiry.

The browser continues to use YAML and to fetch public raw files directly.
`docs/js/data.js` loads both configuration files concurrently, normalizes them,
and returns the existing `{ stacks, exceptions }` interface. Schedule and
rendering consumers do not change.

## Schema contracts

Three JSON Schema 2020-12 documents live under `schemas/`:

- `stacks.schema.json` validates `config/stacks.yaml`.
- `exceptions.schema.json` validates `config/exceptions.yaml`.
- `environment-state.schema.json` validates each `state/environments/*.json`.

Schemas require the fields used by the application and specify their types.
Enums constrain environments to `dev` and `ste`, stack components to `AKS`,
`IaaS`, and `PaaS`, aggregate/component statuses to their supported values, and
exception windows to `06:00-19:00`, `06:00-21:00`, `06:00-23:00`, or `24h`.
Stack configuration keeps the available exception-window list; the exception
schema repeats the allowed values as its enum.

Each state record requires `stackComponents` and all three keys under
`components` (`aks`, `iaas`, `paas`). A component included in
`stackComponents` must have an object value with the required verification
fields; a component not included must have a literal `null`. Component objects
may carry additional key-value metadata.

The schemas describe data contracts; the dashboard does not fetch or run a
validator in the browser.

## Validation in CI

Add test-only dependencies for Ajv 2020, `ajv-formats`, and a YAML parser.
Schema tests parse both YAML files and each environment JSON file, then assert
that all samples validate. Because `npm test` already discovers
`tests/*.test.js`, the schema checks run with the existing test command.
Update the dashboard workflow path filters so edits to `config/**`, `state/**`,
and `schemas/**` run the tests. These dependencies are not used by the static
dashboard at runtime.

## Documentation

Update `docs/DESIGN.md` to describe both configuration files, the three schema
contracts, required fields/enums, and state component nullability. Update the
README sample-data and data-model descriptions and the repository Copilot
instructions to reflect the split and validation.

## Verification

Run `npm test`; ensure at least one test verifies that all checked-in config and
state examples validate against their schemas. Review the schema tests and
workflow filters to ensure a schema or source-data edit triggers validation.
