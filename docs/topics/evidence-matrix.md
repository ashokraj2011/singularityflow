---
id: evidence-matrix
title: Evidence matrix for requirements and acceptance criteria
aliases:
  - requirement-evidence
  - criterion-status
  - evidence-view
questions:
  - Which acceptance criteria are actually verified?
  - What evidence backs each requirement of this Story?
  - Why is my Story not shown as complete?
keywords:
  - module-observed
  - assurance
  - per-criterion verification
commands:
  - evidence
related:
  - approvals
  - story-lifecycle
  - workflow-decisions
version: 2
---
The evidence matrix shows every requirement and acceptance criterion of a Story as one row: whether the approved plan names it, whether a delivered change implements it, which tagged test verifies it and what that test's run proved. It reads committed records only, so it runs no test and makes no network call.

## Purpose and prerequisites

Use the matrix to see what a Story's evidence actually proves before you approve, submit or finish it. It needs a Story whose specification defines clauses such as `[WORK-ID:AC-001]`; a Story with no indexed requirement or criterion has nothing to show, and it is never shown as complete.

## Use it from each surface

- **Shell:** `singularity-flow evidence matrix [WORK-ID]` prints one page of rows. `--row AC-001` shows one row, `--result pending` or `--facet execution=failed` filters, `--page` and `--page-size` move through large specifications, and `--format json` or `--format csv` export the same rows.
- **Copilot:** run the same shell command from the Story's checkout with `--format json`; no Copilot skill relays the matrix yet.
- **VS Code:** run the shell command in the Story's terminal; a table view arrives in a later release, reading the same JSON.

## Guided workflow

Each row carries up to four obligations, identified by `OBL:<WORK-ID>:<responsibility>:<clause>` so a renamed step never changes them:

- **plan:** the approved plan lists the clause with its expected paths and planned tests.
- **implement:** the code step's delivery changed the planned paths (or, for a test-only criterion, delivered its planned tests).
- **verify** (acceptance criteria only): a delivered test file is tagged `@ac:<clause>`, and the test command that covered it passed. Requirements are verified through the criteria that depend on them.
- **review:** the step that delivered the change was approved under its approval rule; a self-approval is shown as such.

Every obligation reports six facets separately: coverage, execution, assurance, review, freshness and exception. The row's result is the most serious state of its obligations: failed, inconclusive, missing, pending, satisfied with an exception, or satisfied.

## State and safety

Assurance is stated at its real strength. A passing test command over a criterion's tagged test is `module-observed`: no individual test-case result is joined to a criterion yet. A command that passed with skipped tests makes the criterion inconclusive, because which test was skipped is not known. A failed command fails the criterion unless a governed risk decision accepted it, and the failed observation stays visible beside the exception.

The completion line never derives "complete" from where the Story stands. An in-progress or cancelled Story reads "Incomplete — verification pending or insufficient". A Story closes only when the final evaluation passes inside the transition that ends it; that evaluation is recorded on the Story, and while it still matches the evidence the line reads "Complete" or "Complete with accepted exceptions". A closed Story whose evidence changed afterwards reads "Incomplete — final verification not evaluated".

When a gate refuses, the CLI, VS Code and Copilot receive one refusal record (gate-refusal v1): the open obligations, the reasons, the step responsible, what recovers it, whether a risk may be accepted, and what it left untouched; nothing was recorded. Retrying the same command on the same state returns `REFUSAL_UNCHANGED` at once without running the checks again.

## Troubleshooting

- **A row is pending:** the step that owes that obligation has not delivered yet.
- **A row is missing:** a finished step did not deliver it, for example no submitted test is tagged for the criterion.
- **Every row is inconclusive:** a claim map or index no longer matches its binding in the Story; the matrix lists the record it could not trust.
- **A row is inconclusive with skipped tests:** remove the skip or make the criterion's test run, then submit again.
- **`REFUSAL_UNCHANGED`:** nothing the refusal depended on has changed since the last attempt; follow its recovery actions, then retry.

## Related topics

Continue with `sflow explain approvals`, `sflow explain story-lifecycle`, or `sflow explain workflow-decisions`.
