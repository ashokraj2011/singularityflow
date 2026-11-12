---
name: sflow-progress
description: Show how far a work item has got.
disable-model-invocation: true
agent: agent
argument-hint: "[WORK-ID]"

---
# Show workflow progress

<!-- sflow-copilot-pause -->
Read-only utility: run the requested read once with `--utility-entry --for-agent --json` (default `singularity-flow progress --utility-entry --for-agent --json`). Keep explicit Work IDs/filters; do not replace requested edits with a list. Eligible forms: status, progress, nextsteps, logs, agents list/mappings/status, workflow list, skill/instruction list/show without retained selectors. It checks pause before Git and returns verified `repositoryPath` plus `data`; no separate pause/session/workspace lookup or STATUS.md read. If paused, native Copilot; only offer `/sf-pause off`, never resume implicitly. Other forms: Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. Reads never authorize mutations; preserve later gates. If unsupported, stop with the compatibility error, never retry blindly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-gateway-tools -->
**SFlow tools:** When a step names an `sflow_*` call and that tool is in your tool list, make that call once, exactly as written, instead of the step's CLI command, and use its answer as the step says; each next action's routes there are its `fallback` (`copilotCommand`, `command`), with `modelFreeCommand` from the matching `data.guidance.actions` entry when one exists. A tool call checks pause itself (its `gateway.copilot-paused` refusal carries `data.paused`), so a turn that starts with one makes no separate pause check. If the tool is absent, errors or refuses for another reason, or its answer lacks a field the step reports, run the step's CLI command once and finish the step with it. Never call `sflow_run` here.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Use the Boundary repository. With an explicit Work ID, do not require or change the active Story. Without an ID, let the utility entry resolve the attached Story; never infer selection.
2. Call `sflow_resolve` with `{"utterance": "show story progress", "arguments": {"workId": "<WORK-ID>"}}` (no `arguments` when no ID was supplied), then `sflow_read` its one read handle (`next[0].handle`) as `resolutionId`, whose `data` is the command's `data`; or run `singularity-flow progress <WORK-ID> --utility-entry --for-agent --json` (omit the ID only when absent). Do not forward user-supplied formatting flags.
3. Render the returned `data` as a concise journey and phase table, preserving status, generation, approvals and tokens. Do not fetch Markdown or other documents for display.
4. Preserve the exact deterministic percentage and approved/total phase count. Never invent partial completion inside an unapproved phase.
5. Preserve `exact`, `partial`, `unavailable`, and `not recorded` token disclosures exactly as returned.
6. If the output shows a rejected or approval-pending phase, briefly call out that state after the table without guessing a decision or changing the next action.
7. Do not change files or lifecycle state.
