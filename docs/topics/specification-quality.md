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
version: 6
---
Specification quality asks "is the requirement good enough?", which is a different question from verification ("does the implementation satisfy it?") and from conformance ("does the evidence trace to approved intent?"). `sflow spec analyze` answers the deterministic part without a model: unresolved clarification markers, duplicate requirement text, missing scenario sections, and defects the clause extractor refuses. It never claims prose is complete, clear, consistent or correct, and it says so in its own report — a clean run means nothing checkable is wrong, not that the specification is good. `--assisted` adds semantic candidates through one governed model turn with no tools; candidates are observations for a reviewer, are recorded separately with the model, prompt hash and usage, and change no deterministic finding and no gate.

The current starter workflow keeps those deterministic checks but does not require the six legacy quality-article decisions at Specification approval. It instead pins an independent source-grounded review for Specification and Planning. After each generation is published, `/sf-review-source` (Shell: `singularity-flow review-source context <phase> --json`) gives a separate read-only reviewer the exact Story, attached source documents, current artifact, and—during Planning—the approved Specification. The reviewer maps source passages to scenarios and clauses, then checks the plan's per-clause paths and tests. A report with missing citations, omissions, unresolved questions, or blocking findings cannot pass. Proposed exclusions and non-testable clauses require a separate, reasoned human disposition. Neither a clean deterministic analyzer nor a structurally complete review report is a guarantee of semantic correctness; the human still decides approval.

The review and dispositions are retained with hashes in Story Git history. Changing source documents, the Specification, Plan, or generation invalidates the review. The spec-driven starter also checks committed clause-to-source/test coverage before final code-phase approval, instead of waiting until convergence. Every changed application path must be claimed by a clause's planned Expected paths or tests; a file that cannot carry a `@clause` tag (a manifest, a lockfile, CI configuration) is listed in the plan under `## Supporting files`, one backticked exact path per bullet with its reason. While the code generation is open, `phase draft-check` and `phase prepublish` name any changed path approval would refuse, as non-blocking advisories. This proves traceability and executed evidence, not semantic correctness of the code. New Stories pin these policies; existing Stories retain their accepted policy and are not silently upgraded. Custom workflows can opt in with `workTypes.<id>.sourceReview: { mode: enforce, phases: [specification, planning], reviewerAgent: sflow-source-reviewer }`. The six legacy checklist articles remain off by default; a repository can still configure `phases.specification.specificationQuality.approvalChecklist` as `off` or `required` explicitly.

## Purpose and prerequisites

Use this topic when the current goal matches **specification quality**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `singularity-flow review-source context specification --json`, then `singularity-flow review-source submit specification --report-file <staging-path>`; inspect with `review-source status specification --json`. For a proposed exclusion, an authorized human uses `review-source decide specification --finding <id> --reason <text>`. The same forms apply to `planning`. Run `singularity-flow review-source --help` for the exact forms supported by this build.
- **Copilot:** `/sf-review-source`, followed by `/sf-submit` only when review is ready; `/sf-approve` remains a separate human decision.
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
