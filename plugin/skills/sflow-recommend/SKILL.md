---
name: sflow-recommend
description: Show one grounded next step from the active SFlow workspace.
disable-model-invocation: true

---

# Recommend one next step

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-gateway-tools -->
**SFlow tools:** When a step names an `sflow_*` call and that tool is in your tool list, make that call once, exactly as written, instead of the step's CLI command, and use its answer as the step says; each next action's routes there are its `fallback` (`copilotCommand`, `command`), with `modelFreeCommand` from the matching `data.guidance.actions` entry when one exists. A tool call checks pause itself (its `gateway.copilot-paused` refusal carries `data.paused`), so a turn that starts with one makes no separate pause check. If the tool is absent, errors or refuses for another reason, or its answer lacks a field the step reports, run the step's CLI command once and finish the step with it. Never call `sflow_run` here.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Use the durable workspace, work-item, evidence, and repository records. Never infer lifecycle state from chat history.

## Workflow

1. Call `sflow_resolve` with `{"utterance": "what should I do next"}`, then `sflow_read` its one
   read handle (`next[0].handle`) as `resolutionId`: the read `recommend` makes, with the same
   `data.guidance` and `data.personalization`; its secondary actions are `next[1..]`. Otherwise run
   `singularity-flow recommend --json` from machine context. Trust only the workspace, repository,
   and Story paths returned; do not search for missing context.
2. Read `data.guidance` from the returned envelope.
3. Address the developer by `data.personalization.replyName` when present.
4. Present the answer under these short headings:
   - **I found** — current workspace, work item, phase, and relevant evidence.
   - **Next** — the single recommended action and why it is next.
   - **I need from you** — only the inputs named in `requiredInputs`; omit this heading when empty.
   - **This will change** — effect, command, and preflight information when the action can mutate state.
5. Offer secondary actions only after the primary recommendation.

## Safety contract

- This skill is read-only. Do not execute the recommended command automatically.
- Preserve warnings, refusal codes, unavailable reasons, and recovery guidance exactly.
- Do not invent workspace, branch, work-item, evidence, approval, or publication state.
- If no governed context is available, relay the actionable empty state and suggest `/sf-workspace` or `/sf-doctor` only when the result does.
- A mutating follow-up requires the developer to invoke or explicitly confirm the corresponding `/sf-*` action.
