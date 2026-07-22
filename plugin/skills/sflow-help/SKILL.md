---
name: sflow-help
description: Load the Singularity Flow help manual by topic, or explain an active work item's selected workflow, phase contracts, approvals, position, and next valid action.
argument-hint: "[WORK-ID | TOPIC] [--json]"
disable-model-invocation: true
---
# Load help or explain how to proceed

1. For a general question, no work item, or a manual topic such as `quick-start`, `jira-intake`, `copilot-commands`, or `troubleshooting`, run `singularity-flow help <topic>` and use the returned canonical manual content. With no topic, run `singularity-flow help`.
2. For a work ID or a question about the active work item's current phase, run `singularity-flow guide <WORK-ID>` instead.
3. When using the work-item guide, state the selected workflow template and whether the source is Jira or manual intake.
4. Explain the ordered phases, required artifact for each phase, suggested personas, approval-capable personas, and approval threshold.
5. Highlight the current phase and present the exact recommended `/sflow-*` skill and equivalent CLI command.
6. If approval is pending, show both approve and reject paths and remind the user that the selected persona must have approval capability.
7. If the workflow is complete, point to `/sflow-progress`, `/sflow-report`, and the final conformance artifact.
8. Treat `HELP.md` as the canonical product manual; do not invent a conflicting rule when the manual or committed workflow provides one.
9. Do not generate, submit, approve, reject, upload, commit, or push anything.
