---
name: sflow-initiative-phase
description: Compose the governed GitHub Copilot prompt, author all configured outputs, and publish the active phase of a multi-repository Singularity Flow initiative.
disable-model-invocation: true
argument-hint: "[PHASE] [--initiative INIT-ID]"

---
# Generate an initiative phase

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Author configured artifacts from governed inputs and pinned clarification; publish only after readiness. Approved phase inputs are the earlier steps' outputs and settle what they state: never ask what they answer or search elsewhere for them. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow initiative status [INIT-ID] --json` and use only its current phase.
2. Run `singularity-flow initiative phase [PHASE] [--initiative INIT-ID]`. This prepares every configured output and records one governed Copilot prompt containing the exact phase contract, selected governed-agent prompt, required repository world-model views, active agent Markdown, and approved upstream initiative artifacts.
3. The Repository brief is guidance: never run a World Model check or rebuild, and never block the Initiative phase on it. Never substitute a Story phase for an Initiative phase.
4. Run `singularity-flow initiative context [PHASE] [--initiative INIT-ID]` and use the complete returned prompt. Do not generate from a summary or from filenames alone.
5. Run `singularity-flow initiative documents [PHASE] [--initiative INIT-ID]`. Preparation is not authoring: use the native file-edit tool to complete every existing required output, resolve TODOs, preserve managed metadata and satisfy the checklist. Never invent evidence.
6. Run `singularity-flow initiative phase draft-check [PHASE] [--initiative INIT-ID] --json`. If unready, act only on its `findings` and `correction`, rerun its `commands.recheck`, and keep repair in this phase. Correct every agent finding now from governed evidence only when ownership permits; otherwise route to its producer or human. Recheck up to three changed fingerprints and stop on an unchanged fingerprint. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer.
7. Only when `status` is `ready`, run the exact `singularity-flow initiative phase publish` action. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Never submit or approve.
8. Run `singularity-flow initiative documents [PHASE] [--initiative INIT-ID]` again. Summarize each output with a verified Markdown-preview link, generation and hash; never reproduce document bodies or code. Binary: path/bytes/hash. This is not human review.
9. Report the prompt snapshot, output hashes, generation commit, push result, checklist blockers, approval requirements, and the first result from `singularity-flow initiative next [INIT-ID] --json`. Do not approve automatically.
