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
5. Show the submission commit, push result, artifact hashes, token usage, and checks. Do not approve; approval is a separate `/sflow-approve` action.
