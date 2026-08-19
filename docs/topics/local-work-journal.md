---
id: local-work-journal
title: Private local work journal
aliases:
  - journal
  - today
  - private-work-summary
commands:
  - journal
related:
  - developer-home
  - workspaces-and-sessions
  - resets-and-cleanup
  - recovery
version: 1
---
The local work journal gives My Work a small, private memory of outcomes and local repository facts. It lives outside Git worktrees, never synchronizes remotely, and is never governance evidence or a productivity score.

## Purpose and prerequisites

Use the journal to regain context after a break without relying on chat history. Select a governed workspace before reading or refreshing its day. `journal settings` and `journal doctor` work globally. The default `workspace-facts` mode retains 30 local calendar days.

## Use it from each surface

- **Shell:** use `sflow journal today`, `sflow journal refresh`, `sflow journal settings`, or `sflow journal doctor`.
- **Copilot:** invoke `/sf-journal`. The skill explains the local-only boundary and asks before settings changes, deletion, or export.
- **VS Code:** open **My Work**. Today and, when available, **Yesterday — where you stopped** read the same bounded daily projection and carry the **Stored locally · Never pushed** label.

## Guided workflow

1. Inspect capture and privacy with `sflow journal settings --json` and `sflow journal doctor --json`.
2. Run `sflow journal refresh --workspace <ID>` when you want one offline observation of the selected repository. Refresh reads local Git refs and worktree facts; it does not fetch or contact a remote.
3. Read `sflow journal today`. Use `--date YYYY-MM-DD` to inspect another retained local day.
4. Pause future capture with `sflow journal pause`; resume with `sflow journal resume`. Existing history is unchanged.
5. Export only a reviewed summary with `sflow journal export --date YYYY-MM-DD --format markdown --output <PATH>`. Use `--dry-run` before writing. Export inside a registered workspace is refused so the summary is not accidentally staged.
6. Delete one day with the date as its exact confirmation. Delete all history only with `--all --confirm "DELETE LOCAL JOURNAL"`.

Successful governed lifecycle commands also append a closed semantic outcome after the authoritative command has completed. Capture is deliberately outside the lifecycle transaction: if the private journal is unavailable, the governed command remains successful and is never retried or replayed. A new VS Code or Copilot host reads the same machine-local daily facts; it does not depend on the prior conversation.

## State and safety

Events use a closed allowlist and contain hashed workspace/repository identities, optional Work IDs, catalog summary codes, and bounded facts. They contain no prompt text, source bytes, commands, command output, credentials, raw interaction streams, duration, effort, attendance, or model ranking. Journal reads and retention open no network connection. Current governed records and Git state always override historical journal facts.

The journal cannot approve, publish, submit, advance, or prove work. Its remote wording describes only locally available remote-tracking evidence. Cross-machine continuation still comes from Git-visible commits and governed records.

## Troubleshooting

- If Today is empty, verify capture is not paused or off. Run `sflow journal refresh` for a fresh bounded Git observation; absence of journal events is not a claim that no work happened.
- If refresh refuses its location, move `SINGULARITY_FLOW_LOCAL_JOURNAL` outside every repository worktree.
- If doctor reports permissions or malformed records, pause capture and preserve the diagnostic; do not copy raw journal files into a repository.
- If the active workspace is wrong, use `sflow workspace list` and `sflow workspace use <ID>` before refreshing.
- If a remote state looks stale, use the governed synchronization command shown by Home. Journal refresh deliberately does not fetch.
- Deletion confirmations are mode-specific. A date cannot authorize all-history deletion, and the all-history phrase cannot authorize deleting another target.

## Related topics

Continue with `sflow explain developer-home`, `sflow explain workspaces-and-sessions`, `sflow explain resets-and-cleanup`, or `sflow explain recovery`.
