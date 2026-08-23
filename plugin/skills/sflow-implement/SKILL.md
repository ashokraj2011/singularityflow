---
name: sflow-implement
description: Friendly alias for the canonical task-based Singularity Flow code-generation contract.
disable-model-invocation: true
argument-hint: "[implementation focus]"

---
# Implementation alias

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** Flow-reported root only (Story: `singularity/work-items/<WORK-ID>/`). Deterministic: `--no-model`; kernel model: forbidden.


Run `/sflow-code` with the supplied focus and stop when it returns. `/sflow-code` owns authoring, test evidence, and the single publication transaction; this alias must not publish, submit, or approve again.

Inspect further files only as the implementation requires within this repository.

Next in Copilot: /sf-code <implementation focus>

Terminal equivalent: singularity-flow prepare <phase>, followed by `singularity-flow phase begin <phase>`.
