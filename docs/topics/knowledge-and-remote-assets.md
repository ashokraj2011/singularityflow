---
id: knowledge-and-remote-assets
title: Knowledge, artifacts, and remote assets
aliases:
  - knowledge
  - remote-assets
  - artifact
commands:
  - knowledge
  - lessons
  - artifact
related:
  - artifacts-and-generation
  - world-model
  - evidence-and-ledger
version: 6
---
Remote templates, generated artifacts, and knowledge are copied or pinned by exact content. Changed remote bytes require an explicit trust or replacement decision.

## Purpose and prerequisites

Use this topic when the current goal matches **knowledge and remote assets**. Start in a repository that uses Singularity Flow unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow knowledge`, `sflow lessons`, `sflow artifact`. Run `singularity-flow knowledge --help` for the exact forms supported by this build.
- **Copilot:** `/sf-help` followed by the documented CLI fallback. The skill must preserve the CLI result and ask before it changes anything.
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

### Story lessons

Every approved Story step leaves lessons that SFlow notices from its own records, with no model and no question: a
test run that stopped on its environment, a refusal that kept coming back, a reviewer's finding that was fixed, a check a
person overrode, failing tests that sent the work back, a file outside the plan the work needed, and the agent's own
`Learnings to carry forward`. They are knowledge records with a lesson part, committed with the approval, and copied
on this machine so this person's other Stories get them too. Each later step's prompt carries the ones for the files it
names or touches (at most 10 and 2 KB), as quoted data, never as instructions; nothing blocks or approves because of a
lesson. `singularity-flow lessons` lists them, and `lessons drop`, `keep` and `edit` change one. `lessons rule` makes one
a team rule, first for every step on its files; SFlow offers it when a mistake happens again twice although its lesson
was given. A missing test command's refusal puts first the suggestion an earlier Story ran on those folders.

## State and safety

These commands can change repository or machine-local state: `knowledge`, `lessons`, `artifact`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain artifacts-and-generation`, `sflow explain world-model`, `sflow explain evidence-and-ledger`.
