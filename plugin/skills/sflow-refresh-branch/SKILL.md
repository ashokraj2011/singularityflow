---
name: sflow-refresh-branch
description: Safely refresh the checked-out Story or Epic branch from Git using fetch and fast-forward only.
disable-model-invocation: true

---

# Refresh the current branch

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal or any stop, relay the returned route before ending: `remediationPlan` (run its first read-only step once and follow `context.strategy`), else `commandGuidance`, `nextAction`, `continuation.actions`, `recovery.actions` or `correction.skill`, in that order; with none, offer `/sf-nextsteps`. Never retry an unchanged condition or edit an earlier phase to clear it. One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. A bounded result lists `omittedFields` with exact line ranges in `agentOutput.path`; read only those you need with your file tool. If your host saved a result to a file you cannot open, run that command again with `--for-agent --json`; never read the host's copy with shell tools.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow refresh-branch --json` from the active repository.
2. Report whether the branch was already current, fast-forwarded, ahead, or diverged.
3. If it diverged, stop and show the exact message. Do not rebase, merge, reset, checkout another branch, or force-push automatically.
4. A dirty working tree is intentionally refused; never commit or stash it outside the governed flow. On a Story branch offer `/sf-recover`: it classifies the changes and returns their governed route (publication, set-aside or `commit-reviewed-worktree`). Elsewhere the contributor decides how to keep them. Then rerun `/sf-refresh-branch`.
5. This command refreshes only the branch already checked out; it never guesses or switches branches.
