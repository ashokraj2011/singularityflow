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

1. `singularity-flow recover $ARGUMENTS --fetch --json` (`--phase <phase>` optional): blockers, preservation, `planId`; never inspect with `--apply`.
2. Follow action classifications, not blanket dirty-tree stops. `current-phase-review-required`/`confirmation: none`: review diff, preserve validated preparation context; continue draft checks. `applicationPaths`: open drafts recheck prepublish; published changes need rollover. Preserve untracked `.sflow/results/**`; tracked/staged reports and source require review. Stop for divergence, transport or authority. Diagnose `repair-publication-authority:<phase>`/`repair-generation-change-set:<phase>` before rollover; never waive.
3. Preserve generations/bytes/pins. `repair-repository-test-runner:<phase>` routes repair to `/sf-code`. For `resolve-code-delivery-test-policy:<phase>` or unavailable inference, preview `singularity-flow story test-policy amend <WORK-ID> --reason "<reason>" --json`. Returned apply requires live human terminal review. Relay preparation/validation only. Approval refusal ends its turn; `/sf-reject` later for changed bytes. Post-commit telemetry/session are advisory.
4. Amendment acknowledgement needs explicit human choice; never auto-acknowledge. Author/reviewer conflict: preserve history; author publishes successor. Unlike hash domains do not imply staleness. Automatic: human-confirm `planId`, use `applyCommand`; guided/manual never use `--apply`. Reinspect stale plans.
5. Guided `begin-new-generation:<phase>` requires `generation.intent.consumed-changed`, current branch/phase, authenticated publication and no lifecycle/transport blocker. Inspect `git status --porcelain=v1 --untracked-files=all`, diffs and untracked content. `manual` `working-tree` requires human confirmation of owned, in-scope changes. Stop for protected, unrelated, unowned, conflicted, removed or symlink paths.
6. Preview `singularity-flow phase rollover <phase> --json`. Match work ID, phase, command and `confirmation` to recovery; re-inspect mismatches. Human confirms the digest; run `singularity-flow phase rollover <phase> --confirm <digest>` once. Never route to `/sf-code` before rollover succeeds.
7. Read `testExecution.commands`/`requiredTestExecution`/logs: argv/cwd, exit, stderr, report/guidance. Authorized dependency repair permits retry without republishing unchanged source; prove change. Open authoring uses its producer; `/sf-code` after rollover. Stop on unchanged conditions or three distinct repairs; relay owner/prerequisite/risk route. Never submit/approve, reset, rebase, force-push, stash or discard. Report preservation. Integrity cannot be waived.

TRP: `singularity-flow explain test-recovery`; returned actions only. Exceptions need live delegated review. Never answer approval cards or claim failed/skipped/unavailable checks passed.
