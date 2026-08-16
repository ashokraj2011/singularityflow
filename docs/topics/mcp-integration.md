---
id: mcp-integration
title: MCP integration
version: 3
aliases:
  - mcp
  - playwright
  - github-mcp
  - figma
commands:
  - mcp
related:
  - visual-verification
  - configuration
---
MCP setup has two layers. VS Code or Copilot owns the server process, transport,
credentials and trust prompt. Flow owns the repository policy: `mcpServers` in
`workflow.yml` declares which governed agents, phases and exact tools may use the
host server, with what approval and evidence capture. The host server ID and Flow
`hostReference` must match. Flow never stores MCP credentials or silently starts a
server from read-only commands.

## Purpose and prerequisites

Use this topic when the current goal matches **mcp integration**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow mcp`. Run `singularity-flow mcp --help` for the exact forms supported by this build.
- **Copilot:** `/sf-mcp`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Configuration Center**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

These commands can mutate governed or machine-local state: `mcp`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain visual-verification`, `sflow explain configuration`.
