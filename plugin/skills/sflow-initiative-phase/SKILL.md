---
name: sflow-initiative-phase
description: Compose the governed GitHub Copilot prompt, author all configured outputs, and publish the active phase of a multi-repository Singularity Flow initiative.
disable-model-invocation: true
argument-hint: "[PHASE] [--initiative INIT-ID]"

---
# Generate an initiative phase

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow initiative status [INIT-ID] --json` and use only its current phase.
2. Run `singularity-flow initiative phase [PHASE] [--initiative INIT-ID]`. This prepares every configured output and records one governed Copilot prompt containing the exact phase contract, selected governed-agent prompt, required repository world-model views, active agent Markdown, and approved upstream initiative artifacts.
3. If the command reports unavailable World-Model intelligence—missing or unreachable, or stale under staleness `fail`—show the exact displayed `singularity-flow wm ensure ...` command as optional. Never run it without explicit contributor authorization and never block the Initiative phase on its absence; continue with a recorded zero-World-Model context. Never substitute a Story phase for an Initiative phase.
4. Run `singularity-flow initiative context [PHASE] [--initiative INIT-ID]` and use the complete returned prompt. Do not generate from a summary or from filenames alone.
5. Run `singularity-flow initiative documents [PHASE] [--initiative INIT-ID]`. Complete every required output, preserve managed metadata, satisfy the checklist contract, and do not invent evidence.
6. Run `singularity-flow initiative phase draft-check [PHASE] [--initiative INIT-ID] --json`. If unready, inspect `singularity-flow initiative recover [INIT-ID] --json` and keep repair in this phase. Correct every agent finding now from governed evidence only when ownership permits; otherwise route to its producer or human. Recheck up to three changed fingerprints and stop on an unchanged fingerprint. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer.
7. Only when `status` is `ready`, run the exact `singularity-flow initiative phase publish` action. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Never submit or approve.
8. Run `singularity-flow initiative documents [PHASE] [--initiative INIT-ID]` again. Reproduce every generated text document in full in the visible Copilot response. Show binary artifacts by absolute path, byte count, and SHA-256.
9. Report the prompt snapshot, output hashes, generation commit, push result, checklist blockers, approval requirements, and the first result from `singularity-flow initiative next [INIT-ID] --json`. Do not approve automatically.
