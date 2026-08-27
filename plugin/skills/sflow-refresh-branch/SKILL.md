---
name: sflow-refresh-branch
description: Safely refresh the checked-out Story or Epic branch from Git using fetch and fast-forward only.
disable-model-invocation: true

---

# Refresh the current branch

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow refresh-branch --json` from the active repository.
2. Report whether the branch was already current, fast-forwarded, ahead, or diverged.
3. If it diverged, stop and show the exact message. Do not rebase, merge, reset, checkout another branch, or force-push automatically.
4. A dirty working tree is intentionally refused. Ask the contributor to commit or stash their work first.
5. This command refreshes only the branch already checked out; it never guesses or switches branches.
