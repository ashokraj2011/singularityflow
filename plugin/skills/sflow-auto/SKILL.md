---
name: sflow-auto
description: Plan, ratify, and control one bounded Singularity Flow Auto flight.
disable-model-invocation: true
argument-hint: "<requirement> | plan <requirement> | show-plan <PLAN-ID> | start <PLAN-ID> | list | status|report|pause|stop|halt|takeover|resume|discard <FLIGHT-ID>"

---
# Run bounded Auto work

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → verified `repositoryPath`, cwd=`repositoryPath`; never `$HOME`; no active Story is required.

Accept an explicit Auto subcommand or quoted-requirement shorthand. With no argument, show the forms and change nothing.

1. Run `singularity-flow workspace current --json`; require a verified `repositoryPath` and use it as cwd for every command. Never discover a repository from chat history, `$HOME`, or a filesystem search.
2. For `singularity-flow auto plan <requirement>` or `singularity-flow auto <requirement>`, require the exact requirement. Both are the same planning-only model operation and create no Story, branch, worktree, approval, or authorization. Preserve only supplied `--capability`, `--work-type`, `--work-id`, `--from-branch`, `--profile`, `--pace`, and `--until`. Run once and reproduce the Plan card, validation status, and ratification-packet SHA-256.
3. For `show-plan`, require the exact Plan ID and run `singularity-flow auto show-plan <PLAN-ID> --json`. It is read-only.
4. For `start`, first show the Plan. Explain that start creates the governed Story and may author until its declared human boundary. Require the contributor to type the complete ratification-packet SHA-256; never extract, prefill, shorten, or infer it from command output. Then run `singularity-flow auto start --plan <PLAN-ID> --confirm <PACKET-SHA256> --json` once.
5. For `list`, run `singularity-flow auto list --json`; it is read-only. For `status` or `report`, require the exact flight ID and run the corresponding read-only command with `--json`.
6. Pause is resumable; takeover proves quiescence and preserves the worktree for manual control; stop/halt is terminal but retains it; discard removes the worktree and only an unpublished local Story branch. Require the action and flight ID, then run exactly one of `singularity-flow auto pause <FLIGHT-ID> --json`, `singularity-flow auto takeover <FLIGHT-ID> --json`, or `singularity-flow auto stop <FLIGHT-ID> --json` (legacy `singularity-flow auto halt <FLIGHT-ID> --json`). Resume requires the typed complete checkpoint SHA-256 and runs `singularity-flow auto resume <FLIGHT-ID> --confirm <CHECKPOINT-SHA256> --json`. For discard, require the contributor to type the exact flight ID as confirmation, then run `singularity-flow auto discard <FLIGHT-ID> --confirm <FLIGHT-ID> --json`.
7. Never invoke `auto flight-step` directly, retry a failed authoring attempt, answer clarification, approve, reject, waive policy, expand scope, merge, deploy, or bypass a human boundary. Stop on any stale hash, policy refusal, provider failure, or Git publication failure and preserve the exact recovery action.
8. Report Plan/flight ID, status, Story and phase when present, isolated worktree, model/usage assurance, Git publication result, stop reason, checkpoint SHA-256, and the exact next command. Do not continue automatically.
