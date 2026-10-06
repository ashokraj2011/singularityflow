---
name: sflow-plan
description: Route a spec-driven Story toward an approved plan.
disable-model-invocation: true

---
# Plan — route toward an approved plan

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow plan --json`; read its checkpoint, kernel operations and `<PHASE>`, the step its commands name.
2. Relay `checkpoint.reason` and the ordered `next[]`; never invent an action.
3. If the checkpoint is `recovery`, route it first; nothing else proceeds until the retained commit reaches its remote.
4. If the checkpoint is `approval`, stop: only an authorized human Git identity approves.
5. At `model-generation`, require the first `NOW` action in the returned `next[]` to be `singularity-flow prepare <PHASE>`, then run that exact returned command once and use its prepared artifact path. If the action differs, stop and relay the returned route; do not author against a seeded or stale draft. Then author with the resolved agent, approved inputs, pinned template/constitution, and required world-model views. Run `singularity-flow wm compose --phase <PHASE>` once for its `Active supporting evidence`; cite each document used as `DOC-nnn — <name>`. Derive the plan from approved specification, citing clauses. In `Test strategy`, fill the planned-evidence table, one row per authoritative clause: fully qualified ID, backticked exact repository-relative paths (never directories, globs, modules or prose), Fulfillment and Observable result. For non-testable clauses use `not-applicable:` with a reviewed explanation, never to hide unknowns. List each file the code must change that cannot carry a `@clause` tag (manifest, lockfile, CI config) under `## Supporting files` as `- `path` — reason`. Fill `Agent brief` with approach, surfaces, sequence, proof, and risks. `tasks.md` is advisory and never gates transition.
6. Before publication run `singularity-flow phase draft-check <PHASE> --json`, then `singularity-flow phase prepublish <PHASE> --json`. If unready, run read-only `singularity-flow recover <WORK-ID> --phase <PHASE> --json`; remain in this phase. Correct every structured agent finding now from governed evidence only when `correction.sameTurn`; otherwise route to its producer or human. Never delete markers blindly, invent facts or padding, invoke a nested model, or overwrite another producer. Publish only when prepublish `status` is `ready`. A race-time `ARTIFACT_AUTHORING_INCOMPLETE` permits one recheck and at most one publication retry if ready, never a loop. Never submit or approve. Follow returned `repairLoop.protocol` for persistent correction/resume; stop unchanged.
7. Claim a milestone only when the router returns it.
8. State the underlying operations you ran.
9. Do not approve, reject, or advance a phase.
10. For every returned next action, show its direct Copilot route first as `Next in Copilot: /sf-...`, followed by the exact `Terminal equivalent: singularity-flow ...`. Never omit or guess either route.
