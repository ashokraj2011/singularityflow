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

1. Run `singularity-flow converge --json`; read its subject, milestone, checkpoint, contract, operations, and ordered `next[]`.
2. Treat each returned command, configured producer, and channel as exact kernel output. Never invent an action or authorship. The route-only result is not the final response when the checkpoint is `deterministic-generation`; continue below.
3. Route `recovery` first. At `approval`, stop: only an authorized human Git identity may approve.
4. At `deterministic-generation`, require the first `NOW` pair to be Copilot `/sf-converge` and Shell `singularity-flow prepare convergence`. Execute that exact returned preparation command once in this same turn. Do not stop after merely displaying the route. Do not run `singularity-flow converge --json` again. In its `next[]`, for adjudication, rework, intent amendment, or inspection, relay the action and stop for the human decision. If and only if it returns deterministic convergence publication as the first `NOW` action, run `singularity-flow phase draft-check convergence --json`. If unready, rerun exact preparation for at most three changed fingerprints; stop on an unchanged fingerprint. Never invoke a model, author or edit the artifact, or substitute human/governed-agent authorship. Publish only when `status` is `ready`, using the exact returned publication command with configured `--authored deterministic --channel kernel-generator`. Stop immediately after publication; never advance, submit, approve, or follow another action.
5. At `model-generation`, use the resolved agent/prompt and governed evidence. Draft-check and correct every finding in this Copilot turn. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer. Stop on an unchanged fingerprint or after three changed fingerprints. For `ARTIFACT_AUTHORING_INCOMPLETE`, recheck once and retry once only if ready; never loop.
6. Obey clarification mode. When it is `off`, never ask phase questions or run `singularity-flow clarification record`; otherwise clarify only when returned.
7. An absent claim is missing trace evidence, not proof of missing implementation. Every finding needs human disposition; blockers prevent advancement.
8. Report the underlying operations and exact next pairs as `Next in Copilot: /sf-...` then `Terminal equivalent: singularity-flow ...`. Never claim a milestone unless returned. Do not approve, reject, or advance.
