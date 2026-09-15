---
name: sflow-submit
description: Validate and submit the active Singularity Flow phase for human approval, registering changed artifacts and running configured quality commands.
disable-model-invocation: true
argument-hint: "[--skip-checks only when explicitly authorized]"

---
# Submit the current phase

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

On `Out of sequence`, stop immediately. Show a `Soft sequence warning`; only the human may confirm it. Never edit managed state to bypass either gate.

1. Run `singularity-flow status <WORK-ID> --submission-readiness --json`. Require `resultType` exactly `sflow-submission-readiness`, `readiness.workId` equal to the session `workId`, and `readiness.phaseId` equal to `session.phase`. Read `lifecycleReady` only as the explicit boolean returned by this projection; never infer it from raw `status --json`, `phase show`, document labels, artifact status, `publicationProjections`, or a missing field. `publishedGeneration` equal to `currentGeneration` while `in_progress` is the normal ready-to-submit state, not a reason to publish again. If malformed or `lifecycleReady: false`, show `classification`, `reasonCode`, and `command`, then stop without preparing, regenerating, publishing, modifying files, or guessing.
2. When `confirmationRequired: true`, run only the returned Work-ID-pinned command and surface its complete soft-gate warning. Only the human may type or provide `continue`; never confirm it for them.
3. For `convergence`, never run generic `submit`. Run the returned `story advance` command without `--confirm`, show its review and digest, and stop on unresolved dispositions. Ask the human to confirm that digest; only then run its exact `--confirm sha256:<DIGEST>` command once. A changed digest requires fresh review.
4. Otherwise run the returned Work-ID-pinned submit command. Add `--skip-checks` only when explicitly authorized.
5. On validation failure, fix only current-phase artifacts or checks, register them, and retry.
6. After success run `singularity-flow phase show <phase> --json`. In the visible assistant response, reproduce every generated current-phase document (including downstream `agent-brief` documents) in full, with ID, kind, bytes, SHA-256, and `--- BEGIN <path> ---` / `--- END <path> ---`. A Shell/tool block does not satisfy artifact review. For binary/image artifacts, show the absolute path and metadata.
7. Fetch an omitted document with `singularity-flow documents view <DOCUMENT-ID> --json`. Never say “shown above” or substitute a summary; show them before offering approval or rejection.
8. Report the commit, push, hashes, checks, tokens, and cost. Approval remains a separate `/sf-approve` action.
