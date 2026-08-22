---
name: sflow-help
description: Answer questions about Singularity Flow and its workflow.
argument-hint: "[WORK-ID | TOPIC] [--json]"

---
# Load help or explain how to proceed

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested.
<!-- sflow-execution-boundary -->
**Boundary:** Flow-reported root only (Story: `singularity/work-items/<WORK-ID>/`). Deterministic: `--no-model`; kernel model: forbidden.

1. For a general question, no work item, or a manual topic such as `quick-start`, `jira-intake`, `copilot-commands`, or `troubleshooting`, run `singularity-flow help <topic>` and use the returned canonical manual content. With no topic, run `singularity-flow help`.
2. For a work ID or a question about the active work item's current phase, run `singularity-flow guide <WORK-ID>` instead.
3. When using the work-item guide, state the selected workflow template and whether the source is Jira or manual intake.
4. Explain the ordered phases, required artifact for each phase, suggested governed agents, human approval authority groups, and approval threshold.
5. Highlight the current phase and present the exact recommended `/sf-*` skill and equivalent CLI command. Point to `/sf-nextsteps` for a read-only ordered plan and `/sf-next` to execute exactly one valid action.
6. If approval is pending, show both approve and reject paths and remind the user that authority comes from their Git/GitHub identity; a governed agent cannot grant it.
7. If the workflow is complete, point to `/sf-progress`, `/sf-report`, and the final conformance artifact.
8. Treat `HELP.md` as the canonical product manual; do not invent a conflicting rule when the manual or committed workflow provides one.
9. Do not generate, submit, approve, reject, upload, commit, or push anything.
