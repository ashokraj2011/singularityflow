---
name: sflow-explain-code
description: Explain current code changes from deterministic records, with an optional advisory walkthrough.
disable-model-invocation: true
argument-hint: "[--narrate] [--hunk H-ID | --symbol SYMBOL-ID | --clause CLAUSE-ID] [--since REVISION]"
---
# Explain current code changes

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow session current --json`. Stop if `ready` is not true. Use only its `repositoryPath` as cwd.
2. Run exactly one command:
   - normally: `singularity-flow explain code $ARGUMENTS --json`;
   - when `$ARGUMENTS` already contains `--narrate`, use that same command unchanged;
   - only when the user explicitly asks for a narrative or walkthrough in prose and `$ARGUMENTS` does not contain
     `--narrate`: `singularity-flow explain code $ARGUMENTS --narrate --json`.
   Never run both forms in one invocation.
3. Relay the returned computed sections, availability reasons, stable IDs, authority labels, and next actions unchanged. For narration, preserve the exact `Narrative — advisory, not a record` banner and citation IDs.
4. Stop. Never read or summarize source files yourself, infer a missing cause or caller, call a criterion satisfied, store narrative as evidence, or perform any lifecycle mutation.
