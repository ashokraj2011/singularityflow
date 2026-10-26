---
name: sflow-regression-investigate
description: Investigate a likely bug-causing change using Git ancestry, merge history, focused paths, diffs, and repository grounding.
disable-model-invocation: true

---

# Investigate a regression

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Ask for the last known-good revision if it is known, the bad revision (default `HEAD`), and any affected paths.
2. Run `singularity-flow regression analyze --base <BASE> [--good <REF>] [--bad <REF>] [--path <PATH>]... --json`. `<BASE>` is a bound Story's recorded base (`executionContext.story.binding.baseRef` from `singularity-flow session current --for-agent --json`); without a Story, ask for the repository's default branch. Never assume `main`.
3. Present the ranked candidate commits and merge commits. The ranking is triage evidence, not proof.
4. Inspect the top candidates from the result: each one's `files`, `matchedPaths`, `added` and `deleted`; narrow to one with `singularity-flow regression analyze --base <BASE> --good <SHA>^ --bad <SHA> --path <PATH> --json`, and read its files with your file tool. This read-only turn runs no Git (its options can write files): for a line-level diff, give the person `git show <SHA> -- <PATH>` for their own terminal.
5. Use `singularity-flow wm knowledge show` (rules, journeys, tests) to explain which components, contracts, tests, and callers could be affected.
6. Form explicit hypotheses and distinguish observed facts from inference. Establish causation only with a reproducible failing test, a bisect performed with user consent, or equivalent evidence.
7. Do not checkout, bisect, revert, edit files, or change Git state unless the user separately asks for that action.
