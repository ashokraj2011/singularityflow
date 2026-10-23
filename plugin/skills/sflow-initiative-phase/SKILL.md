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
**Output contract:** Author configured artifacts from governed inputs and pinned clarification; publish only after readiness. Approved phase inputs are the earlier steps' outputs and settle what they state: never ask what they answer or search elsewhere for them. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. When a result's `act.state` is `author`, or it routes back to this skill with nothing for a person to answer, edit, review or confirm, that is this turn's own work: do it, never relay it. A file edit that does not match is not a refusal: read the file again and redo the edit.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow initiative status [INIT-ID] --json` and use only its current phase.
2. Run `singularity-flow initiative phase [PHASE] [--initiative INIT-ID]`. This prepares every configured output and records one governed Copilot prompt containing the exact phase contract, selected governed-agent prompt, required repository world-model views, active agent Markdown, and approved upstream initiative artifacts.
3. The Repository brief is guidance: never run a World Model check or rebuild, and never block the Initiative phase on it. Never substitute a Story phase for an Initiative phase.
4. Run `singularity-flow initiative context [PHASE] [--initiative INIT-ID]` and use the complete returned prompt. Do not generate from a summary or from filenames alone.
5. Run `singularity-flow initiative documents [PHASE] [--initiative INIT-ID]`. Preparation is not authoring: use the native file-edit tool to complete every existing required output at the exact path step 2 or `draft-check` returned, resolve TODOs, preserve managed metadata and satisfy the checklist. Never invent evidence.
6. Run `singularity-flow initiative phase draft-check [PHASE] [--initiative INIT-ID] --json`. If unready, act only on its `findings` and `correction`, rerun its `commands.recheck`, and keep repair in this phase. Correct every agent finding now from governed evidence only when ownership permits; otherwise route to its producer or human. Recheck up to three changed fingerprints and stop on an unchanged fingerprint, relaying the actions of `singularity-flow initiative recover <INIT-ID> --json`. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer.
7. Only when `status` is `ready`, run the exact `singularity-flow initiative phase publish` action. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Never submit or approve.
8. Run `singularity-flow initiative documents [PHASE] [--initiative INIT-ID]` again. Summarize each output with a verified Markdown-preview link, generation and hash; never reproduce document bodies or code. Binary: path/bytes/hash. This is not human review.
9. Report the prompt snapshot, output hashes, generation commit, push result, checklist blockers, approval requirements, and the first result from `singularity-flow initiative next [INIT-ID] --for-agent --json`. Do not approve automatically.
