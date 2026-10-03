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
version: 9
---
The evidence matrix shows every requirement and acceptance criterion of a Story as one row: whether the approved plan names it, whether a delivered change implements it, which tagged test verifies it and what that test's run proved. It reads committed records only, so it runs no test and makes no network call.

## Purpose and prerequisites

Use the matrix to see what a Story's evidence actually proves before you approve, submit or finish it. It needs a Story whose specification defines clauses such as `[WORK-ID:AC-001]`; a Story with no indexed requirement or criterion has nothing to show, and it is never shown as complete.

## Use it from each surface

- **Shell:** `singularity-flow evidence matrix [WORK-ID]` prints one page of rows. `--row AC-001` shows one row, `--result pending` or `--facet execution=failed` filters, `--page` and `--page-size` move through large specifications, and `--format json` or `--format csv` export the same rows. `singularity-flow pr describe` carries the same summary in the pull request's Evidence section. `singularity-flow evidence scope [WORK-ID]` lists the accepted-scope inventory, `singularity-flow decision scope --item <ID> --as <disposition> --reason TEXT` records a disposition, and `singularity-flow decision completeness --confirm <inventory> --article <id>=<decision>... --reason TEXT` records a completeness review.
- **Copilot:** `/sf-evidence` relays the matrix: the completion label and its reasons, the results, the assurance floor and each row's obligations. It changes nothing. `/sf-decide` records scope dispositions and the completeness review with the person's own answers.
- **VS Code:** **Singularity Flow: Evidence Matrix** (also under the active Story in the sidebar) shows the same rows as a table; selecting a row opens its obligations, what needs attention and its next commands.

## Guided workflow

Each row carries up to four obligations, identified by `OBL:<WORK-ID>:<responsibility>:<clause>` so a renamed step never changes them:

- **plan:** the approved plan lists the clause with its expected paths and planned tests.
- **implement:** the code step's delivery changed the planned paths (or, for a test-only criterion, delivered its planned tests).
- **verify** (acceptance criteria only): a delivered test file is tagged `@ac:<clause>`, and the test command that covered it passed. Requirements are verified through the criteria that depend on them.
- **review:** the step that delivered the change was approved under its approval rule; a self-approval is shown as such.

Every obligation reports six facets separately: coverage, execution, assurance, review, freshness and exception. The row's result is the most serious state of its obligations: failed, inconclusive, missing, pending, satisfied with an exception, or satisfied.

### Planning each obligation

The plan's planned-evidence table has one row per clause: its exact expected paths and planned tests, how it is fulfilled and what a person can observe when it is met.

- **Fulfillment:** `new` or `modified` product source; `existing` behaviour that already lives at the listed paths; `removed` behaviour at the listed paths; `test-only`, when the tests are the whole delivery and Expected paths is `-`; or an exact `document` or `configuration` change. A row that names none means new or modified source.
- **Observable result:** what a person can see when the row is met, in at most 500 characters.
- **Steps:** when a plan feeds several code steps, the step or steps that deliver the row. A step the plan does not plan for is refused when the plan is published; a row without Steps is delivered by every code step it plans for.

A code step is judged by the rows allocated to it. Only new or modified rows need product source that carries a `@clause` comment; existing rows need their paths to still be there, with their planned tests run unchanged; removed rows need their paths to be gone, and a removed file is approved by its absence; test-only rows need their tests; document and configuration rows need exactly their paths to change. Each is recorded in the code-delivery receipt and checked again against the committed generation.

### Implementation bindings

Each row delivered by new or modified source is bound to what the delivery changed for it: the exact changed hunks of its planned paths, the public declarations those hunks touch (best effort, labelled heuristic, never proof) and its author's explanation, written after the clause's tag on the same comment line, for example `// @clause:ORDER:REQ-001 rejects an expired card`. The explanation must be 10 to 300 characters, and publishing refuses a row without one. The tag associates the row with the code; the explanation says how the change meets it; a person decides.

