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
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow recover $ARGUMENTS --fetch --json` without `--apply` and show the complete recovery plan, blocker evidence, exact file/line, preserved state, and `planId`.
2. Diagnosis is deterministic and model-free. Do not use a model to classify, clear, or reinterpret a blocker. AST absence is never a recovery blocker.
3. Stop when authored content must change, the tree is dirty, branches diverge, the remote is inaccessible, or the plan requires human authority. Open or name the exact evidence; never invent replacement content.
4. Ask for explicit confirmation of the exact `planId` before applying automatic actions.
5. Only then run `singularity-flow recover $ARGUMENTS --fetch --apply --confirm <planId>`. If the plan is stale, inspect again; never reuse the old hash.
6. Re-run the read-only inspection once after an applied action. Retry the original lifecycle command only when its blocker fingerprint changed.
7. Report retained commit, remote ref, fast-forward, pending-publication status, changed effects, and preserved work. Never reset, rebase, force-push, stash, discard work, edit authored artifacts, or grant approval authority.
