---
name: submit
description: Validate and submit the active Singularity Flow phase for human approval, registering changed artifacts and running configured quality commands.
argument-hint: "[--skip-checks only when explicitly authorized]"
disable-model-invocation: true
---
# Submit the current phase

1. Run `singularity-flow status --json` and review the current phase, required artifact, and changed files.
2. Do not use `--skip-checks` unless explicitly authorized.
3. Run `singularity-flow submit <arguments>`.
4. If validation fails, fix only current-phase artifacts or checks, register again, and resubmit.
5. Show artifact and check results. Do not approve; approval is a separate `/singularity-flow:approve` action.
