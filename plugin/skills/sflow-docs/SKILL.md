---
name: sflow-docs
description: Answer Singularity Flow questions from shipped topics.
disable-model-invocation: true
argument-hint: "[QUESTION | TOPIC]"

---
# Answer from the documentation, never from memory

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-gateway-tools -->
**SFlow tools:** When a step names an `sflow_*` call and that tool is in your tool list, make that call once, exactly as written, instead of the step's CLI command, and use its answer as the step says; each next action's routes there are its `fallback` (`copilotCommand`, `command`), with `modelFreeCommand` from the matching `data.guidance.actions` entry when one exists. A tool call checks pause itself (its `gateway.copilot-paused` refusal carries `data.paused`), so a turn that starts with one makes no separate pause check. If the tool is absent, errors or refuses for another reason, or its answer lacks a field the step reports, run the step's CLI command once and finish the step with it. Never call `sflow_run` here.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Pass the exact question or topic through the model-free resolver: call `sflow_explain` with `{"question": "$ARGUMENTS"}`, then `sflow_read` each handle in its `data.part.read` as `resolutionId` in the same response; its `data.body` and theirs, in part order, are `data.served.text`. Or run `singularity-flow explain '$ARGUMENTS' --json`, one single-quoted argument with each inner `'` as `'\''` (PowerShell `''`) so nothing expands. With no argument, run `singularity-flow explain --json` for the topic catalog. Do not map the question to a topic from model memory.
2. Read the served bytes from `data.served.text` and preserve `data.helpIntent`, provenance, and warnings.
3. Answer using that content. The substance of the reply must come from the served bytes — if the topic does not say it, do not say it.
4. End with the citation from `data.citation`, verbatim. It names the topic id, its version, and the docs commit.
5. If `explain` refuses with `explain.no-match`, say so and offer the nearest topic ids it returned. Do not answer the question from memory instead — a fluent wrong answer about governance is worse than none.
6. If the question is ambiguous between topics, present the returned choices. Do not pick one or blend their answers.
7. For "what should I do here", "should I escalate", or any decision, do not answer. Point to `singularity-flow nextsteps` for the deterministic action set, and to the human approval authorities the pinned configuration names.
8. When the reader wants repository context, first run `singularity-flow workspace current --json`.
   Only when it returns `repositoryPath`, use that exact cwd for `singularity-flow explain <topic>
   --here`; label the cited concept and revision-bound situation separately.
9. Do not generate, submit, approve, reject, upload, commit, or push anything.
