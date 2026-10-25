---
name: sflow-help
description: Answer questions about Singularity Flow and its workflow.
disable-model-invocation: true
argument-hint: "[WORK-ID | TOPIC | QUESTION]"

---
# Load help or explain how to proceed

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-gateway-tools -->
**SFlow tools:** When a step names an `sflow_*` call and that tool is in your tool list, make that call once, exactly as written, instead of the step's CLI command, and use its answer as the step says; each next action's routes there are its `fallback` (`copilotCommand`, `command`), with `modelFreeCommand` from the matching `data.guidance.actions` entry when one exists. A tool call checks pause itself (its `gateway.copilot-paused` refusal carries `data.paused`), so a turn that starts with one makes no separate pause check. If the tool is absent, errors or refuses for another reason, or its answer lacks a field the step reports, run the step's CLI command once and finish the step with it. Never call `sflow_run` here.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Packaged documentation can still be served when no workspace is registered; do not search the
filesystem for a repository in that case.

1. With no argument, run `singularity-flow explain --json` and show the topic index.
2. For a topic ID or an ordinary product question, call `sflow_explain` with `{"question": "$ARGUMENTS"}`, then `sflow_read` each handle in its `data.part.read` as `resolutionId` in the same response; its `data.body` and theirs, in part order, are `data.served.text`. Or run `singularity-flow explain '$ARGUMENTS' --json`, one single-quoted argument with each inner `'` as `'\''` (PowerShell `''`) so nothing expands. Relay only `data.served.text`, its citation/provenance, warnings, and related actions. Never answer product behavior from model memory.
3. The returned `data.helpIntent` is one of `concept`, `procedure`, `diagnose`, `compare`, `command-discovery`, or `recover`. Use it only to format the answer; it is not permission to execute a command.
4. When resolution is ambiguous, render the returned topic choices. When it is not found, say that the packaged documentation has no grounded answer and offer its nearest topics. Never choose the closest topic yourself.
5. For a question about why active work cannot advance, run `singularity-flow home --json
   --request '$ARGUMENTS'`, quoted the same way. For repository context, first run `singularity-flow workspace current
   --json`; only when it returns `repositoryPath`, use that exact cwd for `explain --here`.
6. For an explicit Work ID or phase rail, first resolve that repository as above, then run
   `singularity-flow guide <WORK-ID>` there. State the workflow, source, phases, artifacts, agents,
   authorities, threshold, and exact recommended `/sf-*` action.
7. Preserve the documentation boundary, topic version, source commit, content digest, and any state revision. Treat `HELP.md` as the canonical product manual, but do not search it when a packaged cited topic answered the question.
8. Do not generate, submit, approve, reject, upload, commit, push, or execute a displayed command.
