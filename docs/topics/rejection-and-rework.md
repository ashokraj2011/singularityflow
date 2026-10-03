---
id: rejection-and-rework
title: Rejection and rework
aliases:
  - reject
  - regeneration
  - rework
related:
  - approvals
  - artifacts-and-generation
version: 4
commands: []
---
A rejection reopens the phase and requires a fresh generation — with the reviewer's reasons pinned as composed context for the regeneration, alongside anything they cited. Nothing else is lost: implementation branches, interval history, checkpoints, and evidence carry forward. Rejection is designed to be cheap for the author and informative by construction: generation 2 starts from everything generation 1 learned, including the reviewer's exact words.

## Rework completion and abandonment

The target of a rejection, a reopen or a backward workflow decision always needs a fresh generation. A phase after it needs one too, unless rework keeps its approval (below). The next-step planner offers regeneration before submission. A target phase completed without human approval, or through a verified policy waiver, resolves its open change request just as an ordinary approved completion does; completed rework is no longer eligible for abandonment.

## Approvals rework keeps

Each approval records what it decided over: the phases its step declares as inputs (every earlier phase when it declares none), the code at HEAD and the specification records once code is delivered, the documents offered to it, and the Story's scope, plan, risk and applicability decisions. After a rejection or a reopen, when the phase before an approved later phase completes again, that approval is compared with the Story as it is now. If everything it decided over is byte-identical, and its artifacts and inputs still verify, the approval is kept under rule E1 (identical inputs): the phase is not regenerated, a new approval record names the rule and the approval it carries, and the history shows `phase_retained`. Otherwise the phase runs again, and the approval's history entry says which reference changed, for example `design runs again because input:intake changed`.

Evidence is reused only under the product's closed set of rules (E1 to E7); a workflow cannot add one. A phase that feeds or follows a decision, a skill phase, a phase completed without a person's approval, a decision's loop, and a range reopened by a changed document or design source always run again.

## Code changed outside a code step

When a step that delivers no code finds changed application files, at generation, at submission or when a review checks its Code evidence, it refuses with one evaluation. The files stay in your worktree; nothing is reverted or adopted. Each path is mapped to the plan rows that name it, to their implement and verify obligations, and to the code steps that own them: the steps a row's Steps column names, else the closest earlier code step. The refusal then lists the returns the workflow permits from where the Story stands, each only where the step's approval policy may return to that owner: `reject <step> --to <owner> --repair` while the step is in progress and the owner is approved, `reject <step> --to <owner>` once the step awaits approval, or `reopen <WORK-ID> --to <owner>` for a completed Story. A path no plan row names is accounted for first with `decision plan`. Any step that delivers code may own a path; nothing depends on a step being named Code.

Roll-forward preserves Git history. A generation published during abandoned rework remains an immutable historical identity, so a later attempt uses the next unused number (for example, generation 3 after abandoning generation 2). Restoring generation 1 for review does not make generation 2 reusable.

When roll-forward exactly restores a clean submitted checkpoint, it creates a fresh review packet and requires fresh human approval. Earlier partial approvals do not carry across that new packet. A checkpoint containing unsubmitted edits is not converted into approved evidence: inspect the returned recovery action and keep those bytes for review.

## Purpose and prerequisites

Use this topic when the current goal matches **rejection and rework**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow explain`. Run `singularity-flow explain --help` for the exact forms supported by this build.
- **Copilot:** `/sf-help` followed by the documented CLI fallback. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

The commands mapped to this topic are read-only. They may inspect local files and Git state, but they do not advance lifecycle state or grant authority. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain approvals`, `sflow explain artifacts-and-generation`.
