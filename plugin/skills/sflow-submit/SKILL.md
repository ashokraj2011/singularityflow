---
name: sflow-submit
description: Validate and submit the active Singularity Flow phase for human approval, registering changed artifacts and running configured quality commands.
disable-model-invocation: true
argument-hint: "[--skip-checks only when explicitly authorized]"

---
# Submit the current phase

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show artifacts, hashes, warnings, and confirmation before a decision.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

Stop on `Out of sequence`. Show soft warnings; only the human confirms them. Never edit state to bypass gates.

1. Run `singularity-flow status <WORK-ID> --submission-readiness --json`. Require `resultType` exactly `sflow-submission-readiness`, matching `workId`/`phaseId`, plus `draftExists`, `draftModified`, `publicationRecorded`, `nextSkill`, and `nextCommand`. Read `lifecycleReady` only as the explicit boolean returned by this projection; never infer it from raw `singularity-flow status --json`, labels, or missing fields. `publishedGeneration` equal to `currentGeneration` while `in_progress` is the normal ready-to-submit state; do not republish.
2. An existing generation-zero draft is **Seeded draft — not published**, never a generated artifact. With `lifecycleReady: true`, say **Published generation <N> — ready to submit**, never `publish-ready`. Otherwise disable Submit. For `classification: generation-required`, show exactly one primary action, **Generate and publish <Phase>**, prefilling the engine-selected `nextSkill`; do not also offer Submit. Never invoke the generation skill from this submission skill. Then stop without preparing, regenerating, publishing, modifying files, or guessing.
3. When `confirmationRequired: true`, run only the returned Work-ID-pinned command and surface its complete soft-gate warning. Only the human may type or provide `continue`; never confirm it for them.
4. For `convergence`, never run generic `singularity-flow submit`. Run the returned `singularity-flow story advance` command without `--confirm`, show its review and digest, and stop on unresolved dispositions. Ask the human to confirm that digest; only then run its exact `--confirm sha256:<DIGEST>` command once. A changed digest requires fresh review.
5. Run the returned Work-ID-pinned submit command. Add `--skip-checks` only when authorized.
6. On validation failure, fix only current-phase artifacts or checks and register them. Fingerprint the refusal code plus current artifact/check hashes; retry only while that fingerprint changes. Stop on an unchanged fingerprint or after three distinct changed fingerprints. Never loop quality commands.
7. After success run `singularity-flow phase show <phase> --json`. In the visible assistant response, reproduce every generated current-phase document, including `agent-brief`, in full with ID, kind, bytes, SHA-256, and `--- BEGIN <path> ---` / `--- END <path> ---`. A Shell/tool block does not satisfy artifact review. Show binary/image paths and metadata.
8. Fetch omissions with `singularity-flow documents view <DOCUMENT-ID> --json`. Never say “shown above” or summarize; show them before offering approval or rejection.
9. Report commit/push, hashes, checks, token/cost. Approval is separate `/sf-approve`.
