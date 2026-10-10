---
name: sflow-worldmodel
description: Show the Repository brief phase prompts receive, read repository knowledge, and build or inspect registered World Model views where the repository turned them on.
disable-model-invocation: true
argument-hint: "[operation] [selectors]"

---

# World model

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

- **Bare `/sf-worldmodel` is read-only.** Run only `singularity-flow wm status --json` and `singularity-flow wm ast status --json`; report source, assurance, views, and blockers. Preserve `unavailable` and `current: null` exactly. Never infer mutation consent.
- **`registered: off` (default):** offer no build/refresh/migration; other commands refuse `WMB_REGISTERED_OFF`. Phases get the Repository brief: `singularity-flow wm brief --phase PHASE`.
- Explicit arguments select the exact `wm` operation, not status: `/sf-worldmodel compose --phase implementation` → `singularity-flow wm compose --phase implementation`. `--dry-run`/`--render-only` are read-only. Validate argv; reject shell chains/substitutions; unknown forms stop with help.
- Before mutation show revision/views/depth/routing/writes/target; confirm.
- `registered: on` refresh: review `singularity-flow wm plan`, then `singularity-flow wm build`. A build under `materialization.publish: local` is a private rehearsal and is not reusable from the shared state branch. A Story pinned to the removed legacy-v3 format cannot use the World Model: say so and suggest a new Story.
- Build: `singularity-flow wm build [--phase PHASE] [--views VIEW,...] [--depth quick|standard|deep]`. Readiness: `singularity-flow wm availability --json`.
- Knowledge (read-only): `singularity-flow wm knowledge show [overview|business|rules|journeys|tests|change]`.
- Inspect: `singularity-flow wm check`; `singularity-flow wm context <PHASE>`. Compose writes the phase prompt/receipt unless previewed, never rebuilds or approves. Relay its handoff; absent after compose, read `singularity-flow nextsteps --json`.
- Recovery: `singularity-flow wm cleanup --json` removes stale, process-owned temporary worktrees; `--force` only on request. `singularity-flow wm recovery publish <ID> --confirm <ID>` reuses retained output.
- AST: `singularity-flow wm ast doctor|status --json`, bounded `singularity-flow wm ast context --paths <ROOT> --max-facts 50 --max-output-bytes 32768 --json`, or `singularity-flow wm ast query`. Symbol gates require explicit syntax policy.
- FWM: `singularity-flow wm read-views`, `singularity-flow wm read-contract <VIEW>@<REVISION>`, `singularity-flow wm read <VIEW>`. Preserve provenance/unknowns; never `draft`.

No active Story is valid. Never invent scope, add `--local`, use ensure for reads, or run competing builds.

Reuse ready exact-source/scope snapshots. Never replace removed, stale, divergent, invalid, offline-unverified or different-source authority. Generate only on request.

Polyglot text facts need a reviewed pack for semantics. Missing AST uses bounded files. Dirty previews cannot govern. Reads: `sflow_resolve`, `sflow_read`; agents cannot remove required views or approve.
