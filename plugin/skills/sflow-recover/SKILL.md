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

1. Run `singularity-flow recover $ARGUMENTS --fetch --json` (add `--phase <phase>` for phase recovery); show blockers, actions, paths, preserved state and `planId`. Never use `--apply` for inspection. Deterministic findings are authority; do not reinterpret them or treat missing AST as a blocker.
2. Stop for branch divergence, remote failure, required authoring or human authority. A dirty tree stops recovery except the reviewed rollover below. `repair-publication-authority:<phase>` and `repair-generation-change-set:<phase>` require the returned read-only diagnostic before another rollover; report their errors. Never waive them.
3. Keep phase repair in the returned phase, preserving published generations and authored bytes. Never restart the Story, change its pinned workflow, or invoke broad repair for a phase issue. An approval refusal ends its turn; use `/sf-reject` in a later turn if bytes must change. Treat telemetry or local-session refresh failures after commit as advisory.
4. For automatic actions, ask the user to confirm the exact `planId`. Only then run `singularity-flow recover $ARGUMENTS --fetch --apply --confirm <planId>`. A stale plan requires new inspection. This command never applies guided rollover.
5. For a guided `begin-new-generation:<phase>`, require `generation.intent.consumed-changed`, current branch/phase, authenticated prior publication, and no competing lifecycle or transport blocker. Inspect `git status --porcelain=v1 --untracked-files=all`, staged/unstaged diffs and untracked content for every path, including README. A `manual` `working-tree` action means path review is required, not automatic refusal: ask the user to confirm exact owned, in-scope changes. Stop for protected, unrelated, unowned, conflicted, removed or symlink paths.
6. Preview with `singularity-flow phase rollover <phase> --json`. Compare work ID, phase, command and `confirmation` digest with fresh recovery. On mismatch, re-inspect. After user confirmation of exact digest, run the returned `singularity-flow phase rollover <phase> --confirm <digest>` once. Never route to `/sf-code` before rollover succeeds.
7. Inspect phase recovery again. Resume `/sf-code` only when `requiresRecovery` is false; retry the original command only if its blocker changed. Do not submit or approve here. Report effects and preserved state. Published-generation integrity is not risk-acceptance eligible; discretionary deviations need a separate authorized record. Never reset, rebase, force-push, stash or discard work.
