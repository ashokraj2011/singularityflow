---
name: sflow-regression-investigate
description: Investigate a likely bug-causing change using Git ancestry, merge history, focused paths, diffs, and repository grounding.
disable-model-invocation: true

---

# Investigate a regression

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Ask for the last known-good revision if it is known, the bad revision (default `HEAD`), and any affected paths.
2. Run `singularity-flow regression analyze --base main [--good <REF>] [--bad <REF>] [--path <PATH>]... --json`.
3. Present the ranked candidate commits and merge commits. The ranking is triage evidence, not proof.
4. Inspect the top candidates with read-only Git commands such as `git show --stat <SHA>` and `git show <SHA> -- <PATH>`.
5. Use `singularity-flow wm knowledge show` (rules, journeys, tests) to explain which components, contracts, tests, and callers could be affected.
6. Form explicit hypotheses and distinguish observed facts from inference. Establish causation only with a reproducible failing test, a bisect performed with user consent, or equivalent evidence.
7. Do not checkout, bisect, revert, edit files, or change Git state unless the user separately asks for that action.
