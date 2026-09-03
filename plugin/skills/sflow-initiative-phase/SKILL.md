---
name: sflow-initiative-phase
description: Compose the governed GitHub Copilot prompt, author all configured outputs, and publish the active phase of a multi-repository Singularity Flow initiative.
disable-model-invocation: true
argument-hint: "[PHASE] [--initiative INIT-ID]"

---
# Generate an initiative phase

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow initiative status [INIT-ID] --json` and use only its current phase.
2. Run `singularity-flow initiative phase [PHASE] [--initiative INIT-ID]`. This prepares every configured output and records one governed Copilot prompt containing the exact phase contract, selected governed-agent prompt, required repository world-model views, active agent Markdown, and approved upstream initiative artifacts.
3. If the command reports unavailable World-Model intelligence—missing or unreachable, or stale under staleness `fail`—show the exact displayed `singularity-flow wm ensure ...` command as optional. Never run it without explicit contributor authorization and never block the Initiative phase on its absence; continue with a recorded zero-World-Model context. Never substitute a Story phase for an Initiative phase.
4. Run `singularity-flow initiative context [PHASE] [--initiative INIT-ID]` and use the complete returned prompt. Do not generate from a summary or from filenames alone.
5. Run `singularity-flow initiative documents [PHASE] [--initiative INIT-ID]`. Complete every required output, preserve managed metadata, satisfy the checklist contract, and do not invent evidence.
6. Run `singularity-flow initiative phase publish [PHASE] [--initiative INIT-ID]`. Publication verifies that the composed prompt and every approved input/world-model hash still match, then commits and pushes the generation.
7. Run `singularity-flow initiative documents [PHASE] [--initiative INIT-ID]` again. Reproduce every generated text document in full in the visible Copilot response. Show binary artifacts by absolute path, byte count, and SHA-256.
8. Report the prompt snapshot, output hashes, generation commit, push result, checklist blockers, approval requirements, and the first result from `singularity-flow initiative next [INIT-ID] --json`. Do not approve automatically.
