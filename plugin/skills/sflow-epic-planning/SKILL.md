---
name: sflow-epic-planning
description: Compatibility entry point for the canonical sflow-epic-story-draft workflow that creates governed Story plans and specifications.
disable-model-invocation: true

---

# Plan governed Stories

<!-- sflow-output-contract: canonical-delegation -->
**Output contract:** Run the canonical skill once and preserve its result and handoff; do not repeat its preflight, authoring, or publication. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository.

Run `/sf-epic-story-draft` once with the supplied arguments and stop when it returns. That canonical skill owns repository resolution, preparation, authoring, publication, validation, and the business-review handoff. Preserve its result unchanged. Do not run a second planning sequence, approve from CLI, or publish Jira/Git Stories.
