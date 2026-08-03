---
name: sflow-run
description: Guide one Singularity Flow phase until the next human authoring or approval boundary without automatically approving.
argument-hint: "[task focus]"
disable-model-invocation: true
---
# Guided workflow execution

Run `singularity-flow run --task "$ARGUMENTS"`. The command may prepare grounding and a phase or offer to submit an already published generation. It must stop at authoring and approval boundaries. Never choose a governed agent for the reviewer, approve, reject, bypass authority validation, or bypass confirmation. When it stops at authoring, complete only the active phase contract, then use `/sflow-phase` to publish and display every generated artifact.
