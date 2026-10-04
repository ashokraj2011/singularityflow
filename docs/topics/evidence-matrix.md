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
  - exact-local-observed
  - assurance
  - per-criterion verification
  - verification contract
  - witness adequacy
commands:
  - evidence
related:
  - approvals
  - story-lifecycle
  - workflow-decisions
  - rejection-and-rework
version: 20
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
- **verify** (acceptance criteria only): the test an `@ac:<clause>` comment sits directly above passed in the run of the published candidate. Where the module's runner reports only counts, the test command covering the tagged file passed instead. Requirements are verified through the criteria that depend on them.
- **review:** the step that delivered the change was approved under its approval rule; a self-approval is shown as such.

Every obligation reports six facets separately: coverage, execution, assurance, review, freshness and exception. The row's result is the most serious state of its obligations: failed, inconclusive, missing, pending, satisfied with an exception, or satisfied.

### Planning each obligation

The plan's planned-evidence table has one row per clause: its exact expected paths and planned tests, how it is fulfilled and what a person can observe when it is met.

- **Fulfillment:** `new` or `modified` product source; `existing` behaviour that already lives at the listed paths; `removed` behaviour at the listed paths; `test-only`, when the tests are the whole delivery and Expected paths is `-`; or an exact `document` or `configuration` change. A row that names none means new or modified source.
- **Observable result:** what a person can see when the row is met, in at most 500 characters.
- **Steps:** when a plan feeds several code steps, the step or steps that deliver the row. A step the plan does not plan for is refused when the plan is published; a row without Steps is delivered by every code step it plans for.

A code step is judged by the rows allocated to it. Only new or modified rows need product source that carries a `@clause` comment; existing rows need their paths to still be there, with their planned tests run unchanged; removed rows need their paths to be gone, and a removed file is approved by its absence; test-only rows need their tests; document and configuration rows need exactly their paths to change. Each is recorded in the code-delivery receipt and checked again against the committed generation.

### Exact tests and attempts

A criterion is tied to a test by an `@ac:<clause>` comment on the line directly above the test's declaration. A tag anywhere else in the file binds nothing, and publishing refuses a criterion the step owes whose tags sit on no test. For Jest and Vitest (JSON reporters) and JUnit 5 (Maven Surefire or Gradle reports) the tagged test is read exactly: its file, its literal `describe` path or class, its title or method, and a digest of its whole body, so weakening its assertion is a new revision. A table-driven test (`.each`, `@ParameterizedTest`, `@RepeatedTest`) passes only when every instance it declares passed. Other runners only count tests, so their criteria rest on the module's test command.

Every run of a test command is kept as an immutable attempt with its raw report, failed runs and retries included, and the criterion is judged against the attempt bound to the published candidate. An exact test reads, in this order: failed; no result (the run failed or ended without one); flaky (it passed only after failing in the same run); ambiguous (more than one result carries its identity); not exact (its declaration cannot be pinned down, for example a dynamic title or a duplicate); skipped; not in the run (filtered out, or in a file the runner did not run); passed. Only passed verifies, and only inside a run that completed and succeeded; an unrelated passing test in the same file never stands in for it.

Assurance has two facets on each verify obligation: identity (`declared` for a tagged file, `source-bound` for one exact test) and execution (`none`, `module-observed` or `exact-local-observed`). Each criterion requires the strongest assurance its runner can reach, and never less than `module-observed`; a pass below that is an assurance shortfall, resolved by repairing the test configuration, tagging another test, or accepting the risk with the `assurance-shortfall` category. Exact-local-observed is a local observation of the candidate's own tests; nothing promotes it to authenticated.

### Verification contracts

