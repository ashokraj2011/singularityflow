---
name: sflow-converge
description: Route a spec-driven Story toward convergence advanced.
disable-model-invocation: true

---
# Converge — route toward convergence advanced

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow converge --json`. It returns the bound subject, milestone, checkpoint, generation contract, and kernel operations.
2. Relay `checkpoint.reason` and the ordered `next[]` actions. Treat each returned command, configured producer, and channel as exact kernel output: run or display it byte-for-byte. Never invent an action, replace its authorship, or inline a different phase workflow.
3. If the checkpoint is `recovery`, route it first. Nothing else may proceed while a retained commit has not reached its remote.
4. If the checkpoint is `approval`, stop. Approval needs an authorized human Git identity; a governed agent cannot grant it.
5. If the checkpoint is `deterministic-generation`, run only returned preparation. Stop for adjudication/rework/amendment. Before publish run `singularity-flow phase draft-check convergence --json`; if unready, regenerate up to three changed fingerprints and stop on an unchanged fingerprint. Never invoke a model, author or edit the artifact, or substitute human/governed-agent authorship. Publish only when `status` is `ready` with `--authored deterministic --channel kernel-generator`.
6. At `model-generation`, use its resolved agent/prompt, draft-check, and correct every agent finding now from governed evidence. Never delete markers, invent facts/padding, nest models, or overwrite another producer. Stop unchanged or after three changed fingerprints. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop.
7. Obey the returned clarification mode. When it is `off`, do not ask phase clarification questions and never run `singularity-flow clarification record`. For another mode, clarify only when the router returns that checkpoint or action.
8. Read the deterministic convergence facts. An absent claim is missing trace evidence, not proof that implementation is missing. Every finding needs a human disposition; advancement to verification is an explicit human action and fails while blocking findings remain.
9. Never present a milestone as reached unless the router says so. A command returning successfully is not completion.
10. State the underlying operations you ran, so the reader can always see which governed operation the verb stood for.
11. Do not approve, reject, or advance a phase.
12. For every returned next action, show its direct Copilot route first as `Next in Copilot: /sf-...`, followed by the exact `Terminal equivalent: singularity-flow ...`. Never omit or guess either route.
