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
version: 2
---
Phase artifacts are produced against pinned templates and published through the kernel: `sflow phase publish` validates the template contract, hashes the artifact (SHA-256), commits only allowlisted governed paths in one isolated commit, and advances the branch with compare-and-swap semantics — unrelated staged changes never enter lifecycle commits. Each publication is a numbered generation. With the AI: `/sflow-continue` composes the pinned context, asks unresolved questions first, then drafts. Inputs and reference documents are added with `sflow inputs add` / `sflow documents upload` and pinned by hash. Unresolved questions are not left in chat: `sflow clarification record` persists a question and its answer against the phase, and `sflow clarification status` shows what is still outstanding — so the next generation reads the answer as pinned context rather than rediscovering it.

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

## State and safety

These commands can mutate governed or machine-local state: `phase`, `clarification`, `inputs`, `documents`, `prepare`, `artifact`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain manual-authorship`, `sflow explain approvals`, `sflow explain sequence-gates`.