A plan may say exactly how each acceptance criterion is verified, in its own `## Verification contracts` table beside the planned-evidence table. Each row is one witness slot: `| Criterion | Slot | Method | Witness |`, with optional `Role` (primary or supporting), `Required assurance`, `Combination` (all or any) and `Reason` columns. The method is `test` (an executable test file, which must be one of the criterion's planned tests), `inspection` (a reviewer inspects an exact file) or `visual` (visual evidence of a named screen). Publishing the plan refuses a contract that could never verify honestly: an unknown criterion, an unsupported method such as a measurement, a slot named twice, a criterion with only supporting witnesses, `any` without a reason, a test that is not planned, or a required assurance the method cannot reach (nothing reaches exact-authenticated here).

Every primary slot must be met (`all`), or, when the plan gives a reason, one of them (`any`). A supporting slot is shown but never satisfies a criterion. A criterion with no row keeps one test slot over its planned tests. Only a criterion with a primary test slot needs an `@ac` tag: one verified by inspection or visual evidence, or whose tests the plan reviewed as not applicable, needs none.

### Inspection and visual witnesses

An inspection or visual slot is witnessed by a person in the group that approves the criterion's delivery: `singularity-flow decision witness --criterion <AC> --slot <slot> --file <path> --confirm states-the-outcome --confirm matches-the-criterion --confirm current-for-this-change --reason TEXT`. For an inspection the file is the one the contract names; for a visual slot it is the captured image of the screen the contract names. Every checklist item is answered with `--confirm` or `--deny`; one denial records that the file does not satisfy the criterion. The record binds the file's exact bytes, the reviewer and their authority, and does not depend on any step's name. It witnesses the slot only while the file keeps those bytes: a changed file must be inspected again.

### Witness adequacy review

A passing test proves only what it asserts, so the reviewer decides whether each exact test adequately verifies its criterion: its setup and inputs, its action, its assertions, its negative and boundary cases, and its relationship to the implementation. The submission lists every exact test with the criterion's text, and approving the step accepts all of them as adequate, as one batch over their exact digests. To record a shortfall, approve with `--witness-mapping <sha256>=exception:<facet>[,<facet>] --witness-mapping-reason TEXT --witness-mapping-expires YYYY-MM-DD`; the criterion then reads satisfied with an exception until the expiry, after which the test stops counting. To rule a test out, use `<sha256>=not-applicable` with a reason; it then verifies nothing. A decision carries forward to a later generation only while the test, its support code, the criterion's text and the contract are all unchanged.

### Accepting a risk

When an obligation failed, is missing or is inconclusive and the Story must close anyway, someone in the group that approves the step owning it records `singularity-flow decision risk --obligation <OBL-ID> --category <category> --expires YYYY-MM-DD --reason TEXT`. The category is one of external-dependency, known-failure, assurance-shortfall, deferred-verification or accepted-deviation, and the expiry is at most 90 days ahead. The obligation then reads excepted, and what was observed stays visible: a failed test still reads failed.

A decision covers only what it accepted. It counts for nothing once it expires, is revoked with `decision risk --revoke <RISK-ID> --reason TEXT`, does not permit the transition at hand, or the evidence it accepted changes, including a rerun of the criterion's test, which is a new attempt; the matrix then says to renew it. Closing a Story re-evaluates decisions at that moment, so one that expired after approval blocks completion. Some failures are never accepted: stale evidence is run again, records that do not verify are repaired, a review is given by approving the step, and the scope has its own decisions.

### Plan amendments

A delivered change to a path no row names is accounted for, never deleted to satisfy the gate and never silently exempted. Someone in the group that approves the plan records `singularity-flow decision plan --add-location <clause>=<path> --reason TEXT`, which accounts for the path as part of that row's delivery, or `--add-supporting <path>=<class> --supporting-reason TEXT` for a lockfile, build, CI, repository-metadata or documentation change. Application source can never be a supporting change. The amendment is recorded on the Story, changes no step, and code approval then counts the path. When approval refuses an unplanned path, its recovery names this command.

### What a code step's candidate contains

When the Story plans its claims, a code step's candidate contains its allocated expected paths, planned tests, supporting changes and plan amendments. Test automation always belongs. Other changed files remain untouched in your worktree and appear in `excludedChanges`; they are neither adopted nor committed. Publication, submission and approval bind HEAD plus the planned changes. Committing excluded work changes that baseline and makes it stale.

Any excluded change can affect execution, including `.txt` fixtures, Markdown and executable MDX. Checks therefore run in a temporary candidate worktree when any changed application file is outside every step's plan. Node dependencies are copied (copy-on-write where supported), with repository-owned workspace links rebound to candidate paths, never linked wholesale to the dirty checkout. External dependency links and Python virtual environments with potentially absolute/editable installs are refused: prepare candidate-local dependencies or review and account for the needed files. This is source isolation, not a security sandbox for untrusted tests.

Before execution, parser-visible old reports are cleared in both checkouts; stdout reporters write inside the candidate. Only fresh output is imported, after path checks. Original tracked reports are restored and cannot count as evidence of a no-op run. User source is never cleaned, stashed or reset. If a check needs an excluded file, account for it with `decision plan`. A changed file allocated to another step, unavailable dependencies, or the test-recovery pilot's worktree-bound report capture produces `GENERATION_EXCLUSIONS_UNSAFE`; publish the change in its owning step, amend the plan, or move it out of the worktree.

Approved inspection evidence must cite an exact qualified criterion identity. `OTHER-EV-1:AC-001` and `EV-1:AC-0010` cannot satisfy `EV-1:AC-001`.

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

Assurance is stated at its real strength. A criterion whose own test was found passing is `exact-local-observed`; one whose runner only counts tests is `module-observed`, and a command that passed with skipped tests leaves it inconclusive, because which test was skipped is not known. A failed test or command fails the criterion unless a governed risk decision accepted it, and the failed observation stays visible beside the exception. Submitting a code step warns about each criterion whose test did not pass; the Story cannot complete until it passes or its risk is accepted.

The completion line never derives "complete" from where the Story stands. An in-progress or cancelled Story reads "Incomplete — verification pending or insufficient". A Story closes only when the final evaluation passes inside the transition that ends it; that evaluation is recorded on the Story, and while it still matches the evidence the line reads "Complete" or "Complete with accepted exceptions". A closed Story whose evidence changed afterwards reads "Incomplete — final verification not evaluated".

When a gate refuses, the CLI, VS Code and Copilot receive one refusal record (gate-refusal v1): the open obligations, the reasons, the step responsible, what recovers it, whether a risk may be accepted, and what it left untouched; nothing was recorded. Retrying the same command on the same state returns `REFUSAL_UNCHANGED` at once without running the checks again.

## Troubleshooting

- **A row is pending:** the step that owes that obligation has not delivered yet.
- **A row is missing:** a finished step did not deliver it, for example no submitted test is tagged for the criterion.
- **Every row is inconclusive:** a claim map or index no longer matches its binding in the Story; the matrix lists the record it could not trust.
- **A row is inconclusive with skipped tests:** remove the skip or make the criterion's test run, then submit again.
- **A criterion's test was skipped or is not in the run:** remove the skip, or make the runner select its file (a `*Spec` class or a file outside the runner's pattern never runs), then publish and submit again.
- **A criterion's test is ambiguous, flaky or not exact:** give it a unique literal title or method, fix the flaky test, or move the tag to a test with a static identity.
- **`EVIDENCE_TAG_NOT_ON_TEST`:** the tag is not on the line directly above a test; move it there.
- **`TEST_CAPABILITY_UNSUPPORTED`:** a planned test sits in a module whose tests cannot run here (no supported runner, two build systems, or no covering command); configure a supported test command, plan the test in a supported module, or verify the criterion another way in the plan's verification contracts.
- **`SPEC_VERIFICATION_CONTRACT_INVALID`:** the plan's verification contracts table has a defect; the message names the row and what to change.
- **`EVIDENCE_INSPECTION_MISSING` or `EVIDENCE_VISUAL_MISSING`:** a contract slot needs its inspection or visual record, or its file changed after it was inspected; record it with `decision witness`.
- **`EVIDENCE_WITNESS_NOT_APPLICABLE` or `EVIDENCE_WITNESS_EXCEPTION_EXPIRED`:** the reviewer ruled the criterion's tests out, or an adequacy exception lapsed; tag an adequate test, or review the test again.
- **`EVIDENCE_ASSURANCE_SHORTFALL`:** the criterion passed below what its runner can reach or the Story requires; repair the test configuration, tag another test, or accept the risk with the `assurance-shortfall` category.
- **`REFUSAL_UNCHANGED`:** nothing the refusal depended on has changed since the last attempt; follow its recovery actions, then retry.
- **`SCOPE_ITEMS_UNRESOLVED`:** a requirement statement in the Story's sources has no disposition; run `singularity-flow evidence scope` and record each with `decision scope`.
- **`EVIDENCE_STALE_AFTER_SCOPE_REVISION`:** a scope revision changed this clause after its evidence was produced; run the step that owns the stale obligation again.
- **`RISK_NOT_WAIVABLE`:** the obligation is stale, untrusted, a review or the scope; repair it instead.
- **`RISK_DECISION_EXPIRED`, `RISK_DECISION_REVOKED`, `RISK_DECISION_OVERTAKEN`:** the decision no longer covers the obligation; renew it or meet the obligation.
- **`PRIOR_CODE_TEST_EVIDENCE_STALE`, `PHASE_SOURCE_CHANGED_AFTER_PUBLICATION` or `PHASE_ARTIFACT_ONLY_CHANGES`:** application files changed in a step that delivers no code. The refusal keeps them in your worktree, names the obligations they touch and the code step that owns each, and lists the returns the workflow permits; see `singularity-flow explain rejection-and-rework`.
- **`GENERATION_EXCLUSIONS_UNSAFE`:** a changed file belongs to another step's plan, or the checks could not run on a materialized candidate; publish it with its step, account for it with `decision plan --add-location` or `--add-supporting`, or move it out of the worktree, then try again.
- **A changed path is not claimed by a clause:** account for it with `decision plan --add-location` or `--add-supporting`, or remove the change if it does not belong to the Story.
- **`SCOPE_INVENTORY_INCOMPLETE`:** the completeness review waits until every statement has a disposition.
- **`SCOPE_INVENTORY_CHANGED`:** the inventory changed after you read it; run `singularity-flow evidence scope` again, review it, and confirm the digest it shows now.
- **`SCOPE_CHECKLIST_INCOMPLETE`:** answer each checklist article exactly once with `--article <id>=<decision>`, with `--article-reason` for any exception or not applicable.

## Related topics

Continue with `sflow explain approvals`, `sflow explain story-lifecycle`, or `sflow explain workflow-decisions`.
