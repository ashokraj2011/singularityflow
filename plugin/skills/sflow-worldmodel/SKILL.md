---
name: sflow-worldmodel
description: Build, verify, inspect, and compose the repository-owned world model used to ground governed phase prompts.
disable-model-invocation: true

---

# World model

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

- **Bare `/sf-worldmodel` is read-only.** Run only `singularity-flow wm status --json` and `singularity-flow wm ast status --json`; show freshness, reuse location, assurance, binding, views, and blockers. Never infer build, initialization, warming, pack, cache, or local-publication consent.
- Offer configure, inventory, shared build, private rehearsal, inspect, recover, or AST. Before mutation show revision, views, depth, model routing, mode, and target; require confirmation.
- Configure/inventory: `wm init`; `wm light [--phase PHASE] [--local]`. `--local` is a private rehearsal and is not reusable from the shared state branch.
- Build: `singularity-flow wm build [--phase PHASE] [--task TEXT] [--views VIEW,...] [--depth light|quick|standard|deep] [--workers N]`; readiness: `wm availability ... --json`, `wm ensure ... --json`.
- Inspect: `wm check`; `wm context <PHASE> [--task TEXT] [--evidence]`; `wm compose [--phase ID] [--work-id ID] [--task TEXT] [--dry-run|--render-only]`.
- Recovery: `singularity-flow wm cleanup --json` removes stale, process-owned temporary worktrees (`--force` only on request); `wm recovery publish <ID> --confirm <ID>` reuses retained output without another model call.
- AST: `wm ast doctor|status --json`; bounded context uses `wm ast context --paths <ROOT> --max-facts 50 --max-output-bytes 32768 --json`; queries use `wm ast query --predicate ... --value ...` and its cursor. Preview pack install/remove and semantic warm before exact confirmation. Cache build resumes only by handle; prune needs `--dry-run`. Evidence uses `wm ast evidence reproduce --receipt <PATH> --json`.

No active Story is valid: use repository configuration or selected views; never invent phase scope. Shared builds follow `git.publish` and publish reusable state plus the current-branch projection. Never add `--local` unless requested. Never use `wm ensure` for a read or run competing builds. Report time, source hash, commit, views, staleness, degradation, and publication/reuse location.

Bundled polyglot facts are text-assurance leads, not semantic assurance. Semantic facts require a reviewed pack and complete project/toolchain binding. Missing AST degrades to ordinary bounded repository reads and never blocks lifecycle work. Required symbol gates apply only when syntax is explicitly required by policy. Default scope is the Story cone or changed paths; `--all` requires a request. Preview may read dirty bytes but cannot govern; recorded context requires committed in-cone objects.

For Copilot AST reads/replay, use `sflow_resolve` then its `sflow_read` handle. Gateway reads never fill cache. Publication retains inputs/toolchain; submission revalidates. Composition is additive; agents cannot remove required views or approve. Separate facts from assumptions.
