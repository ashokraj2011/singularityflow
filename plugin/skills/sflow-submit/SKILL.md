---
name: sflow-submit
description: Validate and submit the active Singularity Flow phase for human approval, registering changed artifacts and running configured quality commands.
disable-model-invocation: true
argument-hint: "[--skip-checks only when explicitly authorized]"

---
# Submit

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show artifacts, hashes, warnings, and confirmation before a decision.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

`Out of sequence`: stop; humans confirm soft warnings.

1. Run `singularity-flow status <WORK-ID> --submission-readiness --json`. Require `resultType: sflow-submission-readiness`, matching work/phase IDs, `draftExists`, `draftModified`, `publicationRecorded`, `nextSkill`, `nextCommand`. Trust `lifecycleReady`, not labels. Equal published/current generation while `in_progress` is ready; do not republish.
2. Generation zero means **Seeded draft — not published**. With `lifecycleReady: true`, say **Published generation <N> — ready to submit**. Otherwise disable Submit; for `classification: generation-required`, show only **Generate and publish <Phase>** using returned `nextSkill`, then stop. Never generate or publish from this skill.
3. For specification/planning, run `singularity-flow review-source status <phase> --json`. Unless `not-required` or `ready`, stop, show findings and route to `/sf-review-source <phase>` / `singularity-flow review-source context <phase> --json`. Corrections need new publication; reviewer reports are not human approval.
4. When `confirmationRequired: true`, use only the returned Work-ID-pinned command; show its full warning. Only the human provides `continue`.
5. For `convergence`, never run generic `singularity-flow submit`. Run returned `singularity-flow story advance` without `--confirm`; show review/digest and stop on unresolved dispositions. After human confirmation run its exact `--confirm sha256:<DIGEST>` once. Changed digest requires fresh review.
6. Run the returned Work-ID-pinned submit command. Add `--skip-checks` only when authorized.
7. On failure show `requiredTestExecution` argv/cwd, exit, bounded stderr/report and guidance. Nonzero exit fails despite passing JUnit. Use `/sf-recover`: authorized environment repair permits retry without republishing unchanged source; changed source/artifacts need reviewed rollover and producer publication. Preserve untracked `.sflow/results/**`; tracked/staged changes require review. Fingerprint refusal plus artifact/check hashes and diagnosed runtime evidence. Stop on an unchanged condition or after three distinct repairs. Never loop quality commands or waive tests/integrity/policy.
8. Run `singularity-flow phase show <phase> --json` after success; retain `reviewBinding`. Reproduce every current-phase document/`agent-brief` in the response: ID/kind/path/bytes/generation/SHA-256, `--- BEGIN <path> ---` / `--- END <path> ---`. Tool output alone is insufficient. Binary: path/metadata.
9. Fetch omissions: `singularity-flow documents view <DOCUMENT-ID> --json`; show them before offering approval or rejection. No truncation/summaries.
10. Report commit/push, hashes/checks/cost; offer `/sf-approve <PHASE-ID> --work-id <WORK-ID>` with actual IDs; never approve.

TRP: read and follow `singularity-flow explain test-recovery`; returned legal actions only.
