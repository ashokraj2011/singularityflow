---
name: sflow-approve
description: Interactively select a persona and approve a submitted Singularity Flow phase from any terminal, recording identity, persona, self-approval warning, hashes, commit, and push.
argument-hint: "[WORK-ID] [--fetch]"
disable-model-invocation: true
---
# Approve the submitted phase

Sequence gates may be hard or soft. On `Out of sequence`, stop immediately and relay the error. On `Soft sequence warning`, show the full warning and leave the interactive `continue` decision to the human; never self-confirm. Use `singularity-flow nextsteps` only for read-only guidance and never edit managed state to bypass a gate.

Anyone may choose any persona, but the chosen persona must be configured to approve the phase.

1. Run `singularity-flow approve <WORK-ID> --fetch` in a persistent interactive shell; omit the ID only when already on its branch.
2. When the CLI prints `Choose persona`, call Copilot's `ask_user` tool with the displayed approval-capable persona labels, IDs, and descriptions as selectable options. Never infer or preselect one.
3. Map the selected ID to the displayed number and send that number plus a newline to the same shell process with `write_bash`. Do not pass a persona flag, set a selection environment variable, or edit the session file. If `ask_user` is unavailable or disabled, stop and ask the reviewer to run the command directly in their terminal.
4. Show the phase, artifacts, hashes, checks, token usage, prior decisions, and whether this identity generated the phase.
5. Require the reviewer to type the exact phase name for final confirmation; selection UI must not weaken this deliberate approval control. Self-approval is allowed but must remain visibly warned and must never be described as independent review.
6. The CLI commits and pushes the decision and advances only after the distinct-identity threshold is met.
7. Report the decision commit, persona, self-approval status, remaining approvals, and next phase. Do not merge, deploy, or modify Jira.
