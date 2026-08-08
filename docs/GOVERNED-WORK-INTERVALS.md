# Governed work intervals

A governed work interval is the bounded period in which a Story phase may change repository source. It adds recovery and alignment checks without committing unfinished source and without requiring CI or Git-host workflow files.

## Lifecycle

1. **Baseline.** When a `source-and-artifact` phase opens or is prepared, Singularity Flow records the exact source commit, configuration/template hashes, protected paths, required checks, phase, and generation under the Story's committed `context/work-intervals/` directory.
2. **Checkpoint.** A contributor may record a local recovery fingerprint. The record contains paths, hashes, sizes, branch, and HEAD under `.git/singularity-flow/checkpoints/`. It contains no source bytes and creates no commit or push.
3. **Preview reconciliation.** A local report compares changed paths with clause claim maps and protected-path policy. It is read-only governed-state-wise and is stored under `.git/singularity-flow/reconciliations/`.
4. **Final reconciliation.** Submission repeats reconciliation against the same baseline. An eligible result is copied into committed Story context and included in the normal atomic submission publication. The interval stays `reconciled` while approval is pending and closes only when the approval threshold is reached (or an explicit deterministic no-approval policy applies).
5. **Escalation.** An over-broad or protected quick fix is blocked. The escalation command returns a non-destructive plan for a stronger configured workflow; it never changes the Story's immutable work type or discards branch history.

## Commands

```bash
singularity-flow story interval status
singularity-flow story interval checkpoint --name "before refactor" --note "tests pass locally"
singularity-flow story interval reconcile
singularity-flow story interval escalate --to feature

# Copilot skill
/sf-work-interval reconcile
```

`singularity-flow prepare <phase>` must run before source changes so the baseline cannot be invented at submission time. Rejection, reopening, and phase advancement open the next interval automatically. Final reconciliation is part of `singularity-flow submit <phase>` and therefore shares its lock, optimistic HEAD validation, commit, push, and pending-publication recovery.

## Local-first boundary

- No CI system is required.
- No `.github/workflows` or other Git-host automation is created.
- Checkpoints are deliberately machine-local and disposable.
- The baseline and final reconciliation are governed Git evidence.
- Git fast-forward rules remain the cross-machine concurrency authority.
