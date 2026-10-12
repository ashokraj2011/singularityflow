---
id: specification-quality
title: Specification quality and clarification markers
aliases:
  - markers
  - needs-clarification
  - spec-analyze
  - checklist
  - artifact-sets
  - tasks-md
commands:
  - spec
  - approve
  - reject
  - clarification
  - review-source
related:
  - fast-path-verbs
  - approvals
  - artifacts-and-generation
  - rejection-and-rework
version: 12
---
Specification quality asks "is the requirement good enough?", which is a different question from verification ("does the implementation satisfy it?") and from conformance ("does the evidence trace to approved intent?"). `sflow spec analyze` answers the deterministic part without a model: unresolved clarification markers, duplicate requirement text, missing scenario sections, and defects the clause extractor refuses. It never claims prose is complete, clear, consistent or correct, and it says so in its own report — a clean run means nothing checkable is wrong, not that the specification is good. `--assisted` adds semantic candidates through one governed model turn with no tools; candidates are observations for a reviewer, are recorded separately with the model, prompt hash and usage, and change no deterministic finding and no gate. Running it again for the same specification, findings and model shows the recorded candidates without another model call; `--refresh` asks again.

The current starter workflow keeps those deterministic checks but does not require the six legacy quality-article decisions at Specification approval. It instead pins an independent source-grounded review for Specification and Planning. After each generation is published, `/sf-review-source` (Shell: `singularity-flow review-source context <phase> --json`) gives a separate read-only reviewer the exact Story, attached source documents, current artifact, and—during Planning—the approved Specification. The reviewer maps source passages to scenarios and clauses, then checks the plan's per-clause paths and tests. A report with missing citations, omissions, unresolved questions, or blocking findings cannot pass. Proposed exclusions and non-testable clauses require a separate, reasoned human disposition. Neither a clean deterministic analyzer nor a structurally complete review report is a guarantee of semantic correctness; the human still decides approval.

The review and dispositions are retained with hashes in Story Git history. Changing source documents, the Specification, Plan, or generation invalidates the review. The spec-driven starter also checks committed clause-to-source/test coverage before final code-phase approval, instead of waiting until convergence. Every changed application path must be claimed by a clause's planned Expected paths or tests; a file that cannot carry a `@clause` tag (a manifest, a lockfile, CI configuration) is listed in the plan under `## Supporting files`, one backticked exact path per bullet with its reason. While the code generation is open, `phase draft-check` and `phase prepublish` name any changed path approval would refuse, as non-blocking advisories. This proves traceability and executed evidence, not semantic correctness of the code. New Stories pin these policies; existing Stories retain their accepted policy and are not silently upgraded. Custom workflows can opt in with `workTypes.<id>.sourceReview: { mode: enforce, phases: [specification, planning], reviewerAgent: sflow-source-reviewer }`. The six legacy checklist articles remain off by default; a repository can still configure `phases.specification.specificationQuality.approvalChecklist` as `off` or `required` explicitly.

The context packet includes the canonical `reportSchema` and a `reportTemplate`. Planning metadata is prefilled from the exact approved clauses and published plan, with `assessment: unreviewed`; it is not a machine endorsement. Review rows use singular `clauseId`, `expectedPaths` and `plannedTests`. Findings use `id`, `severity: blocking|advisory` and `message`. A pinned `test-only` plan row legitimately has no product paths, but still needs planned tests. Before retaining a report, run `review-source check` at the returned Git-private staging path. It diagnoses format, citations and bindings without commit or push. `retentionReady` means the packet can be retained as evidence, not that the phase can advance: real semantic gaps, unanswered questions and pending human decisions still block phase submission. `submit` repeats validation and refuses malformed packets before creating a transaction. Copilot performs at most two changed-packet format repairs and does not repeatedly publish guesses or mark gaps supported to pass a gate.

## Purpose and prerequisites

Review context includes the accepted reviewer's instructions; do not create or persistently select
another agent. Retention scopes the reviewer to that operation and preserves the phase author's
session. Review instructions prohibit authoring or advancing work; native activation preserves
the author, while CLI lifecycle guards reject a persistently selected read-only agent.
Readonly default authors are rejected during configuration validation, including copied steps.
If an older generation was authored by its required reviewer, the recovery route selects its
accepted author and prepares an honestly authored successor; it never relabels published history.

Context labels both `authoredContentSha256` (the review binding) and `registeredFileSha256` (the
full file including managed metadata). The CLI verifies full-file integrity before composing the
packet. Different hash domains do not indicate stale evidence; submission's metadata rewrite does
not invalidate unchanged authored content. Pending approved intent amendments route first to an
explicit human acknowledgement across guide, readiness, fast-path and recovery, before downstream
authoring, publication or submission. Self-approval warnings remain separate from acknowledgement.

