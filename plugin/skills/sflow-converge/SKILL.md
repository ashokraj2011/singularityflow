---
name: sflow-converge
description: Route a spec-driven Story toward convergence advanced.
disable-model-invocation: true

---
# Converge — route toward convergence advanced

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow converge --json`. It resolves the subject, phase, generation, pending publication and approval state, and returns the milestone, the checkpoint it stopped at, and the underlying kernel operations.
2. Relay `checkpoint.reason` and the ordered `next[]` actions. Never invent an action the router did not return.
3. If the checkpoint is `recovery`, route it first. Nothing else may proceed while a retained commit has not reached its remote.
4. If the checkpoint is `approval`, stop. Approval needs an authorized human Git identity; a governed agent cannot grant it.
5. If the checkpoint is `model-generation`, you may author with the resolved convergence agent, the approved inputs, the pinned template and constitution, and the required world-model views — then publish through the same kernel operation the phase command uses. Read the deterministic convergence facts. An absent claim is missing trace evidence, not proof that implementation is missing. Every finding needs a human disposition; advancement to verification is an explicit human action and fails while blocking findings remain.
6. Never present a milestone as reached unless the router says so. A command returning successfully is not completion.
7. State the underlying operations you ran, so the reader can always see which governed operation the verb stood for.
8. Do not approve, reject, or advance a phase.
9. For every returned next action, show its direct Copilot route first as `Next in Copilot: /sf-...`, followed by the exact `Terminal equivalent: singularity-flow ...`. Never omit or guess either route.
