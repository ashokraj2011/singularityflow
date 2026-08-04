---
name: sflow-story-inbox
description: List active Jira Stories carrying governed Singularity lineage so a developer can choose work safely.
disable-model-invocation: true

---

# Developer Story inbox

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.

1. Run `singularity-flow story inbox --assigned-to-me`.
2. If the user asks for all visible governed Stories, omit `--assigned-to-me`.
3. Show Jira key/status, plan ID, Epic, configured repository, and canonical branch.
4. Ordinary Jira Stories without `com.singularity.flow.lineage` are intentionally excluded.
5. Do not change Jira assignment or status.
