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

1. Run `singularity-flow status <WORK-ID> --submission-readiness --json`. Require exact `resultType: sflow-submission-readiness`, matching work/phase IDs, `draftExists`, `draftModified`, `publicationRecorded`, `nextSkill`, and `nextCommand`. Trust only its explicit `lifecycleReady` boolean, not raw status or labels. Equal published/current generation while `in_progress` is ready; do not republish.
2. Generation zero means **Seeded draft — not published**. With `lifecycleReady: true`, say **Published generation <N> — ready to submit**. Otherwise disable Submit; for `classification: generation-required`, show only **Generate and publish <Phase>** using returned `nextSkill`, then stop. Never generate or publish from this skill.
3. For published specification/planning, run `singularity-flow review-source status <phase> --json`. `not-required` means no pinned review gate. If required but not `ready`, stop; show findings and route to Copilot `/sf-review-source <phase>` / Shell `singularity-flow review-source context <phase> --json`. Artifact corrections need a new publication; a reviewer report is not human approval.
4. When `confirmationRequired: true`, run only the returned Work-ID-pinned command and surface its complete soft-gate warning. Only the human may type or provide `continue`; never confirm it for them.
5. For `convergence`, never run generic `singularity-flow submit`. Run the returned `singularity-flow story advance` command without `--confirm`, show its review and digest, and stop on unresolved dispositions. Ask the human to confirm that digest; only then run its exact `--confirm sha256:<DIGEST>` command once. A changed digest requires fresh review.
6. Run the returned Work-ID-pinned submit command. Add `--skip-checks` only when authorized.
7. On failure, fix only current-phase artifacts/checks. Fingerprint the refusal code plus current artifact/check hashes. Stop on an unchanged fingerprint or after three distinct changed fingerprints. Never loop quality commands.
8. After success run `singularity-flow phase show <phase> --json`. Reproduce every current-phase document, including `agent-brief`, in the response with ID, kind, bytes, SHA-256, and `--- BEGIN <path> ---` / `--- END <path> ---`. Tool output alone is insufficient; show binary/image paths and metadata.
9. Fetch omissions with `singularity-flow documents view <DOCUMENT-ID> --json`. Never say “shown above” or summarize; show them before offering approval or rejection.
10. Report commit/push, hashes, checks, token/cost. Approval is separate `/sf-approve`.
