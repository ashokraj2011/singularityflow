---
name: sflow-plan
description: Route a spec-driven Story toward an approved plan.
disable-model-invocation: true

---
# Plan — route toward an approved plan

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
Blocked: relay `resolution.issues[].choices` too. Eligible risk needs reason/expiry and authorized human confirmation. Never auto-accept risk.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow plan --json`; read its checkpoint, kernel operations and `<PHASE>`, the step its commands name.
2. Relay `checkpoint.reason` and the ordered `next[]`; never invent an action.
3. If the checkpoint is `recovery`, route it first; nothing else proceeds until the retained commit reaches its remote.
4. If the checkpoint is `approval`, stop: only an authorized human Git identity approves.
5. At `model-generation`, require first `NOW` in `next[]` = `singularity-flow prepare <PHASE>`; execute once, use its artifact path. Otherwise relay the route and stop; no seeded/stale drafting. Use the resolved agent, approved inputs and pinned template/constitution. `singularity-flow wm compose --phase <PHASE>`: use required views/supporting evidence; cite used documents as `DOC-nnn — <name>`. Derive the plan from approved specification clauses. In `Test strategy`, fill the planned-evidence table, one row per authoritative clause: fully qualified ID, backticked exact repository-relative paths (never directories, globs, modules or prose), Fulfillment and Observable result. For non-testable clauses use `not-applicable:` with a reviewed explanation, never to hide unknowns. Non-commentable changes (manifest/lockfile/CI config): `## Supporting files` bullets with exact path/reason. Fill `Agent brief`: approach, surfaces, sequence, proof, risks. `tasks.md` is advisory, never a gate.
6. Before publication run `singularity-flow phase draft-check <PHASE> --json`, then `singularity-flow phase prepublish <PHASE> --json`. Unready: `singularity-flow recover <WORK-ID> --phase <PHASE> --json`; stay here. Correct agent findings from governed evidence when `correction.sameTurn`; else route to its owner. Never invent, pad, blindly delete markers, nest models or overwrite producers. Use returned `commands.publish` when `ready`; absent: relay `commands.next`, stop. A race-time `ARTIFACT_AUTHORING_INCOMPLETE` permits one recheck and at most one publication retry if ready, never a loop. Never submit or approve. Follow returned `repairLoop.protocol` for persistent correction/resume; stop unchanged.
`Expected paths`: product source only; `Planned tests`: tests only, never both. Test-only obligations use fulfillment `test-only` with `Expected paths` = `-`.

7. Claim a milestone only when the router returns it.
8. State the underlying operations you ran.
9. Do not approve, reject, or advance a phase.
10. For every returned next action, show its direct Copilot route first as `Next in Copilot: /sf-...`, followed by the exact `Terminal equivalent: singularity-flow ...`. Never omit or guess either route.
