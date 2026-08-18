---
name: sflow-recover
description: Preview and explicitly apply safe publication or fast-forward recovery for a governed work item.
disable-model-invocation: true
argument-hint: "[WORK-ID]"
---
# Recover governed work safely

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.

1. Run `singularity-flow recover $ARGUMENTS --fetch` without `--apply` and show the complete recovery plan.
2. Stop when the tree is dirty, branches diverge, the remote is inaccessible, or the plan requires a human decision.
3. Ask for explicit confirmation before applying the exact reviewed plan.
4. Only then run the same command with `--apply`.
5. Report retained commit, remote ref, fast-forward, and pending-publication status. Never reset, rebase, force-push, stash, or discard work.

