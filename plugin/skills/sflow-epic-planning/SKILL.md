---
name: sflow-epic-planning
description: Compatibility entry point for the canonical sflow-epic-story-draft workflow that creates governed Story plans and specifications.
disable-model-invocation: true

---

# Plan governed Stories

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.

This is the compatibility name for `/sflow-epic-story-draft`. Follow that skill's canonical procedure:

1. Prepare from approved Requirements and impact analysis.
2. Author and publish the parent specification, Story plan, and one exact specification per Story.
3. Validate and print the complete package.
4. Stop for exact business approval in the VS Code extension's Approvals view. Approval is a human decision against a configured authority group; do not approve from the model session.

Do not run a second planning sequence, approve from CLI, or publish Jira/Git Stories.
