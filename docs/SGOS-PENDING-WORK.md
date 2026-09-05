# SGOS pending work

This document is the durable backlog for SGOS capabilities that remain deliberately staged. It is
not a list of known regressions in the shipped bounded runtime. The baseline at creation is
`main@adbb2079` on 2026-08-30; that baseline passed all 335 SGOS tests and the repository's 1,029
static checks.

The universal Candidate implementation checkpoint is `main@cb278ca6` on 2026-09-01. Its local
full suite passed 3,974 tests and repository conformance passed 1,215 checks. Those results are not
a substitute for the signed supported-platform release aggregate required below.

This backlog was reconciled against `main@7935d2db` on 2026-09-05. That baseline adds a
DPAPI-CurrentUser-protected Windows Ed25519 authority-transport signer and the separate GDP
developer-local signed runner. Neither addition supplies independent enterprise authority or a
signed supported-platform release aggregate.

## Status rules

- `[ ]` means the capability remains unavailable or behind an explicit refusal boundary.
- `[~]` means an implementation branch exists, but the acceptance gates below are not all proven.
- `[x]` means the implementation, adversarial tests, documentation, migrations, packaging, and
  signed release evidence have landed on `main`.
- A prototype, low-level API, or passing happy-path test is not sufficient to mark an item done.
- Every completed item must name its landing commit and the tests or release receipt that prove it.

## Related staged roadmaps

- [Code Assurance Bridge corrected roadmap](CAB-ROADMAP.md) — design-only and not authorized for
  implementation. Its lifecycle bridge depends on `SGOS-P0-001` and must reuse the existing
  Candidate, Program, approval, evidence, and publication authorities.
- [Witnessed Engineering Loop v0.2](WEL-SPEC.md) — an observe-first integration profile over SGOS,
  CAB, specification quality, knowledge recall, optional AST diagnostics, and the existing
  publication authority. Enforce mode remains unavailable until its CAB and `SGOS-P0-001`
  prerequisites are complete. Its stable deferred-delivery items are tracked in the
  [WEL pending-work backlog](WEL-PENDING-WORK.md).

## P0 — release and portability

### [~] SGOS-P0-001 — Universal Candidate publication

Route every existing lifecycle publication through the reviewed Candidate execution boundary.

- **Owner:** Codex Candidate remediation
- **Branch:** `main`
- **Started:** 2026-09-01
- **Implementation commit:** `cb278ca6`
- **Target:** next `0.9.x` release after signed platform proof

Story, Initiative, ad hoc landing, governed Goal, Initiative child-Story materialization, Epic
reservation, capability sibling publication, and direct Story promotion now use verified exact
Candidates. Candidate identity binds the normalized lifecycle event, retained commit and tree,
verification profile and receipt, governed commit trailers, state digest, journal, and pending
recovery marker. V2 recovery records are authenticated before migration and remain explicitly
exact-but-unverified rather than receiving invented assurance. Push and ref races recover only the
retained Candidate; an equal competing ref is not accepted without a sealed transport-indeterminate
attempt.

Acceptance gates:

- every lifecycle freezes and verifies the exact candidate tree before publication;
- protected paths, stale reviews, worktree drift, ref-advance failures, and push failures remain
  recoverable without publishing a different tree;
- compatibility and migration tests cover existing Stories and Workspaces;
- no parallel publication authority remains outside the Candidate boundary.

Depends on: existing Candidate freeze, verify, and publish primitives.

The code-local gates above are implemented. Before `[x]`, the final clean commit still requires the
repository's signed macOS/Linux/Windows by Node 20/22 verification aggregate and exact npm/VSIX
artifact binding. Local macOS/Node 25 runs and simulated Windows process tests are not release cells.

### [ ] SGOS-P0-002 — Live working-set and Secret Broker integration

Inject bounded working sets into live governed Agent execution and release secrets only through the
typed Secret Broker to the exact authorized adapter.

Acceptance gates:

- the working set is bound to the exact Program, Process revision, checkpoint, and task;
- secret-shaped values never enter prompts, logs, telemetry, evidence, or ordinary memory;
- cancellation, timeout, stale authority, adapter leakage, and restart are tested;
- a model or adapter cannot expand context or secret scope on its own.

Depends on: shipped typed memory, working-set composition, and Secret Broker APIs.

### [~] SGOS-P0-003 — Portable authority and Capability Pack transport

Move approved Authority Store and signed Capability Pack state between machines without trusting
ambient local paths or rebuilding authority by hand.

The implementation on `main` now provides key-free approved trust v3 with deterministic
state-branch publish/sync on Windows, macOS, and Linux, plus approved trust v2 and a local
non-exported Ed25519 signer protected by owner-only filesystem permissions on POSIX and DPAPI
CurrentUser on Windows, signed repository-bound canonical bundles,
secret/path admission, exact
Pack-graph replay, inspect/import plan-and-confirm, stable-lock and tamper-evident journaled
cutover, strict lineage fast-forward, retained signed import proof, durable cutover receipts, and
explicit history-preserving rollback. Legacy trust v1 remains valid for machine-local Pack use but
cannot authorize transport. Import requires a freshly approved minimum revision/state/export
checkpoint, so an authentic pre-revocation snapshot cannot be mistaken for current authority on a
new machine. The portable profile currently accepts only complete Capability Pack histories; mixed
or other Authority Store namespaces fail closed until they have their own semantic verifier.
Transport v2 makes its trust boundary explicit: approved exporters are complete Store-snapshot
attestors, not low-privilege byte couriers. Their signed envelope vouches for historical decisions;
deterministic semantic replay separately refuses illegal Pack histories.
Git-trusted v3 explicitly delegates outer transport authenticity and new-clone rollback protection
to the configured Git remote and its branch controls; Capability Pack publisher signatures and
semantic replay remain mandatory.

