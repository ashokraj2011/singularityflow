---
name: sflow-epic-journey
description: Explain the configured Epic lifecycle, current stage, governed artifacts, approval boundaries, and developer handoff as a business-readable journey.
disable-model-invocation: true

---

# Show the Epic journey

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.

1. Run `singularity-flow epic journey <EPIC-KEY> --json`.
2. Render Intake → Requirements → Planning → Story publication → developer delivery → Product Owner completion as an arrow flow.
3. Mark the current stage, completed gates, artifacts, owners, and cross-repository handoffs.
4. Distinguish business review in the VS Code extension's Approvals view from work performed through Copilot skills.
5. Do not change lifecycle state.
