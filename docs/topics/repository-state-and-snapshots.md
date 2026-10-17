---
id: repository-state-and-snapshots
title: Repository state, snapshots, and branch refresh
aliases:
  - state
  - snapshot
  - refresh-branch
commands:
  - state
  - snapshot
  - refresh-branch
related:
  - recovery
  - workspaces-and-sessions
  - pins
version: 3
---
Repository snapshots are read models of and Git state. Refresh uses safe fast-forward behavior and never hides dirty, diverged, or ambiguous work.

## Faster VS Code reads

Installed, stamped builds can reuse a private Node worker for selected UI snapshot slices and plain
JSON `status`/`nextsteps` reads. Only loaded code survives: every request opens fresh read and policy
scopes and clears command-local Git/object observations. No authoring or reviewer session is reused.
Full/heavy snapshots, agent packets, readiness receipts, publication, repairs and approvals keep
their normal CLI route. Editable, unstamped development checkouts also keep the CLI route so source
edits cannot be hidden behind old loaded code.

Identical in-flight reads share work across panels and clients, with independent cancellation.
Observed Git/configuration changes and mutations invalidate reuse; changed environment or installed
build starts a new worker. Ordinary overlapping Refresh requests join the current read; an actual
change or added data slice requests one follow-up. Workers are private parent-owned IPC children,
serial per repository, capped at two per adapter, 16 queued requests, 64 reads, five minutes of age,
and one minute idle. There is no listening server or persisted worker endpoint.

If the worker fails, that read falls back once to the existing CLI. Cancellation never retries.
The first worker read includes startup and can be slower than a single CLI call; later reads avoid
reloading the engine. Disable `singularityFlow.warmReads` and reload VS Code to compare or diagnose;
`SINGULARITY_FLOW_READ_WORKER=off` also disables the transport. Output records identify worker start
versus reuse without logging arguments, credentials, repository contents, or environment values.

For reproducible local qualification, run `node scripts/warm-read-benchmark.mjs --samples=5` from
the source checkout. It measures cold CLI, first worker and warm reads in a stamped bundled fixture,
then complete Story intake against a local bare remote, without a model. It cleans up that fixture
afterward. These measurements are not native Copilot token savings or Windows latency evidence.

## Purpose and prerequisites

Use this topic when the current goal matches **repository state and snapshots**. Start in a repository that uses Singularity Flow unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow state`, `sflow snapshot`, `sflow refresh-branch`. Run `singularity-flow state --help` for the exact forms supported by this build.
- **Copilot:** `/sf-refresh-branch`. The skill must preserve the CLI result and ask before it changes anything.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

These commands can change repository or machine-local state: `state`, `refresh-branch`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain recovery`, `sflow explain workspaces-and-sessions`, `sflow explain pins`.
