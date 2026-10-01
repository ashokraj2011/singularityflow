---
name: sflow-recover
description: Diagnose publication, artifact, projection, generation, branch, and transport blockers and explicitly apply only hash-bound safe recovery.
disable-model-invocation: true
argument-hint: "[WORK-ID]"
---
# Recover governed work safely

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow recover $ARGUMENTS --fetch --json` (optional `--phase <phase>`); show blockers/actions, preserved state and `planId`. Never inspect with `--apply`. Trust deterministic findings; missing AST is advisory.
2. Follow action classifications, not blanket dirty-tree stops. Owned in-phase authoring routes to its producer. Preserve untracked `.sflow/results/**` without cleaning; tracked/staged reports and source require review. Stop for divergence, remote failure or human authority. `repair-publication-authority:<phase>`/`repair-generation-change-set:<phase>` require their diagnostic before rollover; never waive them.
3. Preserve generations/bytes; never restart or repin. `repair-repository-test-runner:<phase>` permits in-scope runner repair via `/sf-code`; recheck recovery/prepublish. `resolve-code-delivery-test-policy:<phase>` is a malformed pin; Story edits/config refresh cannot fix it. Approval refusal ends its turn; use `/sf-reject` later for changed bytes. Post-commit telemetry/session failures are advisory.
4. For automatic actions, ask the user to confirm the exact `planId`. Only then run `singularity-flow recover $ARGUMENTS --fetch --apply --confirm <planId>`. A stale plan requires new inspection. This command never applies guided rollover.
5. Guided `begin-new-generation:<phase>` requires `generation.intent.consumed-changed`, current branch/phase, authenticated publication and no lifecycle/transport blocker. Inspect `git status --porcelain=v1 --untracked-files=all`, diffs and all untracked content, including README. `manual` `working-tree` requires human review/confirmation of owned, in-scope changes, not automatic refusal. Stop for protected, unrelated, unowned, conflicted, removed or symlink paths.
6. Preview with `singularity-flow phase rollover <phase> --json`. Compare work ID, phase, command and `confirmation` digest with fresh recovery. On mismatch, re-inspect. After user confirmation of exact digest, run the returned `singularity-flow phase rollover <phase> --confirm <digest>` once. Never route to `/sf-code` before rollover succeeds.
7. Reinspect `testExecution.commands`, even after publication. Use refused `requiredTestExecution`/saved logs for argv/cwd, exit, stderr, report and guidance. Authorized launcher/dependency repair permits retry without republishing unchanged source; prove the diagnosed environment changed. Source hashes alone cannot establish this. Open-intent authoring uses its producer; after rollover resume `/sf-code` when recovery clears. Stop on unchanged conditions or three distinct repairs. Never submit/approve, reset, rebase, force-push, stash or discard. Report effects/preserved state. Integrity cannot be risk-accepted; discretionary deviations require separate authorized records.
