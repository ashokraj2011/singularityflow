---
name: sflow-worldmodel
description: Show the Repository brief phase prompts receive and read repository knowledge, AST facts and composed prompts.
disable-model-invocation: true
argument-hint: "[operation] [selectors]"

---

# World Model

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

- **Bare `/sf-worldmodel` is read-only.** With an active Story run `singularity-flow wm brief --phase <current phase> --json` (what that phase prompt carries); without one run `singularity-flow wm knowledge show --json` and `singularity-flow wm ast status --json`. Report what is there and missing; never infer mutation consent.
- The World Model is the Repository brief: the rules that apply, contracts, flows, what the Story change touches and the risky places, read from the source with no build. It is guidance; nothing about it blocks.
- The registered World Model (published views, CALM, architecture intent) was removed; its old commands refuse with `WMB_REMOVED` or `COMMAND_REMOVED`. Relay that, point to the brief, never offer a build or migration.
- Explicit arguments select the exact `wm` operation: `/sf-worldmodel compose --phase implementation` → `singularity-flow wm compose --phase implementation`. `--dry-run`/`--render-only` are read-only. Validate argv; reject shell chains/substitutions; unknown forms stop with help.
- Knowledge (read-only, no model): `singularity-flow wm knowledge show [overview|business|rules|journeys|tests|change]`, `singularity-flow wm knowledge items`. `singularity-flow wm knowledge brief` and `singularity-flow wm knowledge explain <SYMBOL>` may call a model when model use is on: say so and confirm first.
- Knowledge reviews (`confirm|correct|reject`) write `docs/knowledge/confirmations.yml` in the working tree; show the change and confirm.
- Compose writes the phase prompt/receipt unless previewed, never approves. Relay its handoff; absent after compose, read `singularity-flow nextsteps --json`.
- AST: `singularity-flow wm ast doctor|status --json`, bounded `singularity-flow wm ast context --paths <ROOT> --max-facts 50 --max-output-bytes 32768 --json`, or `singularity-flow wm ast query`. Symbol gates require explicit syntax policy.
- FWM: `singularity-flow wm read-views`, `singularity-flow wm read-contract <VIEW>@<REVISION>`, `singularity-flow wm read <VIEW>`. Preserve provenance/unknowns; never `draft`.

No active Story is valid. Never invent scope or add `--local`.

Polyglot text facts need a reviewed pack for semantics. Missing AST uses bounded files. Dirty previews cannot govern. Reads: `sflow_resolve`, `sflow_read`.
