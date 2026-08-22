---
name: sflow-specify
description: Route a spec-driven Story toward an approved specification.
disable-model-invocation: true

---
# Specify — route toward an approved specification

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.

1. Run `singularity-flow specify --json`. It resolves the subject, phase, generation, pending publication and approval state, and returns the milestone, the checkpoint it stopped at, and the underlying kernel operations.
2. Relay `checkpoint.reason` and the ordered `next[]` actions. Never invent an action the router did not return.
3. If the checkpoint is `recovery`, route it first. Nothing else may proceed while a retained commit has not reached its remote.
4. If the checkpoint is `approval`, stop. Approval needs an authorized human Git identity; a governed agent cannot grant it.
5. If the checkpoint is `model-generation`, you may author with the resolved specification agent, the approved inputs, the pinned template and constitution, and the required world-model views — then publish through the same kernel operation the phase command uses. Author `spec.md` scenario-first: prioritized user scenarios with Given/When/Then before general requirements, plus actors, failure and empty states, permissions, boundary conditions, and non-functional requirements. Fill `Agent brief` with a compact, standalone statement of the approved intent for downstream agents; do not add claims absent from the full specification. The kernel preserves configured exact sections and binds the projection during review. Write `[NEEDS CLARIFICATION: <one question grounded in the current Story evidence>]` wherever you would otherwise guess; replace the placeholder and never copy a template example. This phase blocks publication while any marker is unresolved.
6. Never present a milestone as reached unless the router says so. A command returning successfully is not completion.
7. State the underlying operations you ran, so the reader can always see which governed operation the verb stood for.
8. Do not approve, reject, or advance a phase.
9. For every returned next action, show its direct Copilot route first as `Next in Copilot: /sf-...`, followed by the exact `Terminal equivalent: singularity-flow ...`. Never omit or guess either route.
