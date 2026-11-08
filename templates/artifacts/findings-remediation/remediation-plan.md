# {{work.id}} — Remediation plan

## Fix per item

One row for each item in the intake. For a dependency or a runtime, name the upgrade: patch, minor
or major. A patch or minor upgrade, and a critical or high code finding with a known fix, are made
by the code step.

| Clause | Item | Fix | Upgrade | Proof |
|---|---|---|---|---|
| `{{work.id}}:AC-001` | TODO: SEC-1001 | TODO: the code change, or the version to move to | TODO: patch, minor, major or none | TODO: the tool rerun, or the file and version that show it |

## Major upgrades for a person

A major upgrade is never made by itself. List each one with what it changes and why it is needed; a
person approves it in this step's review before the code step makes it. Write "None." when there is none.

- TODO: `<component>` `<from>` → `<to>`: what changes, and what it needs.

## Planned implementation evidence

Add exactly one row for every clause. List only exact repository-relative source and test paths in
backticks; do not use directories, globs, module names, or prose in path cells.

| Clause | Expected paths | Planned tests | Fulfillment | Observable result |
|---|---|---|---|---|
| `{{work.id}}:AC-001` | TODO: exact backticked repository-relative source, manifest or lockfile paths | TODO: exact backticked repository-relative test paths, or not-applicable: why | modified | TODO: what a person can observe when it works |

<!-- Fulfillment: new, modified, existing, removed, test-only, document, configuration, or evidence. A dependency or runtime upgrade is usually configuration. -->

## Verification

All existing tests run (this workflow runs them all), and the build passes. Name any test this plan adds.

## Risk and rollback

TODO: State the main risk of each fix and how it is rolled back.
