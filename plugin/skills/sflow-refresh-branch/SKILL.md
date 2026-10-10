---
name: sflow-refresh-branch
description: Safely refresh the checked-out Story or Epic branch from Git using fetch and fast-forward only.
disable-model-invocation: true

---

# Refresh the current branch

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Run `singularity-flow refresh-branch --json` from the active repository.
2. Report whether the branch was already current, fast-forwarded, ahead, or diverged.
3. If it diverged, stop and show the exact message. Do not rebase, merge, reset, checkout another branch, or force-push automatically.
4. A dirty working tree is intentionally refused. Ask the contributor to commit or stash their work first.
5. This command refreshes only the branch already checked out; it never guesses or switches branches.
