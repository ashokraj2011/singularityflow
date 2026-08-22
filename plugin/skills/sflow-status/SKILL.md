---
name: sflow-status
description: Show the current phase, artifacts, checks, and approvals.
argument-hint: "[WORK-ID]"

---
# Show Singularity Flow status

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested.
<!-- sflow-execution-boundary -->
**Boundary:** Flow-reported root only (Story: `singularity/work-items/<WORK-ID>/`). Deterministic: `--no-model`; kernel model: forbidden.

Run `singularity-flow status` with the supplied work ID, if any. Read `STATUS.md` and report the branch, immutable work type, current phase, suggested governed agents, generation, artifacts, token usage, human approval authority groups, threshold, self-approval warnings, publication state, and next valid action. Do not change files or lifecycle state.
