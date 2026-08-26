---
id: activity-and-prompt-audit
title: Activity logs, prompt audit, and operational trace
aliases:
  - logs
  - prompt-log
  - audit-log
commands:
  - logs
  - prompt-log
  - help-metrics
related:
  - evidence-and-ledger
  - telemetry-and-cost
  - copilot-and-surfaces
version: 4
---
Activity logs report lifecycle and operational events without exposing secrets. Prompt audit is optional, workspace-local evidence of composed governed prompts and does not replace lifecycle state.

## Purpose and prerequisites

Use this topic when the current goal matches **activity and prompt audit**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow logs`, `sflow prompt-log`, `sflow help-metrics status`. Run `singularity-flow logs --help` for the exact forms supported by this build.
- **Copilot:** `/sf-logs`, `/sf-prompt-log`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Flow Impact, Analytics, and Activity**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

`sflow prompt-log view latest` renders separate context, model execution, tool authorization,
token and cost, request/output, grounding, and prompt sections. `--raw` returns only the captured
prompt. Provider token totals remain `unavailable` when the host did not report them; the separate
prompt-only estimate is labelled `sflow-estimated`. Tool policy describes authorization and never
claims that an individual tool was called.

Prompt capture defaults to 30-day retention with a 64 MiB ceiling and uses private append-locked storage with a
machine-local HMAC chain. Configure it with `sflow prompt-log retention --retention-days <1..365>`.
Use `sflow prompt-log repair --confirm "REPAIR PROMPT AUDIT"` to quarantine malformed or unsafe
history and reseal valid records. Use `sflow prompt-log clear --confirm "DELETE PROMPT AUDIT"` to
permanently remove both active history and recovery copies.

Help-quality metrics are a different, content-free local record. They contain only the classified
intent, resolution outcome, topic, matching method, latency, answer size, surface, and selected
action category. They never contain the question, answer, path, Work ID, Git identity, or file
content. Inspect or control them with `sflow help-metrics status --json`, `sflow help-metrics on`,
`sflow help-metrics off`, and `sflow help-metrics clear`.

## State and safety

These commands can mutate governed or machine-local state: `prompt-log`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain evidence-and-ledger`, `sflow explain telemetry-and-cost`, `sflow explain copilot-and-surfaces`.
