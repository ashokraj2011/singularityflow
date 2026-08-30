---
name: sflow-auto
description: Plan, ratify, and control one bounded Singularity Flow Auto flight.
disable-model-invocation: true
argument-hint: "plan <requirement> | show-plan <PLAN-ID> | start <PLAN-ID> | status|report|pause|halt|resume|discard <FLIGHT-ID>"

---
# Run bounded Auto work

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → verified `repositoryPath`, cwd=`repositoryPath`; never `$HOME`; no active Story is required.

Use only an explicit Auto subcommand. With no subcommand, show the supported forms and change nothing.

1. Run `singularity-flow workspace current --json`; require a verified `repositoryPath` and use it as cwd for every command. Never discover a repository from chat history, `$HOME`, or a filesystem search.
2. For `plan`, require the contributor's exact requirement. Explain that `singularity-flow auto plan "<REQUIREMENT>" --json` may invoke the configured model and consume provider resources, but creates no Story, branch, worktree, approval, or authorization. Preserve only contributor-supplied `--capability`, `--work-type`, `--work-id`, `--from-branch`, `--pace`, and `--until` values; never invent them. Run once and reproduce the complete Plan card, including assumptions, unresolved decisions, safety reasons, expiry, and full Plan SHA-256.
3. For `show-plan`, require the exact Plan ID and run `singularity-flow auto show-plan <PLAN-ID> --json`. It is read-only.
4. For `start`, first show the Plan. Explain that start creates the governed Story and may author until its declared human boundary. Require the contributor to type the complete Plan SHA-256; never extract, prefill, shorten, or infer it from command output. Then run `singularity-flow auto start <PLAN-ID> --confirm <PLAN-SHA256> --json` once.
5. For `status` or `report`, require the exact flight ID and run the corresponding read-only command with `--json`.
6. Before mutation, explain: pause is resumable; halt is terminal and requires a replacement Plan while retaining its worktree; discard force-removes the managed worktree and removes only an unpublished local Story branch, never a published remote. Require the exact action and flight ID. Run `singularity-flow auto pause <FLIGHT-ID> --json` or `singularity-flow auto halt <FLIGHT-ID> --json` once. For `resume`, show status, require the typed complete checkpoint SHA-256, then run `singularity-flow auto resume <FLIGHT-ID> --confirm <CHECKPOINT-SHA256> --json`. For `discard`, require the contributor to type the exact flight ID as confirmation, then run `singularity-flow auto discard <FLIGHT-ID> --confirm <FLIGHT-ID> --json`.
7. Never invoke `auto flight-step` directly, retry a failed authoring attempt, answer clarification, approve, reject, waive policy, expand scope, merge, deploy, or bypass a human boundary. Stop on any stale hash, policy refusal, provider failure, or Git publication failure and preserve the exact recovery action.
8. Report Plan/flight ID, status, Story and phase when present, isolated worktree, model/usage assurance, Git publication result, stop reason, checkpoint SHA-256, and the exact next command. Do not continue automatically.
