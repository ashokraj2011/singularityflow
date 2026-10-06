---
name: sflow-recover
description: Diagnose publication, artifact, projection, generation, branch, and transport blockers and explicitly apply only hash-bound safe recovery.
disable-model-invocation: true
argument-hint: "[WORK-ID]"
---
# Safe recovery

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** CLI validates/mutates; preserve exact results, warnings, publication status, artifacts/actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. `singularity-flow recover $ARGUMENTS --fetch --json` (`--phase <phase>` optional): retain `planId`; never inspect with `--apply`.
2. Follow action classifications, not blanket dirty-tree stops. `requiresRecovery: false`/no blockers: no gate. `current-phase-review-required`/`confirmation: none`: review diff, preserve validated preparation context and exactly declared phase evidence; continue draft checks. Unknown evidence remains review-required. Preserve untracked `.sflow/results/**`; tracked/staged reports and source require review. Stop for divergence/transport/authority. Diagnose `repair-publication-authority:<phase>`/`repair-generation-change-set:<phase>` before rollover; never waive.
3. Preserve generations/bytes/pins. Supported inference needs no proposal. `repair-repository-test-runner:<phase>` → `/sf-code`. Missing policy: preview `singularity-flow story test-policy amend <WORK-ID> --reason "<reason>" --json`; adopts an approved Story pin, not a config repair. Returned apply requires live human terminal review; type `Amend test command` at its prompt, or Enter to cancel. Never answer it yourself. Relay preparation/validation only. Approval refusal ends its turn; `/sf-reject` later for changed bytes. Post-commit telemetry/session are advisory.
4. Amendment acknowledgement requires explicit human choice. Author/reviewer conflict: preserve history; author publishes successor. Unlike hash domains do not imply staleness. Automatic: human-confirm `planId`, use `applyCommand`; guided/manual never use `--apply`. Reinspect stale plans.
5. `begin-new-generation:<phase>` requires `generation.intent.consumed-changed`, matching branch/phase, authenticated publication, no lifecycle/transport blocker. Inspect `git status --porcelain=v1 --untracked-files=all`, diffs/untracked content. `manual` `working-tree` requires human confirmation of owned, in-scope changes. Stop for protected, unrelated, unowned, conflicted, removed or symlink paths.
6. Preview `singularity-flow phase rollover <phase> --json`. Match work ID, phase, command and `confirmation` to recovery; re-inspect mismatches. Human-confirm then run `singularity-flow phase rollover <phase> --confirm <digest>` once. Never route to `/sf-code` before rollover succeeds.
7. Read test command argv/cwd, exit, stderr and report/guidance. Authorized dependency repair permits retry without republishing unchanged source; prove change. Use the open producer; `/sf-code` after rollover. Stop on unchanged conditions or three distinct repairs; relay recovery/risk route. Never submit/approve, reset, rebase, force-push, stash or discard. Integrity cannot be waived.

TRP: `singularity-flow explain test-recovery`; returned actions only. Exceptions need live delegated review. Never answer approval cards or claim failed/skipped/unavailable checks passed.
