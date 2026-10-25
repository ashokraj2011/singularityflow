---
name: sflow-home
description: Guide explicitly requested Singularity Flow work through governed choices.
disable-model-invocation: true

---
# Singularity Flow home

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-gateway-tools -->
**SFlow tools:** When a step names an `sflow_*` call and that tool is in your tool list, make that call once, exactly as written, instead of the step's CLI command, and use its answer as the step says; each next action's routes there are its `fallback` (`copilotCommand`, `command`), with `modelFreeCommand` from the matching `data.guidance.actions` entry when one exists. A tool call checks pause itself (its `gateway.copilot-paused` refusal carries `data.paused`), so a turn that starts with one makes no separate pause check. If the tool is absent, errors or refuses for another reason, or its answer lacks a field the step reports, run the step's CLI command once and finish the step with it. Never call `sflow_run` here.

<!-- sflow-output-contract: conversational-guidance -->
**Output contract:** Resolve ordinary language through durable Home and Next projections; reads may run immediately, while every mutation requires an explicit governed choice. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Work/recovery; automatic invocation is not mutation consent.

Named workspace/Story skills override Home in every host syntax: `/sf-workspaces`, `/sf-workspace`, `/sf-stories`, `/sf-session` (also `sflow-*`). Never send their names to Home or replace tables with Home headings/refresh.

1. With a request, run `singularity-flow home --json --request '$ARGUMENTS'`, single-quoted with each inner `'` as `'\''` (PowerShell `''`) so nothing expands; otherwise call `sflow_resolve` with `{"utterance": "what should I do next"}`, then `sflow_read` its one read handle (`next[0].handle`) as `resolutionId`, whose `data` is the `data.home` below; or run `singularity-flow recommend --json`.
2. Use `data.home`/`data.conversation`, not chat memory; `data.home.repository`,
   `data.home.currentWork` and `data.home.personalization.replyName` exactly. Never say the repository is unresolved when it exists. Do not derive a name from email, login, input, or memory.
   Report `bootstrap` when no workspace exists; route `home:workspace.switch` through its fallback.
   Render projected `today`/`yesterday` as **Today**/**Yesterday — where you stopped**, labelled exactly
   “Stored locally · Never pushed”. Never reconstruct a day or equate missing events with no work.
3. Respond under exactly these headings:
   - **I found** — workspace, repository, Work ID, phase, freshness, warning; respect `repository`, `currentWork`, and `attentionWork`.
   - **Next** — the one routed read or proposed governed action, including its `/sf-*` route.
   - **I need from you** — nothing for a read; otherwise the exact required input or decision.
   - **This will change** — “Nothing” for reads; otherwise file, lifecycle, Git, publication, and external effects.
4. Intents are `orient`, `continue`, `start`, `inspect`, `act`, `recover`, and `help`. Help relays cited docs without executing commands. For `none` or `ambiguous` confidence, render returned choices and use `ask_user`; never guess.
5. Safe reads may run immediately. For `continue`, `start`, or `act`, show the proposal and use `ask_user`. Follow only the selected returned `fallback.skill`, including `/sf-stories`, `/sf-session`, `/sf-workspace`; choosers require an exact choice before selection or attachment.
6. Decisions, resets, destructive operations, and ceremonies require an explicit `/sf-*` invocation.
7. Keep warnings and action order. After a selected flow completes, run `singularity-flow home` except for chooser turns: keep their table/choices; no Home refresh.
8. “Catch me up”, “where did I stop?”, “yesterday”, and “what changed while I was away?” are reads.
   Route `/sf-work-interval` with the current Work ID; never answer from the prior Copilot turn.

Exact Home actions: `home:work.continue`, `home:work.list`, `home:work.return`,
`home:work.start.intake`, `home:workspace.switch`, `home:impact.quick`,
`home:repository.explore`, `home:help.explain`. Route only through returned `fallback.skill`.
