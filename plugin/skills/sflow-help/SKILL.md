---
name: sflow-help
description: Answer questions about Singularity Flow and its workflow.
argument-hint: "[WORK-ID | TOPIC | QUESTION]"

---
# Load help or explain how to proceed

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

Packaged documentation can still be served when no workspace is registered; do not search the
filesystem for a repository in that case.

1. With no argument, run `singularity-flow explain --json` and show the topic index.
2. For a topic ID or an ordinary product question, run `singularity-flow explain "$ARGUMENTS" --json`. Relay only `data.served.text`, its citation/provenance, warnings, and related actions. Never answer product behavior from model memory.
3. The returned `data.helpIntent` is one of `concept`, `procedure`, `diagnose`, `compare`, `command-discovery`, or `recover`. Use it only to format the answer; it is not permission to execute a command.
4. When resolution is ambiguous, render the returned topic choices. When it is not found, say that the packaged documentation has no grounded answer and offer its nearest topics. Never choose the closest topic yourself.
5. For a question about why the active Story cannot advance, publish, or submit, run `singularity-flow home --json --request "$ARGUMENTS"` so the answer comes from current readiness state. For a product concept plus current context, run `singularity-flow explain "$ARGUMENTS" --here --json`.
6. For an explicit Work ID or a question about that work item's phase rail, run `singularity-flow guide <WORK-ID>` and state the selected workflow, source, ordered phases, required artifacts, agents, authorities, threshold, and exact recommended `/sf-*` action.
7. Preserve the documentation boundary, topic version, source commit, content digest, and any state revision. Treat `HELP.md` as the canonical product manual, but do not search it when a packaged cited topic answered the question.
8. Do not generate, submit, approve, reject, upload, commit, push, or execute a displayed command.
