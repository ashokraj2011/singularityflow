---
name: sflow-specify
description: Route a spec-driven Story toward an approved specification.
disable-model-invocation: true

---
# Specify — route toward an approved specification

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
Blocked: relay `resolution.issues[].choices` too. Eligible risk needs reason/expiry and authorized human confirmation. Never auto-accept risk.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow specify --json`. It returns the milestone, the checkpoint it stopped at, the underlying kernel operations, and `<PHASE>`, the step its commands name.
2. Relay `checkpoint.reason` and the ordered `next[]` actions. Never invent an action the router did not return.
3. If the checkpoint is `recovery`, route it first. Nothing else may proceed while a retained commit has not reached its remote.
4. If the checkpoint is `approval`, stop. Approval needs an authorized human Git identity; a governed agent cannot grant it.
5. At `model-generation`, require the first `NOW` action in the returned `next[]` to be `singularity-flow prepare <PHASE>`; run that exact returned command once and use its artifact path. If the action differs, stop and relay the returned route; never author a seeded or stale draft. With the resolved agent, approved inputs, pinned template/constitution, and required world-model views, author the specification scenario-first: prioritized Given/When/Then scenarios, actors, empty/failure states, permissions, boundaries, and non-functional requirements. Fill `Agent brief` with approved intent only; the kernel preserves exact sections for review. Run `singularity-flow wm compose --phase <PHASE>` once for its `Active supporting evidence`; under `## Sources` cite each document used as `DOC-nnn — <name>` and list unreadable or unavailable ones as gaps. Where evidence is missing, write `[NEEDS CLARIFICATION: <one question grounded in the current Story evidence>]`, not an invented answer.
6. Before publication run `singularity-flow phase draft-check <PHASE> --json`, then `singularity-flow phase prepublish <PHASE> --json`. Unready: `singularity-flow recover <WORK-ID> --phase <PHASE> --json`; stay here. Repair from approved inputs when `correction.sameTurn`; else route to its owner. Never invent, pad, blindly delete markers, nest models or overwrite producers. Use returned `commands.publish` when `ready`; absent: relay `commands.next`, stop. A race-time `ARTIFACT_AUTHORING_INCOMPLETE` permits one recheck and at most one publication retry if ready, never a loop. Never submit or approve. Follow returned `repairLoop.protocol` for persistent correction/resume; stop unchanged.
7. Claim a milestone only when the router returns it.
8. State the underlying operations you ran.
9. For every returned next action, show its direct Copilot route first as `Next in Copilot: /sf-...`, followed by the exact `Terminal equivalent: singularity-flow ...`. Never omit or guess either route.
