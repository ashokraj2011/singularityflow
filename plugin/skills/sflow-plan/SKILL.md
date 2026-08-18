---
name: sflow-plan
description: Route a spec-driven Story toward an approved plan.
disable-model-invocation: true

---
# Plan — route toward an approved plan

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay the router's milestone, checkpoint and ordered actions; never invent an action it did not return.

1. Run `singularity-flow plan --json`. It resolves the subject, phase, generation, pending publication and approval state, and returns the milestone, the checkpoint it stopped at, and the underlying kernel operations.
2. Relay `checkpoint.reason` and the ordered `next[]` actions. Never invent an action the router did not return.
3. If the checkpoint is `recovery`, route it first. Nothing else may proceed while a retained commit has not reached its remote.
4. If the checkpoint is `approval`, stop. Approval needs an authorized human Git identity; a governed agent cannot grant it.
5. If the checkpoint is `model-generation`, you may author with the resolved planning agent, the approved inputs, the pinned template and constitution, and the required world-model views — then publish through the same kernel operation the phase command uses. Author `plan.md` from the approved specification, citing the clause each decision serves. `tasks.md` is an advisory task map: it may guide checkpoints and progress, and it never gates a transition.
6. Never present a milestone as reached unless the router says so. A command returning successfully is not completion.
7. State the underlying operations you ran, so the reader can always see which governed operation the verb stood for.
8. Do not approve, reject, or advance a phase.
9. For every returned next action, show its direct Copilot route first as `Next in Copilot: /sf-...`, followed by the exact `Terminal equivalent: singularity-flow ...`. Never omit or guess either route.
