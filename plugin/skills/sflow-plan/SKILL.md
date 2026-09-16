---
name: sflow-plan
description: Route a spec-driven Story toward an approved plan.
disable-model-invocation: true

---
# Plan — route toward an approved plan

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow plan --json`. It resolves the subject, phase, generation, pending publication and approval state, and returns the milestone, the checkpoint it stopped at, and the underlying kernel operations.
2. Relay `checkpoint.reason` and the ordered `next[]` actions. Never invent an action the router did not return.
3. If the checkpoint is `recovery`, route it first. Nothing else may proceed while a retained commit has not reached its remote.
4. If the checkpoint is `approval`, stop. Approval needs an authorized human Git identity; a governed agent cannot grant it.
5. If the checkpoint is `model-generation`, you may author with the resolved planning agent, the approved inputs, the pinned template and constitution, and the required world-model views — then publish through the same kernel operation the phase command uses. Author `plan.md` from the approved specification, citing the clause each decision serves. In `Test strategy`, preserve the exact `Clause | Expected paths | Planned tests` table and add exactly one row per authoritative clause: use its fully qualified ID and backticked, repository-relative exact paths. Never use directories, globs, modules, or prose as paths. For a genuinely non-testable clause, write `not-applicable:` followed by its concrete reviewed explanation; never use it to defer work or hide an unknown path. Fill `Agent brief` with the selected approach, affected surfaces, sequence, proof strategy, and principal risks; do not replace exact source evidence. `tasks.md` is an advisory task map: it may guide checkpoints and progress, and it never gates a transition.
6. Before the returned publication operation, run `singularity-flow phase draft-check planning --json`. Publish only when `status` is `ready`. For `correction-required`, correct every structured finding from governed evidence, then recheck at most three distinct changed fingerprints; stop on an unchanged fingerprint or on a third changed fingerprint that remains unready. Never delete markers blindly, invent facts or padding, invoke a nested model, or overwrite another producer. A race-time `ARTIFACT_AUTHORING_INCOMPLETE` permits exactly one recheck and at most one publication retry after the bounded protocol reaches `ready`, never a loop.
7. Never present a milestone as reached unless the router says so. A command returning successfully is not completion.
8. State the underlying operations you ran, so the reader can always see which governed operation the verb stood for.
9. Do not approve, reject, or advance a phase.
10. For every returned next action, show its direct Copilot route first as `Next in Copilot: /sf-...`, followed by the exact `Terminal equivalent: singularity-flow ...`. Never omit or guess either route.
