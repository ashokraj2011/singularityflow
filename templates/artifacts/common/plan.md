# {{work.id}} — Plan

<!-- sflow:guidance The starter of a plan step: the exact changes and the tests that will prove each requirement. A person approves it before any code changes. -->

## Planned implementation evidence

<!-- sflow:guidance Add exactly one row for every approved clause, with its fully qualified ID. List only exact repository-relative source and test paths in backticks; no directories, globs, module names, or prose in path cells. For a clause that truly cannot be tested, write `not-applicable:` and the reviewed reason under `Planned tests`. -->

<!-- sflow:guidance For new or modified delivery, `Expected paths` holds product source only and `Planned tests` holds test files only. A test-only obligation uses fulfillment `test-only`, `Expected paths` = `-`, and its exact tests under `Planned tests`. -->

| Clause | Expected paths | Planned tests | Fulfillment | Observable result |
|---|---|---|---|---|
| `{{work.id}}:REQ-001` | TODO: replace with exact backticked repository-relative source paths | TODO: replace with exact backticked repository-relative test paths | new | TODO: what a person can observe when it works |

<!-- sflow:guidance Fulfillment: new, modified, existing (behaviour already at the listed paths), removed, test-only, document, configuration, or evidence (retained files under this Story's evidence/ directory). Observable result states what is observed. -->

## Changes

TODO: List each change, file by file, without writing the code.

## Tests

TODO: Explain the tests in the table above, each bound to the clause ID it proves.

## Risks and rollback

TODO: Record what could go wrong and how the change is rolled back.
