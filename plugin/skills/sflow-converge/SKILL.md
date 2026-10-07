---
name: sflow-converge
description: Route a spec-driven Story toward convergence advanced.
disable-model-invocation: true

---
# Converge — route toward convergence advanced

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow converge --json`; read its checkpoint, contract, ordered `next[]`, and `<PHASE>` (its step).
2. Treat returned commands, producer and channel as kernel output. Never invent an action or authorship. The route-only result is not the final response when the checkpoint is `deterministic-generation`; continue below.
3. Route `recovery` first with read-only `singularity-flow recover <WORK-ID> --phase <PHASE> --json`; follow only its current-phase action. At `approval`, stop: only an authorized human Git identity may approve.
4. At `deterministic-generation`, require the first `NOW` pair to be Copilot `/sf-converge` and Shell `singularity-flow prepare <PHASE>`. Execute that exact returned preparation command once in this same turn. Do not stop after merely displaying the route; do not run `singularity-flow converge --json` again. In its `next[]`, for adjudication, rework, intent amendment, or inspection, relay the action and stop for the human decision. If and only if it returns deterministic convergence publication as the first `NOW` action, run `singularity-flow phase draft-check <PHASE> --json`, then `singularity-flow phase prepublish <PHASE> --json`. If unready, follow returned `repairLoop.protocol` and its named regenerator/owner route; never loop preparation or start a model. Never invoke a model, author or edit the artifact, or substitute human/governed-agent authorship. Publish only when prepublish `status` is `ready`, using the exact returned publication command with configured `--authored deterministic --channel kernel-generator`. Stop immediately after publication; never advance, submit, approve. Report `singularity-flow phase show <PHASE> --json` handoff/document view.
5. At `model-generation`, run `singularity-flow wm compose --phase <PHASE>` once; author from it and `Active supporting evidence`. Run `singularity-flow phase draft-check <PHASE> --json`, then `singularity-flow phase prepublish <PHASE> --json`; correct only findings with `correction.sameTurn`, else route to their owner. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer. Publish only when prepublish `status` is `ready`. On `ARTIFACT_AUTHORING_INCOMPLETE`, recheck once; retry only if ready; never loop. Follow returned `repairLoop.protocol`; stop unchanged.
6. Obey clarification mode: when `off`, never ask phase questions or run `singularity-flow clarification record`; otherwise clarify only when returned.
7. Missing claims mean missing trace evidence, not implementation; unresolved blockers prevent advancement.
8. Report operations and exact next pairs as `Next in Copilot: /sf-...` then `Terminal equivalent: singularity-flow ...`. Never claim a milestone unless returned. Do not approve, reject, or advance.
