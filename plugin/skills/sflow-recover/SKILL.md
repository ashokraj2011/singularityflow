---
name: sflow-recover
description: Diagnose publication, artifact, projection, generation, branch, and transport blockers and explicitly apply only hash-bound safe recovery.
disable-model-invocation: true
argument-hint: "[WORK-ID]"
---
# Safe recovery

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** CLI validates/mutates; preserve exact results, warnings, publication status, artifacts/actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. `singularity-flow recover $ARGUMENTS --fetch --json`: retain `planId`; inspection never `--apply`.
2. Follow action classifications, not blanket dirty-tree stops. `requiresRecovery: false`/no blockers: no gate. `current-phase-review-required`/`confirmation: none`: review diff, preserve validated preparation context and exactly declared phase evidence; continue draft checks. Preserve untracked `.sflow/results/**`; tracked/staged reports and source require review. Stop for divergence/transport/authority. Diagnose `repair-publication-authority:<phase>`/`repair-generation-change-set:<phase>` before rollover; never waive.
3. Preserve bytes/pins/generations. `argvWithheld: true` needs no adoption; follow `testExecution.handoff`. Runner repair → `/sf-code`. Missing policy: `singularity-flow story test-policy amend <WORK-ID> --reason "<reason>" --json`: approved-pin adoption, not config repair. Live human review: `Amend test command` or Enter cancels; never answer. Approval refusal ends turn; `/sf-reject` later for changed bytes. Telemetry/session advisory.
4. Human amendment acknowledgement. Author/reviewer conflict needs successor, not history edits. Unlike hash domains are not staleness. Automatic: human-confirm `planId`, use `applyCommand`; guided/manual never `--apply`. Reinspect stale plans.
5. Review diffs/untracked bytes. `commit-reviewed-worktree`: human consent to exact `paths`/`planId`; returned command only, no unlisted files/`--allow-dirty`. Preserve reports/index; no gate waiver. Revalidate source/consent. Protected/unrelated/conflicted/removed/symlink paths stay separate.
   `review-evidence-contract`: preserve screenshot; returned `/sf-appeal` for plan-authority correction—not visual proof.
6. `begin-new-generation:<phase>` needs matching branch/phase, authenticated changed publication, no lifecycle/transport blocker. Preview `singularity-flow phase rollover <phase> --json`; match identity/confirmation to recovery. Human-confirm then run returned command once. Never route to `/sf-code` before rollover succeeds.
7. Read argv/cwd, exit/stderr, report/guidance. Proven authorized dependency repair permits retry without republishing unchanged source. `/sf-code` after rollover. Stop on unchanged conditions or three distinct repairs: automation only, not manual correction. Relay recovery/risk; no submit/approve, reset/rebase, force-push or stash/discard. Integrity cannot be waived.

TRP: `singularity-flow explain test-recovery`; returned actions only. Live review for exceptions. Never answer approval cards or label failed/skipped/unavailable passed.

Follow `resolution.issues[].choices`/`repairLoop.protocol`. Owned repair saves copies. `/sf-appeal`: preservation/eligible risks, live decisions—not approval/passes. Backup failure preserves originals; no cleaning.
