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
**Output contract:** CLI validates/mutates; preserve exact results, warnings, publication status, artifacts/actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. `singularity-flow recover $ARGUMENTS --fetch --json` (`--phase <phase>` optional): retain `planId`; no `--apply` for inspection.
2. Follow action classifications, not blanket dirty-tree stops. `requiresRecovery: false`/no blockers: no gate. `current-phase-review-required`/`confirmation: none`: review diff, preserve validated preparation context and exactly declared phase evidence; continue draft checks. Preserve untracked `.sflow/results/**`; tracked/staged reports and source require review. Stop for divergence/transport/authority. Diagnose `repair-publication-authority:<phase>`/`repair-generation-change-set:<phase>` before rollover; never waive.
3. Preserve generations/bytes/pins. Supported inference needs no proposal. `repair-repository-test-runner:<phase>` → `/sf-code`. Missing policy: preview `singularity-flow story test-policy amend <WORK-ID> --reason "<reason>" --json`; adopts an approved Story pin, not a config repair. Returned apply requires live human terminal review; type `Amend test command` at its prompt, or Enter to cancel. Never answer it yourself. Relay preparation/validation only. Approval refusal ends its turn; `/sf-reject` later for changed bytes. Post-commit telemetry/session are advisory.
4. Amendment acknowledgement requires explicit human choice. Author/reviewer conflict: preserve history; author publishes successor. Unlike hash domains do not imply staleness. Automatic: human-confirm `planId`, use `applyCommand`; guided/manual never use `--apply`. Reinspect stale plans.
5. Review diffs/untracked bytes. `commit-reviewed-worktree`: offer returned command after human consent to exact `paths`/`planId`; never commit unlisted files or add `--allow-dirty`. Reports/other staged work stay preserved; no publication/approval/test waiver. Follow actions, revalidate source, refresh approval review/consent. Reinspect stale plans. Protected, unrelated, conflicted, removed/symlink paths stay separate.
6. `begin-new-generation:<phase>` needs matching branch/phase, authenticated changed publication, no lifecycle/transport blocker. Preview `singularity-flow phase rollover <phase> --json`; match identity/confirmation to recovery. Human-confirm then run returned command once. Never route to `/sf-code` before rollover succeeds.
7. Read argv/cwd, exit/stderr, report/guidance. Authorized dependency repair permits retry without republishing unchanged source; prove change. Use open producer; `/sf-code` after rollover. Stop on unchanged conditions or three distinct repairs; relay recovery/risk route. No submit/approve, reset, rebase, force-push, stash/discard. Integrity cannot be waived.

TRP: `singularity-flow explain test-recovery`; returned actions only. Live delegated review for exceptions. Never answer approval cards or mark failed/skipped/unavailable checks passed.
