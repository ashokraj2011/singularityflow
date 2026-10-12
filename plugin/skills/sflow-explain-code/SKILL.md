---
name: sflow-explain-code
description: Explain current code changes, or what the whole repository holds, from deterministic records, with an optional advisory walkthrough of changes.
disable-model-invocation: true
argument-hint: "[--narrate] [--hunk H-ID | --symbol SYMBOL-ID | --clause CLAUSE-ID] [--since REVISION] | --repository [--path DIR-OR-FILE]"
---
# Explain current code changes, or the repository

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. In the Boundary repository, run exactly one explanation command:
   - normally: `singularity-flow explain code $ARGUMENTS --json`;
   - when `$ARGUMENTS` already contains `--narrate`, use that same command unchanged;
   - only when the user explicitly asks for a narrative or walkthrough in prose and `$ARGUMENTS` does not contain
     `--narrate` or `--repository`: `singularity-flow explain code $ARGUMENTS --narrate --json`.
   Never run both forms in one invocation. `--repository [--path DIR-OR-FILE]` explains what the repository (or
   one folder or file) holds instead of what changed; a repository over the AST budget answers with its folders,
   and the returned next actions name the `--path` to ask about next.
2. Relay the returned computed sections, availability reasons, stable IDs, authority labels, and next actions unchanged. For narration, preserve the exact `Narrative — advisory, not a record` banner and citation IDs.
3. Stop. Never read or summarize source files yourself, infer a missing cause or caller, call a criterion satisfied, store narrative as evidence, or perform any lifecycle mutation.
