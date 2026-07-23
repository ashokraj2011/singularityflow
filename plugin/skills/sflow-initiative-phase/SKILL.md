---
name: sflow-initiative-phase
description: Compose the governed GitHub Copilot prompt, author all configured outputs, and publish the active phase of a multi-repository Singularity Flow initiative.
argument-hint: "[PHASE] [--initiative INIT-ID]"
disable-model-invocation: true
---
# Generate an initiative phase

1. Run `singularity-flow initiative status [INIT-ID] --json` and use only its current phase.
2. Run `singularity-flow initiative phase [PHASE] [--initiative INIT-ID]`. This prepares every configured output and records one governed Copilot prompt containing the exact phase contract, selected persona prompt, required repository world-model views, active-agent remote skill Markdown, and approved upstream initiative artifacts.
3. If the command asks for a world-model build, run the exact displayed `singularity-flow wm build --views ... --focus ...` command, then retry. Never substitute a story phase for an initiative phase.
4. Run `singularity-flow initiative context [PHASE] [--initiative INIT-ID]` and use the complete returned prompt. Do not generate from a summary or from filenames alone.
5. Run `singularity-flow initiative documents [PHASE] [--initiative INIT-ID]`. Complete every required output, preserve managed metadata, satisfy the checklist contract, and do not invent evidence.
6. Run `singularity-flow initiative phase publish [PHASE] [--initiative INIT-ID]`. Publication verifies that the composed prompt and every approved input/world-model hash still match, then commits and pushes the generation.
7. Run `singularity-flow initiative documents [PHASE] [--initiative INIT-ID]` again. Reproduce every generated text document in full in the visible Copilot response. Show binary artifacts by absolute path, byte count, and SHA-256.
8. Report the prompt snapshot, output hashes, generation commit, push result, checklist blockers, approval requirements, and the first result from `singularity-flow initiative next [INIT-ID] --json`. Do not approve automatically.
