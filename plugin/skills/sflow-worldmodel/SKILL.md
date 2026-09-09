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

- **Bare `/sf-worldmodel` is read-only.** Run only `singularity-flow wm status --json` and `singularity-flow wm ast status --json`; report freshness, source, assurance, views, and blockers. Never infer build, initialization, warming, pack, cache, or local-publication consent.
- Before mutation show revision, views, depth, routing, writes, and target; require confirmation.
- Configure/inventory: `wm init`; `wm light [--phase PHASE] [--local]`. `--local` is a private rehearsal and is not reusable from the shared state branch.
- Build: `singularity-flow wm build [--phase PHASE] [--views VIEW,...] [--depth light|quick|standard|deep] [--workers N]`. Check readiness with `wm availability --json`.
- Inspect: `wm check`; `wm context <PHASE>`; `wm compose [--phase ID] [--work-id ID] [--dry-run|--render-only]`.
- Recovery: `singularity-flow wm cleanup --json` removes stale, process-owned temporary worktrees; `--force` only on request. `wm recovery publish <ID> --confirm <ID>` reuses retained output.
- AST: inspect with `wm ast doctor|status --json`; read with `wm ast context --paths <ROOT> --max-facts 50 --max-output-bytes 32768 --json` or `wm ast query`. Required symbol gates apply only when syntax is explicitly required by policy.
- FWM reads are model-free: `wm read-views`; `wm read-contract <VIEW>@<REVISION>`; `wm read <VIEW>`. Preserve provenance, coverage, status, and continuation. Never execute `draft` or turn `unknown` into absence.

No active Story is valid: use repository configuration or selected views. Never invent phase scope, add `--local`, use `wm ensure` for a read, or run competing builds. Report source, views, freshness, degradation, and reuse/publication location.

Reuse is mandatory. Consume a ready exact-source/scope snapshot. Ordinary ensure never upgrades light. Automation may create a first-use zero-token light model or add deterministic views to a valid same-source model; it never replaces removed, stale, divergent, invalid, offline-unverified, or different-source authority. Offer generation only when asked.

Polyglot facts are text-assurance leads. Semantic assurance needs a reviewed pack and complete binding. Missing AST falls back to bounded files and never blocks lifecycle. Dirty-byte preview cannot govern. For Copilot reads use `sflow_resolve`, then `sflow_read`. Composition is additive; agents cannot remove required views or approve.
