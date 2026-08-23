---
name: sflow-regression-investigate
description: Investigate a likely bug-causing change using Git ancestry, merge history, focused paths, diffs, and repository grounding.
disable-model-invocation: true

---

# Investigate a regression

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

1. Ask for the last known-good revision if it is known, the bad revision (default `HEAD`), and any affected paths.
2. Run `singularity-flow regression analyze --base main [--good <REF>] [--bad <REF>] [--path <PATH>]... --json`.
3. Present the ranked candidate commits and merge commits. The ranking is triage evidence, not proof.
4. Inspect the top candidates with read-only Git commands such as `git show --stat <SHA>` and `git show <SHA> -- <PATH>`.
5. When a repository world model exists, use its architecture, development, and testing views to explain which components, contracts, tests, and callers could be affected.
6. Form explicit hypotheses and distinguish observed facts from inference. Establish causation only with a reproducible failing test, a bisect performed with user consent, or equivalent evidence.
7. Do not checkout, bisect, revert, edit files, or change Git state unless the user separately asks for that action.
