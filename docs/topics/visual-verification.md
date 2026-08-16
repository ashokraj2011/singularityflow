---
id: visual-verification
title: Visual verification for mobile
aliases:
  - visual
  - pixel-compare
  - device-profiles
  - figma-mobile
commands:
  - visual
related:
  - mcp-integration
  - approvals
version: 2
---
The figma-mobile work type pins the design file version itself: design-source records carry file key, version, nodes, and export hashes; a newer design version surfaces as a staleness warning, never silent drift; promotion requires exact-record confirmation and invalidates downstream approvals. Declared device profiles make coverage arithmetic — `sflow visual status` lists uncovered profiles and unclaimed artifacts as set operations, promotable from warning to gate. `sflow visual compare` produces a deterministic pixel diff (zero-dependency, honestly RGBA8-only) as evidence for the human decision — never an auto-verdict. The screenshot a reviewer approves is hash-bound into the record.

## Purpose and prerequisites

Use this topic when the current goal matches **visual verification**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow visual`. Run `singularity-flow visual --help` for the exact forms supported by this build.
- **Copilot:** `/sf-help` followed by the documented CLI fallback. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Visual Assurance**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

These commands can mutate governed or machine-local state: `visual`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain mcp-integration`, `sflow explain approvals`.
