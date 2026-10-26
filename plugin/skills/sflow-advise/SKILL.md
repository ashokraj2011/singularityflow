---
name: sflow-advise
description: Guide unclear SFlow situations with grounded safe choices.
disable-model-invocation: true
argument-hint: "[QUESTION | ERROR | WHAT SHOULD I DO?]"
---

# Advise me when I am unsure

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-gateway-tools -->
**SFlow tools:** When a step names an `sflow_*` call and that tool is in your tool list, make that call once, exactly as written, instead of the step's CLI command, and use its answer as the step says; each next action's routes there are its `fallback` (`copilotCommand`, `command`), with `modelFreeCommand` from the matching `data.guidance.actions` entry when one exists. A tool call checks pause itself (its `gateway.copilot-paused` refusal carries `data.paused`), so a turn that starts with one makes no separate pause check. If the tool is absent, errors or refuses for another reason, or its answer lacks a field the step reports, run the step's CLI command once and finish the step with it. Never call `sflow_run` here.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Use this when the developer is confused, stuck, or does not know which SFlow route applies.

1. Resolve machine-local Home state first. An active Story and repository are optional; chat history is
   not lifecycle evidence, and an empty Home result is not permission to search for either.
2. With a question or error, run `singularity-flow home --json --request '$ARGUMENTS'`. With no argument, call `sflow_resolve` with `{"utterance": "what should I do next"}`, then `sflow_read` its one read handle (`next[0].handle`) as `resolutionId`, the read `recommend` makes; or run `singularity-flow recommend --json`. Always pass `$ARGUMENTS` as one single-quoted argument, each `'` inside written `'\''` (PowerShell `''`), never in double quotes, so no `$`, backtick or `$(...)` in it expands.
3. If the result is ambiguous or has no confident route, preserve every returned choice and ask the developer to select one. Never choose on their behalf.
4. When the question is about product behavior rather than current state, run `singularity-flow explain '$ARGUMENTS' --here --json` and cite the returned packaged topic. Do not answer product behavior from memory.
5. When the returned guidance recommends `singularity-flow workspace reinitialize`, present `/sf-admin reinitialize` as the Copilot route. Explain that it previews an exact workspace/repository scope and requires the returned plan ID before applying; do not run either command from this advisory skill and never substitute factory reset.
6. Only when Home returns an active Story and exact repository path, run `singularity-flow nextsteps <WORK-ID> --for-agent --json`
   there for an unexplained blocker. Run `singularity-flow doctor <WORK-ID>` only
   when guidance calls for repository diagnosis.
7. Present:
   - **What I found** — workspace, repository, Work ID, phase, and exact blocker or uncertainty.
   - **Why** — the evidence, refusal code, or cited rule that caused it.
   - **Safest next step** — one action, why it is preferred, and its `/sf-*` route.
   - **Other choices** — only genuine alternatives returned by SFlow.
   - **What changes** — always “Nothing yet” for this advisory skill.
8. Preserve warnings, unavailable reasons, revisions, and confirmations. Do not retry failures.
9. Never generate, submit, approve, reject, recover, reset, commit, push, or execute a suggestion. The developer must separately invoke its `/sf-*` skill.
