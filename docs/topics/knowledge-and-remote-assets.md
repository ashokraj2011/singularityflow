---
id: knowledge-and-remote-assets
title: Knowledge, artifacts, and remote assets
aliases:
  - knowledge
  - remote-assets
  - artifact
commands:
  - knowledge
  - artifact
related:
  - artifacts-and-generation
  - world-model
  - evidence-and-ledger
version: 3
---
Remote templates, generated artifacts, and knowledge are copied or pinned by exact content. Changed remote bytes require an explicit trust or replacement decision.

## Purpose and prerequisites

Use this topic when the current goal matches **knowledge and remote assets**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow knowledge`, `sflow artifact`. Run `singularity-flow knowledge --help` for the exact forms supported by this build.
- **Copilot:** `/sf-help` followed by the documented CLI fallback. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview a reviewed knowledge seed with `singularity-flow knowledge import path/to/seeds.yaml --dry-run`.
4. Import it with the same command without `--dry-run`. All entries and their approved Story or Initiative artifact provenance are preflighted before any record is written; new records are published in one knowledge commit.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

A seed manifest is JSON or YAML with exactly `schemaVersion: 1` and an `entries` array. Each entry
has `type`, bounded `text`, one or more `provenance` items, an explicit `scope`, and `status`;
`validFrom`, `validUntil`, and `supersedes` are optional. The importer accepts at most 256 entries,
16 provenance items and 64 scope values per entry, 16 KiB of UTF-8 text per entry, and a 1 MiB
manifest. Unknown keys, aliases, duplicate claims, and unsafe or non-repository paths are refused.
The manifest never substitutes for approved provenance, and re-importing unchanged entries is a
no-op.

## State and safety

These commands can mutate governed or machine-local state: `knowledge`, `artifact`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain artifacts-and-generation`, `sflow explain world-model`, `sflow explain evidence-and-ledger`.
