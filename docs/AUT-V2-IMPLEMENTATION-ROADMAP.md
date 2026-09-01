# AUT v2 implementation roadmap

Status: P0 and P1 are implemented and release-validated for the Story profile. The tested
implementation is commit `32a2ce555342d8d91bd13806dea1947ceafade7d`. This document records the
implementation boundary and evidence map for `SingularityFlow_AUT_v2_Developer_Auto_Mode_Spec.md`.
The optional SGOS profile remains outside this release boundary.

## Architecture decisions

- Auto remains an orchestrator over the ordinary Story lifecycle. It does not own approval,
  publication, policy waiver, or a second gate implementation.
- `story` is the dependency-free default profile. `auto-select` currently resolves to `story`.
  Explicit `sgos` selection is refused with `AUTO_PROFILE_UNAVAILABLE`; SGOS absence never blocks
  Story Auto.
- Existing `APL-` and `AFL-` identifier shapes remain stable. Schema-v1 Plans are retained as
  archival bytes but cannot authorize execution; new Plans require the exact derived packet.
- Core mode stays sequential and single-repository. Multi-repository and parallel execution remain
  optional SGOS work, not simulated Story behavior.
- The default repair posture has no hidden retry. A refusal may authorize at most one exact,
  confirmed, bounded repair attempt; a second failure deterministically halts with both failures
  preserved.
- Ad Hoc landing preserves its original provenance. The Story profile supports an exact,
  hash-verified promotion handoff. Direct materialization of arbitrary dirty bytes is deliberately
  non-startable and fail-closed; the AUT v2 specification makes that direct adoption path optional
  (`MAY`).

## Implemented foundation

- Exact Plan synthesis, explicit confirmation, identity-bound ratification, approved configuration
  pinning, deterministic Story creation, and managed worktree isolation.
- Fail-closed authorization reads: malformed, future-version, wrong-family, wrong-Plan, and
  self-hash-tampered receipts are preserved and refused.
- Credential-safe repository identity and fingerprints in Plan records; credential-bearing HTTP(S)
  remotes are refused before Plan persistence.
- Governed accepted-Plan and ratification verification before resume and every execution step.
  Start-time TTL, caller branch, and moving remote-head checks are not incorrectly reapplied to an
  already-started Story.
- Story/auto-select profile resolution and real `step`, `phase`, and `continuous` policy vocabulary.
  Step pacing checkpoints after authoring and publication without repeating the model attempt.
- Stop-first pause/halt/takeover coordination. If execution cannot prove quiescence, the durable
  state becomes `recovery-required`, never a false `paused` or `halted` result.
- Backward-compatible CLI: requirement shorthand plans only, `list`, `stop`, `takeover`, and
  `start --plan`, while legacy positional start and `halt` continue to work.
- Deterministic Plan validation and ratification packet projections, plus the existing deterministic
  flight report.

## P0 implementation

1. **Immutable Candidate authority**
   - Implemented an immutable Git-object Candidate outside the mutable worktree, including exact
     add/delete/rename/mode/symlink and resource identities.
   - Deterministic verification, delivery evidence, approval context, and ordinary lifecycle
     publication bind to the same Candidate SHA.
   - Verification runs in isolation, permits only bounded disposable evidence, and refuses source
     mutation before publication. A sealed receipt is reused after a crash instead of repeating the
     consequential verification operation.

2. **Governed boundary checkpoints**
   - Phase, human, publication, recovery, and completion boundaries publish through the ordinary
     Story transaction and carry closed, versioned Auto state.
   - Private `.git` projections are explicitly non-authoritative. They can be discovered and rebuilt
     from the governed Story checkpoint after clone, interruption, or loss of local runtime files.
   - Pause, halt, takeover, and recovery preserve quiescence and checkpoint continuity.

3. **Sequential phase continuation**
   - A legitimate adjacent approved phase transition is reconciled from ordinary lifecycle
     authority; unrelated tail drift remains a refusal.
   - Every phase receives an exact task, context, and execution-unit contract.
   - `step`, `phase`, and `continuous` pacing now use deterministic endpoints across the full Story
     rail without repeating a completed model attempt.

4. **Enforced task scope**
   - Provider adapters enforce normalized absolute read/write roots at tool-permission time as well
     as at publication time.
   - ACP tool identity is stable across announcement, permission, and completion orderings; changed
     identity, out-of-scope paths, and unreviewed create/move effects fail before the effect.

5. **Runtime record contracts**
   - Candidate binding/verification, boundary checkpoint, phase run, attempt, refusal, Repair Plan,
     Human Request, token-economics, and execution-unit-switch families have closed validators,
     current-schema writers, migrations, and fixtures.
   - Historical self-hashes are verified against stored bytes before migration. Registered families
     correspond to emitted state transitions; unknown fields and future versions fail closed.

## P1 implementation

1. **Phase-run and attempt lineage**
   - Stable attempt IDs, parent/reason links, task/context/unit hashes, budget impact, Candidate
     binding, result, and phase-run status are persisted as typed records.
2. **Refusal and bounded repair**
   - Structured refusals produce ask-only Repair Plans. One exact plan may be confirmed for one
     machine-actionable repair attempt; a further failure halts with a deterministic comparison.
