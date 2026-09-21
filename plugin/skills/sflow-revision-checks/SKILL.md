---
name: sflow-revision-checks
description: Inspect and plan exact Candidate-bound browser checks without claiming test, publication, or lifecycle authority.
disable-model-invocation: true
argument-hint: "capabilities | plan | status [RUN-ID] | result <RUN-ID> | run <PLAN-SHA256>"
---

# Inspect guarded browser revision checks

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository.

1. For installed capability inspection, run only `singularity-flow revision checks capabilities --json`. This machine-local read does not require or select a Story, Candidate, command, runner, or browser.
2. For `plan`, `status`, or `result`, run `singularity-flow workspace current --json`, use only its verified `repositoryPath` as cwd, and require a ready Story session in that exact selected repository. Run respectively `singularity-flow revision checks plan --json`, `singularity-flow revision checks status [RUN-ID] --json`, or `singularity-flow revision checks result <RUN-ID> --json`. Never accept a caller-supplied executable, argv, URL, adapter, environment, Candidate, phase, or check definition.
3. A plan may select only the current retained REV Candidate and browser checks already registered by the approved active phase. Show its full plan digest, Candidate and phase bindings, check definition, supported effects, and runner availability. Planning is read-only and is not evidence that a browser ran.
4. Treat every missing, stale, failed, cancelled, timed-out, unavailable, or recovery-required state exactly as reported. A completed broker observation still establishes neither a passing repository test nor Testing/Verification, publication, approval, merge, deployment, or release authority unless the exact result explicitly proves otherwise; this build is expected to report those authorities as false.
5. Do not execute `singularity-flow revision checks run` from this skill. When the user explicitly asks to run an exact current plan, display `singularity-flow revision checks run --plan sha256:<PLAN> --confirm sha256:<PLAN> --json` for separate Shell review. The two values must be identical and supplied in full. The command must fail closed when no approved same-process runner can prove the fixed broker receipt; never substitute Playwright MCP, a package script, shell, Git, callback, model tool, or success claim.
6. Cancel, retry, and recovery are not public in this slice. Do not invent those commands. Read status/result after an uncertain outcome, and create a fresh exact plan only when the CLI reports that planning is legal. Never delete or rewrite a durable run record.
