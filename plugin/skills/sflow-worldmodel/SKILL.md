---
name: sflow-worldmodel
description: Build, verify, inspect, and compose the repository-owned world model used to ground governed phase prompts.
disable-model-invocation: true

---

# World model

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

- **Bare `/sf-worldmodel` is read-only.** Run only `singularity-flow wm status --json` and `singularity-flow wm ast status --json`; report freshness, reuse source, assurance, binding, views, and blockers. Never infer build, initialization, warming, pack, cache, or local-publication consent.
- Offer configure, inventory, build, inspect, recovery, or AST. Before mutation show revision, views, depth, model routing, writes, and target; require confirmation.
- Configure/inventory: `wm init`; `wm light [--phase PHASE] [--local]`. `--local` is a private rehearsal and is not reusable from the shared state branch.
- Build: `singularity-flow wm build [--phase PHASE] [--task TEXT] [--views VIEW,...] [--depth light|quick|standard|deep] [--workers N]`. Readiness: `wm availability ... --json`; explicit completion: the exact returned `wm ensure` command.
- Inspect: `wm check`; `wm context <PHASE> [--task TEXT] [--evidence]`; `wm compose [--phase ID] [--work-id ID] [--task TEXT] [--dry-run|--render-only]`.
- Recovery: `singularity-flow wm cleanup --json` removes stale, process-owned temporary worktrees; `--force` only on request. `wm recovery publish <ID> --confirm <ID>` reuses retained output without another model call.
- AST: inspect with `wm ast doctor|status --json`. Bound context with `wm ast context --paths <ROOT> --max-facts 50 --max-output-bytes 32768 --json`; query with `wm ast query` and its cursor. Preview packs/warm before confirmation; prune needs `--dry-run`. Required symbol gates apply only when syntax is explicitly required by policy.

No active Story is valid: use repository configuration or selected views. Never invent phase scope, add `--local`, use `wm ensure` for a read, or run competing builds. Report source, views, freshness, degradation, and reuse/publication location.

Reuse is mandatory. Consume a ready exact source/scope snapshot—including state history—without building. Ordinary ensure never upgrades light. Automation may create a proven-first-use zero-token light model on an existing state branch or add missing deterministic views to a valid same-source model; it never recreates removed/unpublished authority or replaces stale, divergent, invalid, offline-unverified, or different-source output. Offer ensure/build only when asked to refresh or upgrade.

Polyglot facts are text-assurance leads. Semantic assurance needs a reviewed pack and complete project/toolchain binding. Missing AST falls back to bounded file reads and never blocks lifecycle. Preview may read dirty bytes but cannot govern; recorded context needs committed in-scope objects. For Copilot AST reads use `sflow_resolve`, then `sflow_read`. Composition is additive; agents cannot remove required views or approve.