3. **Human Requests**
   - Clarification, credential, and architecture requests use typed, checkpoint-bound records and
     compare-and-swap responses. Credential values remain broker references; secret-shaped inline
     answers are refused. Ordinary lifecycle approval remains the authority for decisions.
4. **Entry and control modes**
   - `auto continue` produces a read-only, checkpoint-bound proposal for an existing Story.
   - Goal seeding binds exact Goal/workspace/repository authority and revalidates it at ratification.
   - Ad Hoc work uses a provenance-preserving, exact-hash promotion handoff; arbitrary dirty-byte
     materialization remains deliberately non-startable as described above.
   - Execution-unit switching requires an exact switch plan and starts a new lineage-linked attempt.
5. **Evidence and return surfaces**
   - Governed checkpoints carry the state needed to rebuild authority-backed final reports, typed
     token-economics receipts, and bounded WMB/CMP references.
   - Home/Return provides repository-scoped Plan, running, refusal, Needs You, takeover, and report
     summaries, and degrades to an explicit unavailable result rather than searching elsewhere.
6. **Gateway, CLI, and VS Code surfaces**
   - Read-first Auto operations are routed behind the existing five Gateway tools; the implementation
     does not add a tool per feature.
   - CLI controls and VS Code cards expose exact review or continuation commands without bypassing
     confirmations, approvals, or lifecycle gates.

## P0/P1 traceability

| Scope | Primary implementation | Focused evidence |
| --- | --- | --- |
| P0 Candidate authority | `src/auto/auto-candidate.mjs`, `src/state.mjs`, `src/delivery-evidence.mjs`, `src/story-lineage.mjs` | `test/auto-candidate.test.mjs`, `test/auto-candidate-crash-recovery.test.mjs` |
| P0 governed checkpoints | `src/auto/auto-checkpoint.mjs`, `src/auto/auto-flight-store.mjs`, `src/auto/auto-private-store.mjs` | `test/auto-v2-controls.test.mjs`, `test/auto-private-store.test.mjs` |
| P0 sequential continuation | `src/auto/auto-continuation.mjs`, `src/auto/auto-phase-contract.mjs`, `src/auto/auto-executor.mjs` | `test/auto-v2-controls.test.mjs`, `test/auto-mode.test.mjs` |
| P0 tool-time scope | `src/model-runner.mjs`, `src/model-providers/copilot-cli.mjs` | `test/model-runner.test.mjs`, `test/model-provider-copilot.test.mjs` |
| P0 record contracts | `src/auto/auto-p1-records.mjs`, `src/schema-migrations.mjs`, `schemas/auto-*.schema.json` | `test/auto-p1-product.test.mjs`, schema-migration fixtures/checks |
| P1 lineage, refusal, repair, and requests | `src/auto/auto-p1-lineage.mjs`, `src/auto/auto-p1-control.mjs`, `src/auto/auto-p1-records.mjs` | `test/auto-p1-product.test.mjs`, `test/auto-v2-controls.test.mjs` |
| P1 entry modes and switching | `src/auto/auto-entry-modes.mjs`, `src/commands/auto.mjs`, `src/auto/auto-p1-control.mjs` | `test/auto-entry-modes.test.mjs`, `test/auto-cli-usability.test.mjs` |
| P1 reports, economics, WMB/CMP, Home/Return | `src/auto/auto-checkpoint.mjs`, `src/auto/auto-executor.mjs`, `src/gateway/auto-home-summary.mjs`, `src/gateway/planners/home-overview.mjs` | `test/auto-v2-controls.test.mjs`, `test/auto-home-projection.test.mjs` |
| P1 Gateway and VS Code product surfaces | `src/gateway/planners/auto-flight.mjs`, `src/gateway/operations.mjs`, `apps/vscode/src/views/auto-cards-model.ts`, `apps/vscode/src/views/result-card-*.ts` | `test/auto-p1-surfaces.test.mjs`, `test/vscode-result-card.test.mjs`, `test/vscode-refusal-wiring.test.mjs` |

## P2 optional profile

Add the SGOS adapter only after the Story profile release gates pass. The adapter may add typed
Processes, independent-task parallelism, Devices, leases, joins, and long-running recovery. It must
not change or gate ordinary Story Auto behavior.

## Release evidence

The source tree committed as `32a2ce555342d8d91bd13806dea1947ceafade7d` passed the integrated release
validation below on 2026-09-01. This evidence update changes documentation and the generated help
catalog only; it does not alter the tested runtime.

- `npm test`: 3,781 passed, 0 failed, 0 cancelled, 0 skipped.
- Focused Auto suite: 140 passed, 0 failed, including Candidate mutation, crash recovery, exact
  repair lineage, Human Requests, entry modes, reports, and token economics.
- VS Code validation: typecheck and build passed; 42 focused UI tests and the extension-host Auto
  command-wiring test passed.
- `npm run check`: 1,095 checks passed. Existing vocabulary advisories remained non-blocking.
- `npm run operation-catalog:check`: generated operation-policy catalog was current.
- `npm pack --dry-run --json`: package dry-run passed with 918 entries.
- Full-suite coverage includes Story lifecycle, publication recovery, model boundaries, prompt
  audit, schema migrations, packaged CLI, fresh-repository journeys, and VS Code surfaces.
- Security and integrity coverage includes duplicate-effect prevention, counterfeit-model,
  credential-leak, symlink/oversize private-store, and individual-scoring tripwires.
