---
id: diagnostics-and-regression
title: Diagnostics, regression investigation, and hooks
aliases:
  - diagnostics
  - regression
  - harness
  - hooks
commands:
  - doctor
  - harness
  - regression
  - hook
related:
  - getting-started
  - recovery
  - repository-state-and-snapshots
version: 3
---
Diagnostics report facts and bounded host coverage. Regression investigation gathers reproducible evidence; hooks enforce local policy without becoming an approval authority.

## Purpose and prerequisites

Use this topic when the current goal matches **diagnostics and regression**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow doctor`, `sflow harness`, `sflow regression`, `sflow hook`. Run `singularity-flow doctor --performance --json` for an explicit monorepo benchmark.
- **Copilot:** `/sf-help` followed by the documented CLI fallback. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

For a large repository, `doctor --performance` measures cold and warm `git status`, cold and warm content-aware world-model fingerprints, total/scoped tracked files, sparse checkout, partial-clone filter, object counts, FSMonitor, and untracked-cache settings. It is opt-in because benchmarking should never add latency to Home or routine diagnostics. The command is read-only and emits recommendations; it does not change local Git configuration.

Every doctor run also performs a bounded, read-only durable-schema census. JSON output includes the observed version distribution for each registered record family and identifies records outside this build's readable range. Older readable records are migrated only in memory; their stored bytes and content hashes do not change. A future record is refused with an upgrade remedy, while a record older than the declared range names the archival-reader or governed-republication path.

## State and safety

These commands can mutate governed or machine-local state: `harness`, `regression`, `hook`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If `schema-migrations` fails, do not edit a stored `schemaVersion` or rewrite content-addressed evidence. Upgrade when the record was written by a newer sflow; use the named archival path or a governed republication when it is below the supported range.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain getting-started`, `sflow explain recovery`, `sflow explain repository-state-and-snapshots`.
