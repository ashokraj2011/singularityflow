---
name: sflow-help
description: Answer questions about Singularity Flow and its workflow.
disable-model-invocation: true
argument-hint: "[WORK-ID | TOPIC | QUESTION]"

---
# Load help or explain how to proceed

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository.

Packaged documentation can still be served when no workspace is registered; do not search the
filesystem for a repository in that case.

1. With no argument, run `singularity-flow explain --json` and show the topic index.
2. For a topic ID or an ordinary product question, run `singularity-flow explain "$ARGUMENTS" --json`. Relay only `data.served.text`, its citation/provenance, warnings, and related actions. Never answer product behavior from model memory.
3. The returned `data.helpIntent` is one of `concept`, `procedure`, `diagnose`, `compare`, `command-discovery`, or `recover`. Use it only to format the answer; it is not permission to execute a command.
4. When resolution is ambiguous, render the returned topic choices. When it is not found, say that the packaged documentation has no grounded answer and offer its nearest topics. Never choose the closest topic yourself.
5. For a question about why active work cannot advance, run `singularity-flow home --json
   --request "$ARGUMENTS"`. For repository context, first run `singularity-flow workspace current
   --json`; only when it returns `repositoryPath`, use that exact cwd for `explain --here`.
6. For an explicit Work ID or phase rail, first resolve that repository as above, then run
   `singularity-flow guide <WORK-ID>` there. State the workflow, source, phases, artifacts, agents,
   authorities, threshold, and exact recommended `/sf-*` action.
7. Preserve the documentation boundary, topic version, source commit, content digest, and any state revision. Treat `HELP.md` as the canonical product manual, but do not search it when a packaged cited topic answered the question.
8. Do not generate, submit, approve, reject, upload, commit, push, or execute a displayed command.
