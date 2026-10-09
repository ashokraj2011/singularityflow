---
name: sflow-scenario-repair
description: Repair the latest approved document-derived defect through the canonical code-generation and executable-test gate.
disable-model-invocation: true
argument-hint: "[approved scenario defect]"
---
# Repair a scenario defect

<!-- sflow-output-contract: canonical-delegation -->
**Output contract:** Run the canonical skill once and preserve its result and handoff; do not repeat its preflight, authoring, or publication. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository.


Delegate once to `/sf-code` with the approved scenario defect and supplied focus. That canonical
skill owns pause/session resolution, verified task policy, open generation intent, current rework
request, scoped code/test changes, structured test evidence and exactly-once publication.

Preserve approved documents, expected behavior, tolerances and other people's edits. Do not turn a
failure into a pass by weakening assertions. Missing tools need the canonical skill's reviewed
configuration/recovery route. Retest belongs to `/sf-scenario-check`; an agent cannot grant human
acceptance or loop indefinitely. Stop when the canonical skill returns, preserving its evidence,
limitations and exact Copilot/Shell handoff. Do not repeat preflight, publish, submit or approve.
