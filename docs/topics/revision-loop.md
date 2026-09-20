---
id: revision-loop
title: Bounded code Candidate revision loop
aliases:
  - revise code candidate
  - feedback code test loop
  - candidate revision
commands:
  - revise
  - revision
related:
  - revision-feedback-attachments
  - artifacts-and-generation
  - workflow-authoring
version: 1
---
## Purpose and prerequisites

The guarded Revision Loop refines one exact, unpublished code Candidate without weakening the normal phase lifecycle. It is a bounded correction path inside an open code generation: preview classifies feedback and binds the exact clean source snapshot (or an already-retained loop head), first confirmation retains the immutable parent Candidate, changes run inside a limited interval, and deterministic precheck freezes a new Candidate. Publication, submission, approval, merge, and deployment remain separate actions.

REV is eligible only when the selected Story session is ready, the active open generation uses a registered `generation.task: code`, the current Candidate has not been published, no recovery is pending, editor buffers are saved or captured, and the installed runtime reports the guarded pilot as eligible. Phase names such as `implementation` or `testing` never grant eligibility by themselves. A repository opt-in cannot override a missing runtime capability, witness, or policy gate.

## Use it from each surface

**Shell:** Run `singularity-flow revision status --json` or `singularity-flow revision card --json` for model-free inspection. Save all editor buffers, then keep feedback off argv with `singularity-flow revise --dry-run --feedback-stdin --saved-buffers-confirmed --json`. After reviewing the preview, use the same standard-input bytes, selectors, and saved-buffer assertion with `singularity-flow revise --feedback-stdin --saved-buffers-confirmed --confirm sha256:<PLAN> --json`.

**Copilot:** Use `/sf-revise status`, `/sf-revise card`, or `/sf-revise <feedback>`. The skill shows classification, the exact source snapshot or retained loop head, criteria/specification disposition, effects, budgets, routing, and the complete plan digest; it waits for the user to type that digest before opening the exact interval.

**VS Code:** Use `@sflow /revise status`, `@sflow /revise card [INTERVAL-ID]`, or `@sflow /revise show <INTERVAL-ID>` for bounded reads. Free-form `@sflow /revise` feedback only prefills `/sf-revise` with `isPartialQuery: true`; the button neither sends the prompt nor starts a revision.

## Guided workflow

1. Inspect `revision status` and stop on a wrong task, published Candidate, recovery, or unsaved-buffer refusal.
2. Supply exact feedback on standard input. Add `--criteria <CLAUSE-ID>` only when explicitly selected. Add `--attachment-set <SHA256>` only for an already registered, active set bound to the same Story, phase, feedback digest, repository, and context; the preview revalidates it before use.
3. Run the dry-run form once. Review the exact clean source snapshot (or the loop's already-retained head), classification, criteria and specification disposition, allowed paths/effects, execution unit, budgets, precheck profile, exact routing plan, and plan digest. Preview retains no first parent, starts no interval, and changes no code. A routing-required result creates no durable Human Request and cannot be confirmed. Its `routing` field is the exact preview result; `/sf-recommend` or `singularity-flow recommend --json` only re-evaluates the repository's current next step and does not consume that routing plan.
4. Confirm with the full digest and the same feedback bytes and selectors. The CLI rereads every binding; a changed Candidate, phase, authority, buffer, feedback byte, or plan fails closed. Successful first confirmation retains the previewed source snapshot as the immutable first parent.
5. After interval start, the developer edits and saves only the returned bounded code/test scope. The guarded build does not invoke a model, project command, shell, or Git command to make those edits. Preview with `singularity-flow revision capture --preview --note <NOTE> --saved-buffers-confirmed`, then repeat the same note and assertion with `--plan sha256:<PLAN> --confirm sha256:<PLAN>` only after reviewing that digest. A Code check is Candidate evidence, not the later Testing or Verification verdict.
6. Inspect the resulting card. It identifies the exact retained Candidate, deterministic precheck, warnings, unexplained diff units, and remaining actions. It does not invent test, screenshot, or hunk-attribution evidence.
7. At `PRECHECKED`, inspect the remaining obligations and stop. The guarded pilot does not yet bridge the selected REV head into ordinary phase publication, and it never presents an unavailable check as passed. Continue ordinary phase work separately; do not claim that it consumed the REV Candidate.

## State and safety

Feedback, bindings, disposition, packet, Candidate lineage, and precheck records are content-addressed. Private recovery payloads are immutable and the current recovery pointer is self-hashed and compare-and-swap updated. Every successful start confirmation stores an immutable result receipt under its exact plan digest; replaying the same feedback and selectors returns that original result even after a later interval replaces the pointer. Other historical mutations are not replayable. Changed bytes or authority require a new preview. The agent cannot use the interval to run Git, edit workflow/process configuration, alter requirement or criterion text, change proof policy, perform unknown external effects, fabricate a receipt, or promote `observed-unverified` output.

The safe built-in profile is not an autonomous model/code executor and does not claim external-effect or release attestation. It never publishes, submits, approves, merges, deploys, amends intent, or replaces later Testing/Verification. A model summary or self-hashed test log cannot replace governed evidence.

## Troubleshooting

- `REV_PLAN_STALE`: rerun the preview; never reuse a digest after Candidate, phase, authority, buffer, attachment, or feedback changes.
- `REV_SPECIFICATION_CHANGE` or `REV_SPECIFICATION_AMBIGUOUS`: no code may change. Route the request to the workflow's reviewed amendment path.
- Active or uncertain interval: inspect `singularity-flow revision status --json`. Run `singularity-flow revision resume [<INTERVAL-ID>]` only when returned as legal. Resume is a bounded recovery mutation: it may complete an exact durable opening, frozen-Candidate precheck, abandonment, or journal/pointer reconciliation, but it never repeats an uncertain attempt.
- Abandonment: preview with `singularity-flow revision abandon <LOOP-ID|INTERVAL-ID> --preview --json`, then run `singularity-flow revision abandon <LOOP-ID|INTERVAL-ID> --plan sha256:<PLAN> --confirm sha256:<PLAN> --json` only after reviewing that exact digest. Use the loop ID when a newly opened loop has no captured interval; otherwise either the active loop ID or its selected interval ID identifies the same abandonment target. Confirmation closes the local loop and preserves its selected Candidate head; it does not restore or replace that head.
- Unproven cleanup or external effect remains recovery-required. REV never claims restoration without evidence.

## Related topics

Use `sflow explain revision-feedback-attachments` for verified local feedback documents, `sflow explain workflow-authoring` for reviewer-led bounded phase rework, and `singularity-flow revision activation --json` for the exact installed pilot boundary. Workflow loops and REV Candidate intervals solve different problems and do not substitute for each other.
