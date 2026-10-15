---
name: sflow-regression-investigate
description: Investigate a likely bug-causing change using Git ancestry, merge history, focused paths, diffs, and repository grounding.
disable-model-invocation: true

---

# Investigate a regression

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. A bounded result lists `omittedFields` with exact line ranges in `agentOutput.path`; read only those you need with your file tool. Never stop because a result is long or was saved to a file.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Ask for the last known-good revision if it is known, the bad revision (default `HEAD`), and any affected paths.
2. Run `singularity-flow regression analyze --base main [--good <REF>] [--bad <REF>] [--path <PATH>]... --json`.
3. Present the ranked candidate commits and merge commits. The ranking is triage evidence, not proof.
4. Inspect the top candidates with read-only Git commands such as `git show --stat <SHA>` and `git show <SHA> -- <PATH>`.
5. Use `singularity-flow wm knowledge show` (rules, journeys, tests) to explain which components, contracts, tests, and callers could be affected.
6. Form explicit hypotheses and distinguish observed facts from inference. Establish causation only with a reproducible failing test, a bisect performed with user consent, or equivalent evidence.
7. Do not checkout, bisect, revert, edit files, or change Git state unless the user separately asks for that action.