Use this topic when the current goal matches **specification quality**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Scenario coverage before publication

New spec-driven Stories pin `specificationQuality.scenarioCoverage: required`. Authors declare
S-number situations with complete Given/When/Then acceptance cases and a `## Scenario coverage`
table: `Clause | Scenario | Outcome`. Every behavior/acceptance clause needs a row; multiple rows
may cover different outcomes. Outcome is `success`, `failure`, `boundary`, or `empty`. Each
referenced scenario must exist and every acceptance case must state all three substantive fields.
Rejection/error behavior needs a distinct invalid-input case with an observable error, drawn from
the pinned request and clarification answers—not invented wording or an expanded requirement.

`phase draft-check`, `phase prepublish`, specification analysis and publication share this
checker. A missing table, missing clause row, dangling scenario, duplicate row or incomplete
acceptance case is an author correction in the open generation. Preserve the draft, repair it,
recheck, then use the returned publication command. Missing coverage is not a new clarification
interview. Only a genuine unanswered material question asks the human for an answer.

Existing policies keep their hashes: an omitted setting does not become `required`. A declared
table is still checked for structural validity; lexical rejection/error hints are non-blocking
advisories, never a semantic verdict. Explicit `scenarioCoverage: off` disables this extension.
Imported, duplicated and custom workflows can pin the same policy on their scope-defining phase;
the checker does not depend on the phase being named specification. Current scope-authoring
prompts describe the same contract. Approved inputs and earlier publications are never repaired
in place. Independent review remains necessary to judge whether a case actually covers the
source obligation; complete syntax does not prove correct behavior or executed tests.

## Verification method continuity

New specifications declare one row per clause in `## Verification intent`:

| Clause | Methods | Criterion |
|---|---|---|
| `STORY:REQ-004` | visual | `STORY:AC-004` |
| `STORY:AC-004` | visual | `STORY:AC-004` |

Methods are `test`, `visual`, `inspection`, or a comma-separated combination, all required.
Each AC names itself; visual/inspection requirements link to the AC proving them. A test-only
requirement may use `-` for Criterion. Once declared, the table must cover every clause, including
non-functional requirements. Duplicate, unknown, incomplete or inconsistent rows are refused in
Specification's current draft, before Planning. Legacy publications without the table stay intact;
the engine never guesses their proof method from prose, a filename or an existing image.

The approved index and compact clause capsule retain these methods for all downstream and custom
workflow phases. Planning inherits them and supplies exact primary witness slots in its existing
`## Verification contracts` table. For proof without an executable test, write
`verification: STORY:AC-004` in the clause's Planned tests cell. This records `non-test` proof,
not an exemption. A screenshot requirement and its AC can share one visual contract. A primary
visual/inspection contract in a legacy AC row likewise does not require a duplicate test-exemption
decision. An unlinked legacy requirement or genuine `not-applicable: <reason>` still needs its
authorized human disposition.

Planning cannot replace approved automated tests with an exemption, demote required proof to
supporting, or make required combined methods optional. Evidence-contract corrections obey the
same rule. Correct an open draft in place, then recheck; an actual scope-method change requires
its scope authority. These declarations never accept a screenshot: fresh source-bound visual
or inspection evidence, configured test execution, independent review and phase approval remain
separate requirements. Existing retained reviews need a fresh review against the corrected plan;
no prior human decision or published artifact is rewritten.

## Use it from each surface

- **Shell:** `singularity-flow review-source context specification --json`, then `singularity-flow review-source check specification --report-file <staging-path> --json`, then `singularity-flow review-source submit specification --report-file <staging-path>` when `retentionReady` is true; inspect with `review-source status specification --json`. For a pending exclusion, an authorized human prepares `review-source decision-context specification --work-id <WORK-ID> --finding <ID> --reason <TEXT> --json`, reviews the exact packet, and runs its returned `decide --confirm` command. The same forms apply to `planning`, including renamed steps with these responsibilities. Run `singularity-flow review-source --help` for exact forms.
- **Copilot:** `/sf-review-source`, then `/sf-review-decide` in a separate turn for pending human exceptions, followed by `/sf-submit` only when review is ready; `/sf-approve` remains a separate human decision.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

These commands can mutate governed or machine-local state: `spec`, `approve`, `reject`, `clarification`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.
- Review needs citable text from every attached source. DOCX and XLSX text can be extracted; a PDF or screenshot without a supported text rendition is reported as unreadable and must be supplied as a reviewable, pinned text source before this gate can pass. It is never silently skipped.

## Related topics

Continue with `sflow explain fast-path-verbs`, `sflow explain approvals`, `sflow explain artifacts-and-generation`, `sflow explain rejection-and-rework`.
