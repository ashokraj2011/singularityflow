# AUT v2 implementation roadmap

Status: incremental implementation; Story profile only. This document records the validated gap
between `SingularityFlow_AUT_v2_Developer_Auto_Mode_Spec.md` and the shipped kernel. It is not a
claim that every AUT v2 release criterion is complete.

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
- The default repair posture is no hidden retry. Automatic repair is not enabled until a typed
  refusal, exact repair scope, immutable Candidate, and attempt lineage all exist.

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

## P0 before AUT v2 can be called release-complete

1. **Immutable Candidate authority**
   - Freeze an exact Candidate outside the mutable worktree.
   - Bind deterministic verification, any approval, and publication to the same Candidate SHA.
   - Refuse add/delete/rename/mode/symlink or source mutation after freeze before any push.

2. **Governed boundary checkpoints**
   - Persist phase, human, publication, recovery, and completion checkpoints through the existing
     Story publication transaction.
   - Keep `.git` state explicitly operational/rebuildable and reconstruct it after clone or crash.

3. **Sequential phase continuation**
   - Reconcile a legitimate approved phase transition without treating it as arbitrary drift.
   - Pin the context/task/execution-unit contract for every phase, not only the first phase.
   - Implement exact `phase` and `continuous` endpoint behavior across the entire Story rail.

4. **Enforced task scope**
   - Provider adapters must enforce read/write roots at tool time. The current post-execution scope
     recomputation prevents publication but cannot claim pre-effect write isolation.

5. **Runtime record contracts**
   - Add closed-vocabulary validators and real versioned fixtures for each emitted Auto family.
   - Verify stored self-hashes before migration or use version-aware integrity envelopes.
   - Do not register placeholder families that no state transition actually emits.

## P1 product increments

1. Typed phase-run and attempt lineage with stable attempt ID, parent, reason, task/context/unit
   hashes, budget impact, and result.
2. Structured refusal and ask-only Repair Plan. Then add one machine-actionable repair attempt and a
   deterministic second-failure halt comparison.
3. Typed clarification/credential/architecture Human Requests while continuing to use the existing
   approval machinery for decisions.
4. `auto continue`, existing-Story intake, Ad Hoc adoption, Goal seeding, and execution-unit switch
   only after their exact plans and lineage records exist.
5. Authority-backed reports, token-economics receipts, WMB/CMP references, and Home/Return
   projection.
6. Read-first Gateway mappings behind the existing five tools, then My Work and VS Code Plan,
   running, refusal, Needs You, takeover, and report cards.

## P2 optional profile

Add the SGOS adapter only after the Story profile release gates pass. The adapter may add typed
Processes, independent-task parallelism, Devices, leases, joins, and long-running recovery. It must
not change or gate ordinary Story Auto behavior.

## Release evidence required

- Full Story lifecycle, publication recovery, model boundary, prompt audit, schema migration,
  packaged CLI, and VS Code suites pass on the exact commit.
- Candidate mutation and crash-boundary suites prove no duplicate model call, commit, push, or
  consequential effect.
- A fresh disposable repository completes the thin Story journey with one model attempt and no
  hidden repair.
- Counterfeit-model, credential-leak, symlink/oversize private-store, and individual-scoring
  tripwires pass.
