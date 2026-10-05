---
name: sflow-explain-code
description: Explain current code changes, or what the whole repository holds, from deterministic records, with an optional advisory walkthrough of changes.
disable-model-invocation: true
argument-hint: "[--narrate] [--hunk H-ID | --symbol SYMBOL-ID | --clause CLAUSE-ID] [--since REVISION] | --repository [--path DIR-OR-FILE]"
---
# Explain current code changes, or the repository

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

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
