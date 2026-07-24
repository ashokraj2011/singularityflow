---
name: sflow-epic-generate
description: Generate the current Epic intake, requirements, Story-planning, or high-level specification artifacts from governed context.
---

# Generate an Epic phase

1. Run `singularity-flow epic status --json` and use only the current phase.
2. Run `singularity-flow epic generate [PHASE]`. This verifies pinned sources, composes persona/world-model/agent/upstream context, prepares every configured output, commits, and pushes the preparation.
3. Read the exact governed prompt path printed by the CLI. Generate complete artifacts, not summaries.
4. Requirements must use `REQ-nnn` and `AC-nnn`; every item must cite a pinned `SRC-*` plus a page, frame, or section.
5. Story plans must use breakdown version 2, immutable `STORY-nnn` plan IDs, configured repository IDs, and explicit REQ/AC/dependency allocation. Never invent Jira Story keys.
6. The `spec` phase must bind each Story to its REQ/AC scope, repository/component boundary, interfaces, security, observability, test expectations, and Product Owner validation evidence.
7. Publish with `singularity-flow epic submit [PHASE]`, then print every generated text artifact in full and show all hashes.
8. Stop at the approval boundary.
