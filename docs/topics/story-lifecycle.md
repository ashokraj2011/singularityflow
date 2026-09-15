---
id: story-lifecycle
title: Story lifecycle, phases, and generations
aliases:
  - phases
  - generations
  - workflow-state
commands:
  - status
  - finalize
  - cancel
  - reopen
  - progress
related:
  - starting-work
  - sequence-gates
  - pins
version: 3
---
A story moves through the phases of its pinned work type (e.g. requirements → design → implementation → verification). Each phase produces artifacts as numbered generations; a rejection requires a fresh generation — history is never rewritten. State lives in `singularity/work-items/<ID>/` on the story branch: workflow.json (authority), artifacts, approvals, context, telemetry, evidence.

For automation and Copilot, `sflow status [WORK-ID] --submission-readiness --json`
returns a compact read-only view of the current
phase's lifecycle readiness. A published phase normally remains `in_progress`
until submission, so that label does not mean it must be republished. The
projection distinguishes that state from an unpublished generation and from
pending synchronization. Returned submission commands are pinned to the
inspected Work ID, and soft gates remain explicit human confirmation points.
It says only whether submission may be attempted;
`validation` remains `deferred-to-submit`, and repository tests, quality
checks, acceptance coverage, conformance, and other gates still run during
submission.

## Purpose and prerequisites

Use this topic when the current goal matches **story lifecycle**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow status`, `sflow status --submission-readiness --json`, `sflow finalize`, `sflow cancel`, `sflow reopen`, `sflow progress`. Run `singularity-flow status --help` for the exact forms supported by this build.
- **Copilot:** `/sf-status`, `/sf-finalize`, `/sf-cancel`, `/sf-progress`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

These commands can mutate governed or machine-local state: `finalize`, `cancel`, `reopen`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain starting-work`, `sflow explain sequence-gates`, `sflow explain pins`.
