---
name: sflow-refresh-branch
description: Safely refresh the checked-out Story or Epic branch from Git using fetch and fast-forward only.
disable-model-invocation: true

---

# Refresh the current branch

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting. On a refusal read `remediationPlan`: run its first read-only step once and follow `context.strategy`; never retry an unchanged condition or edit an earlier phase to clear it. One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. A bounded result names `agentOutput.read` ranges and `omittedFields` text files; read all in one response with your file tool, at the exact paths in the checkout's `.sflow/out/`. If a result comes back cut off, empty, still running or saved where you cannot open it, run `singularity-flow result last --wait --for-agent --json` and act on it; never rerun the command or point back to this skill, and never read the host's copy with shell tools. If a path SFlow returned fails to open, copy it again exactly from the result and open it once more; only then report it unopened, with the path and error.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`, or as is from a non-Git (chat) folder: SFlow finds the bound checkout; never refuse or wrap for it; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow refresh-branch --json` from the active repository.
2. Report whether the branch was already current, fast-forwarded, ahead, or diverged.
3. If it diverged, stop and show the exact message. Do not rebase, merge, reset, checkout another branch, or force-push automatically.
4. A dirty working tree is intentionally refused; never commit or stash it outside the governed flow. On a Story branch offer `/sf-recover`: it classifies the changes and returns their governed route (publication, set-aside or `commit-reviewed-worktree`). Elsewhere the contributor decides how to keep them. Then the person reruns `/sf-refresh-branch`.
5. This command refreshes only the branch already checked out; it never guesses or switches branches.
