---
name: sflow-submit
description: Validate and submit the active Singularity Flow phase for human approval, registering changed artifacts and running configured quality commands.
argument-hint: "[--skip-checks only when explicitly authorized]"
disable-model-invocation: true
---
# Submit the current phase

Sequence gates may be hard or soft. On `Out of sequence`, stop immediately and relay the error. On `Soft sequence warning`, show the full warning and leave the interactive `continue` decision to the human; never self-confirm. Use `singularity-flow nextsteps` only for read-only guidance and never edit managed state to bypass a gate.

1. Run `singularity-flow status --json` and confirm the current phase has a published generation and no pending synchronization.
2. Do not use `--skip-checks` unless explicitly authorized.
3. Run `singularity-flow submit <arguments>`.
4. If validation fails, fix only current-phase artifacts or checks, register again, and resubmit.
5. The command prints every generated current-phase document with its stable document ID, path, kind, byte count, SHA-256, and Markdown/text content. For binary or image artifacts, present the absolute path and metadata instead of dumping bytes.
6. If any registered document was not rendered, run `singularity-flow phase show <phase>` and then `singularity-flow documents view <DOCUMENT-ID>` for that item. Do not summarize away the documents: show them before offering approval or rejection.
7. Show the submission commit, push result, artifact hashes, token usage, and checks. Do not approve; approval is a separate `/sflow-approve` action.
