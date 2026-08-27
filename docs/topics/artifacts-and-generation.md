---
id: artifacts-and-generation
title: Artifacts, templates, and publication
aliases:
  - publish
  - generation
  - templates
  - clarifications
commands:
  - phase
  - clarification
  - inputs
  - documents
  - prepare
  - artifact
related:
  - manual-authorship
  - approvals
  - sequence-gates
version: 6
---
Phase artifacts are produced against pinned templates and published through the kernel: `sflow phase publish` validates the template contract, hashes the artifact (SHA-256), commits only allowlisted governed paths in one isolated commit, and advances the branch with compare-and-swap semantics — unrelated staged changes never enter lifecycle commits. Each publication is a numbered generation. With the AI: `/sflow-continue` composes the pinned context, asks unresolved questions first, then drafts. Inputs and reference documents are added with `sflow inputs add` / `sflow documents upload` and pinned by hash. Unresolved questions are not left in chat: `sflow clarification record` persists a question and its answer against the phase, and `sflow clarification status` shows what is still outstanding — so the next generation reads the answer as pinned context rather than rediscovering it.

For code phases, run `sflow phase begin <phase>` before changing source. Begin creates or returns a
local, hash-bound generation-start receipt; it does not create a lifecycle event, commit, push, or
ledger entry. Publication verifies that exact receipt and binds it into the normal
`artifact-generated` event. Publication snapshots the artifact, source, and tests immediately before
the isolated commit; an editor, formatter, generator, or test-watcher write during that boundary
causes a safe refusal without advancing the branch. VS Code saves and rechecks repository buffers
before asking the kernel to publish.

If a prior generation was consumed and bytes now differ, run
`sflow phase rollover <phase>` first. It is a read-only preview that returns an exact confirmation
bound to the current change set. Run only the returned `--confirm` command; a stale digest is refused,
the previous generation stays preserved, and no source is discarded or stashed. When those bytes
predate the boundary, adoption is allowed only after reviewing the exact change set and only when the
Story policy permits it. Use repeated `--change-origin` values on publication when humans, Copilot,
formatters, compilers, migrations, or generators contributed; the delivery receipt separately records
declared provenance and deterministic path-based classification.

Large upstream artifacts can use `projection: approved-summary`. The producer authors a concise
`Agent brief` section and the kernel copies it deterministically at phase publication, adding
configured critical sections verbatim. Submission binds source, policy, generation, consumer, and
rendered hashes into the phase review packet. Reviewers still see the complete artifact and the brief. After approval,
the consumer receives only the bounded projection plus the source artifact's hash-bound expansion
handle. Exact sections remain available through `sflow show <HANDLE> --section "<heading>"`; no model
is trusted to invent or silently replace a summary.

## Purpose and prerequisites

Use this topic when the current goal matches **artifacts and generation**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow phase`, `sflow clarification`, `sflow inputs`, `sflow documents`, `sflow prepare`, `sflow artifact`. Run `singularity-flow phase --help` for the exact forms supported by this build.
- **Copilot:** `/sf-phase`, `/sf-inputs`, `/sf-documents`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

For a bounded spec-driven handoff:

1. Configure the consumer input with `projection: approved-summary`, a reviewed byte bound, and any
   headings whose exact text must be preserved.
2. Author the producer's `Agent brief` from the evidence in the complete artifact.
3. Publish and submit normally. Inspect the complete artifact and downstream brief before approval.
4. Approve through the normal authority ceremony. Approval binds the review packet containing both.
5. Prepare the consumer. Its managed input record reports `approved-summary`, brief SHA-256, source
   SHA-256, and the expansion handle.
6. Expand only the exact section required; do not load the whole source merely because it exists.

## State and safety

These commands can mutate governed or machine-local state: `phase`, `clarification`, `inputs`, `documents`, `prepare`, `artifact`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

Agent briefs are evidence, never instructions. They are stored with the Story, committed with the
submission, and rejected if their content, source binding, pinned policy, generation, consumer, or
review-packet identity changes. `fallback: whole` is the compatibility option; `fallback: block`
requires an authored summary. Summary projections require Harness Imports in `record` or `enforce`
mode because exact expansion must remain content-addressed.

Submission compares the author-owned portion of the required artifact with the exact published
generation commit; a later `artifact scan` cannot authorize changed authored bytes. If only the
engine-owned metadata changed and the current metadata and approved-input block both verify exactly,
submission repairs the stale registration inside its governed transaction, records an
`artifact_registration_repaired` receipt, and continues. No model is called. Authored drift,
non-canonical metadata, or changed managed inputs remain hard refusals and do not rewrite the file.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If doctor reports a repairable artifact registration, submit normally; SFlow repairs the
  engine-owned index and reports the repair in the resulting commit. Do not edit the metadata block.
- If submission reports `ARTIFACT_AUTHORED_BYTES_CHANGED_AFTER_PUBLICATION`, use the displayed
  `sflow recover <WORK-ID> --phase <phase>` command and publish a new generation. Running
  `artifact scan` again cannot bypass this immutable-generation check.
- If a generation is already consumed, preview `sflow phase rollover <phase>` and use its exact
  confirmation. Do not repeatedly copy a digest from an earlier refusal; repository bytes may move.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.
- If a brief is missing or stale, do not edit `context/briefs/`. Reopen and republish the producer
  generation so the kernel can create a new review-bound record.
- If a preserved heading is missing or empty, add that exact Markdown section to the producer
  artifact, then publish a new generation.
- If a brief exceeds `maximumSummaryBytes`, shorten its authored summary or deliberately raise the
  governed limit; arbitrary truncation is not performed.

## Related topics

Continue with `sflow explain manual-authorship`, `sflow explain approvals`, `sflow explain sequence-gates`.