Acceptance gates:

- export/import is content-addressed, signed, repository-bound, credential-free, and path-neutral;
- missing, revoked, superseded, counterfeit, or partially copied authority fails closed;
- Windows, macOS, and Linux round trips reproduce the same active authority;
- migration and cutover preserve history and support an explicit rollback plan.

Depends on: the experimental filesystem Authority Store and signed Pack authority records.

The code-local and adversarial round-trip gates are implemented, including Windows signer creation
and export through DPAPI-protected key material. This item remains `[~]` until the same canonical
fixture has real signed macOS, Linux, and Windows release receipts proving identical active
authority and cutover recovery on the supported Node matrix. Simulated Windows tests and the
developer-local GDP runner are not substitutes for those receipts.

### [ ] SGOS-P0-004 — End-to-end release proof

Prove complete software-conversion and hypothesis-analysis journeys and issue an exact signed release
receipt for the supported platform matrix.

Acceptance gates:

- both journeys run from confirmed intent through verified publication and recovery exercises;
- the supported Windows/macOS/Linux and Node matrix is explicit and green;
- performance, interruption, counterfeit-authority, and cross-machine cases are included;
- one signed receipt binds source commit, packaged artifacts, schemas, tests, and platform results.

Depends on: all other P0 items required by the selected end-to-end journeys.

## P1 — execution breadth

### [ ] SGOS-P1-001 — Additional governed execution adapters

Support model-backed or tool-bearing `AGENT` execution beyond the reviewed Copilot proposal-only
GEU, mutating Devices beyond sandbox CAS, and reviewed third-party adapters.

Acceptance gates:

- each adapter has an exact manifest, bounded inputs/outputs, cancellation, timeout, and quiescence;
- proposal, verification, approval, and execution authorities remain separate;
- counterfeit model, tool escalation, prompt leakage, and post-effect failure suites pass;
- no adapter can mint success, verification, or policy authority.

### [ ] SGOS-P1-002 — Advanced orchestration and recovery

Add dynamic or nested bounded fan-out, quorum/reducer/manual-reconcile joins, general idempotent
effect replay, non-genesis fork import, and consequential-effect task retry.

Acceptance gates:

- every expansion and retry has finite installed ceilings;
- prefix imports prove exact receipts, outputs, effects, evidence, budgets, and event cursors;
- effect replay is idempotency- and reconciliation-bound rather than inferred from task state;
- concurrency, crash-boundary, stale-plan, and duplicate-confirmation tests pass.

### [ ] SGOS-P1-003 — General store interfaces

Define a stable Authority Store SPI and add at least one alternate Operational Store.

Acceptance gates:

- stores preserve CAS, append-only lineage, locking, liveness, size, and schema invariants;
- conformance tests run unchanged against every implementation;
- migration, partial failure, backup, restore, and rollback are proven;
- store selection cannot weaken Program or policy authority.

### [ ] SGOS-P1-004 — Fresh-authority evidence reconstruction

Reconstruct evidence from fresh authority rather than trusting historical projections.

Acceptance gates:

- every reconstructed claim links to exact immutable source records;
- omissions, contradictions, stale authority, and unavailable evidence remain visible;
- reconstruction is deterministic and bounded;
- counterfeit or reordered trace material is refused.

### [ ] SGOS-P1-005 — Multi-domain proof packs

Provide signed proof packs for more than one governed domain without introducing domain-specific
authority shortcuts.

Acceptance gates:

- each pack has independent review, activation, revocation, and conformance evidence;
- shared contracts remain domain-neutral and versioned;
- cross-domain dependency and policy conflicts fail closed;
- pack portability uses the approved transport from SGOS-P0-003.

## P2 — operator and learning experience

### [ ] SGOS-P2-001 — Executable guided learning

Add disposable tutorial environments, portable progress, and certification beyond the current
read-only mission descriptors.

Acceptance gates:

- tutorial repositories are isolated, disposable, bounded, and cannot affect governed work;
- progress is portable without becoming employee productivity telemetry;
- certification is based on explicit evidence and independent criteria;
- reset, interruption, offline use, accessibility, and version migration are covered.

### [ ] SGOS-P2-002 — Meta-tool activation CLI

Expose reviewed activation, observation, revocation, and rollback APIs through a public CLI only
after a canonical approved Pack/Device target resolver exists.

Acceptance gates:

- callers cannot supply target authority through arbitrary local files;
- every mutation is previewed, confirmation-bound, CAS-protected, and auditable;
- stale, revoked, superseded, self-evaluated, or self-promoted targets are refused;
- CLI, API, VS Code, help, and schema behavior agree.

### [ ] SGOS-P2-003 — External telemetry and measured read models

Add a consented external transport beyond the current local, content-free OpenTelemetry projection
and establish semantic read-model latency targets.

Acceptance gates:

- transport is opt-in, content-free by default, bounded, retry-safe, and independently disableable;
- prompts, secrets, paths, identities, and individual productivity measures are excluded;
- latency targets have reproducible fixtures and supported-machine baselines;
- telemetry failure never blocks governed execution or weakens evidence integrity.

## Maintenance

When work begins, change only the selected item's marker to `[~]` and add its branch or Story ID.
When it lands, change it to `[x]`, record the exact commit and verification evidence, and update the
staged-boundary summary in `docs/SGOS.md`. New scope belongs in a new stable backlog ID rather than
silently expanding an existing item.
