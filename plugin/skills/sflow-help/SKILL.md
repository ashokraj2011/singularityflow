---
name: sflow-help
description: Explain the selected Singularity Flow workflow template, every configured phase, required artifacts and approvals, current position, and the exact next valid action.
argument-hint: "[WORK-ID] [--json]"
disable-model-invocation: true
---
# Explain how to proceed

1. Run `singularity-flow guide <arguments>` without changing files or lifecycle state.
2. State the selected workflow template and whether the source is Jira or manual intake.
3. Explain the ordered phases, required artifact for each phase, suggested personas, approval-capable personas, and approval threshold.
4. Highlight the current phase and status.
5. Present the exact recommended `/sflow-*` skill and equivalent CLI command from the guide.
6. If approval is pending, show both approve and reject paths and remind the user that the selected persona must have approval capability.
7. If the workflow is complete, point to `/sflow-progress` and the final conformance artifact.
8. Do not generate, submit, approve, reject, upload, commit, or push anything.