Approving the step accepts every binding it submitted, as a batch over their exact digest. To accept one with a stated exception, approve with `--binding <clause>=exception --binding-reason TEXT`; that row then reads satisfied with an exception. To send a binding back for correction, reject the step. The matrix shows each row's explanation, regions and decision.

### Accepted scope

Every requirement statement found in the Story's sources must reach a disposition. The sources are the Story's pinned source (each acceptance criterion, requirement and constraint, and any sentence with must, must not, shall, shall not or is required to), its active documents (list items and table rows under requirements, acceptance criteria or constraints headings, Given/When/Then scenarios, and strong-modal sentences) and its answered clarifications. "Should" and "may" are not requirements here.

- **included:** a clause states it (its text equals or contains the statement), or a person linked the clauses; the clause's row carries its evidence.
- **existing:** behaviour that already exists, linked to the clauses that verify it.
- **excluded** or **deferred:** a scope decision with a reason, shown as not applicable and never as an exception.
- **informative**, **duplicate** or **superseded:** not a requirement of this Story. A statement repeated verbatim in another source is a duplicate automatically.
- **unresolved:** nobody has said yet. It appears as a pending SCOPE row and blocks completion.

A document the inventory cannot read (an HTTPS link, a file kept on one machine, a PDF without a text layer) is listed as unreadable and stays unresolved until someone records a decision for it. A decision binds the statement's text: if the statement changes, it is a new item. Someone in the group that approves the step defining the Story's scope records each decision; when the workflow leaves scope out and that group decided scope does not apply, the decision covers every undisposed statement and the inventory says so.

### Scope revisions

Each time the Story's accepted clauses change, the Story records a scope revision: the clauses with their statement hashes, what was added, revised or removed, and the generation every later step had reached. Revisions are chained by hash and never rewritten, so the history of the scope stays intact. Approving a step that defines clauses with different clauses records one, and so does an approved intent amendment.

Evidence becomes stale through its dependencies, never wholesale. A plan, implementation, test result or review of a clause is stale only when a revision added or revised that clause, or a clause it depends on, after the step that produced the evidence had reached its generation. A stale obligation is pending, with freshness `stale`, until that step runs again; every other clause keeps its evidence. The matrix header and the pull request summary say how many rows the latest revision made stale and how many it left unaffected. A claim for a removed clause is kept as history rather than read as a broken record.

### Completeness review

Three states are kept apart and shown separately:

- **Structurally complete:** every identified statement has a disposition. Completeness is claimed only relative to the statements the inventory identified.
- **Completeness reviewed:** once the inventory is structurally complete, someone in the same group reviews its interpretation and answers every article of the requirements-quality checklist: completeness, ambiguity, consistency, verifiability, boundary conditions and non-functional requirements. Each answer is satisfied, an exception or not applicable, and anything but satisfied needs a reason. The review names the exact inventory digest it read (`--confirm`), so a later change to any statement or disposition makes it no longer current.
- **Correctness:** never claimed. A review says a person assessed the interpretation, not that the scope is right.

The matrix header, the pull request summary and `evidence scope` show both states. A reviewer agent may propose findings and mappings; only a person records the review.

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
- **`SCOPE_ITEMS_UNRESOLVED`:** a requirement statement in the Story's sources has no disposition; run `singularity-flow evidence scope` and record each with `decision scope`.
- **`EVIDENCE_STALE_AFTER_SCOPE_REVISION`:** a scope revision changed this clause after its evidence was produced; run the step that owns the stale obligation again.
- **`SCOPE_INVENTORY_INCOMPLETE`:** the completeness review waits until every statement has a disposition.
- **`SCOPE_INVENTORY_CHANGED`:** the inventory changed after you read it; run `singularity-flow evidence scope` again, review it, and confirm the digest it shows now.
- **`SCOPE_CHECKLIST_INCOMPLETE`:** answer each checklist article exactly once with `--article <id>=<decision>`, with `--article-reason` for any exception or not applicable.

## Related topics

Continue with `sflow explain approvals`, `sflow explain story-lifecycle`, or `sflow explain workflow-decisions`.
