---
name: sflow-submit
description: Validate and submit the active Singularity Flow phase for human approval, registering changed artifacts and running configured quality commands.
disable-model-invocation: true
argument-hint: "[--skip-checks only when explicitly authorized]"

---
# Submit

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show artifacts, hashes, warnings, and confirmation before a decision. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

`Out of sequence`: stop; humans confirm soft warnings.

1. Run `singularity-flow status <WORK-ID> --submission-readiness --json`; require matching work/phase and its readiness fields. Trust `lifecycleReady`; never republish. For `terminal-obligations-required`, relay blockers/actions and stop—no submit or generic recovery.
2. Generation zero: **Seeded draft — not published**. `lifecycleReady: true`: **Published generation <N> — ready to submit**. Otherwise disable Submit; `classification: generation-required`: **Generate and publish <Phase>**, returned `nextSkill`, stop. Never generate/publish here.
3. Pinned review-required routes, including copies or renamed steps: `singularity-flow review-source status <phase> --json`; unless `not-required`/`ready`, relay findings and exact recovery/review actions. Reviewer reports are not approval. Pending amendment acknowledgement requires the person's explicit choice.
4. `confirmationRequired: true`: show full warning and returned Work-ID-pinned command; human provides `continue`.
5. Convergence: never generic `singularity-flow submit`. Run returned `singularity-flow story advance` without `--confirm`; show review/digest, stop on unresolved dispositions. Human confirms exact `--confirm sha256:<DIGEST>` once. Changed digest requires fresh review.
6. Run returned Work-ID-pinned submit command. `--skip-checks` requires authorization.
7. On failure, fingerprint refusal plus artifact/check hashes and diagnosed runtime evidence. Nonzero exit fails despite passing JUnit. Proven environment repair permits retry without republishing unchanged source; changed source/artifacts need reviewed rollover. Stop on an unchanged condition or after three distinct repairs. Never loop quality commands or waive tests/integrity/policy. `/sf-recover` never substitutes for terminal decisions.
8. Run `singularity-flow phase show <phase> --json`. Reuse complete same-chat bodies only for the identical non-null `displayBinding`; always show the fresh `reviewBinding`, checks and warnings. Otherwise render every document/brief with identity, hash and boundaries. Summaries are not review.
9. New/changed/null bindings, omissions or truncation require full display; incomplete review cannot offer approval.
10. Report commit/push/hashes/checks/cost; offer `/sf-approve <PHASE-ID> --work-id <WORK-ID>` with real IDs; never approve.

TRP: follow `singularity-flow explain test-recovery`.
