---
id: manual-authorship
title: Manual authorship and working without AI
aliases:
  - authored-human
  - no-model-authoring
  - from-file
commands:
  - phase
related:
  - model-independence
  - artifacts-and-generation
version: 3
---
`sflow phase publish --authored human --from ./design.md` gives hand-written artifacts the same pipeline: template validation, hashing, the standard transaction, approvals, evidence. The record states precisely what is known: the kernel invoked no model. External AI use defaults to `unknown` and can be attested only as self-reported — the system never infers AI authorship from style. Imported files are hashed before copying, written atomically to the pinned artifact path, and any forged lifecycle metadata inside them is stripped. Repeat `--change-origin` when a reviewed generation combines human, Copilot, formatter, compiler, migration-tool, test-generator, code-generator, or external-tool contributions. These declarations record provenance; path-based delivery classification is stored separately and never pretends to identify an author.

## Purpose and prerequisites

Use this topic when the current goal matches **manual authorship**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow phase`. Run `singularity-flow phase --help` for the exact forms supported by this build.
- **Copilot:** `/sf-phase`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

These commands can mutate governed or machine-local state: `phase`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain model-independence`, `sflow explain artifacts-and-generation`.
