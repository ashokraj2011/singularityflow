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
5. After submission, always run `singularity-flow phase show <phase> --json`; do not rely on the lifecycle command's Shell output. Reproduce every generated current-phase document: in the visible assistant response, put each returned text document in full between `--- BEGIN <path> ---` and `--- END <path> ---`, preceded by its stable document ID, kind, byte count, and SHA-256. A Shell/tool block, even when it contains the text, is collapsible and does not satisfy artifact review. For binary or image artifacts, present the absolute path and metadata instead of dumping bytes.
6. If any registered document is absent from that result, run `singularity-flow documents view <DOCUMENT-ID> --json` and reproduce it using the same protocol. Never say “shown above,” “rendered above,” or “documents shown,” and never replace the generated documents with a summary; show them before offering approval or rejection.
7. Show the submission commit, push result, artifact hashes, token usage, and checks. Do not approve; approval is a separate `/sflow-approve` action.
