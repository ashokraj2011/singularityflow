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

### [~] SGOS-P0-002 — Live working-set and Secret Broker integration

Inject bounded working sets into live governed Agent execution and release secrets only through the
typed Secret Broker to the exact authorized adapter.

- **Owner:** Codex working-set integration
- **Branch:** `main`
- **Started:** 2026-09-05

The code-local Agent path now composes a deterministic working set from the exact current Program,
Process revision, checkpoint, and task before an execution attempt opens. The complete working set
is content-hashed into the Agent Task Contract and the proposal-only Copilot invocation. Symbolic
legacy inputs are not promoted, opaque Secret Broker handles are forced into the omission ledger
instead of ordinary input payloads, and the Copilot contract cannot redeem them or use tools.
Runtime tests inspect the actual provider prompt rather than only the composer API.

This is not complete Secret Broker integration. No installed real external Agent or Device adapter
receives an ephemeral broker release yet, and no external-adapter cancellation/leakage/restart
matrix has been signed on the supported platforms.

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

### [~] SGOS-P2-001 — Executable guided learning

Add disposable tutorial environments, portable progress, and certification beyond the current
read-only mission descriptors.

- **Owner:** Codex guided-learning continuation
- **Branch:** `main`
- **Started:** 2026-09-06
- **Implementation commit:** `258ce110`
- **Target:** staged P2 continuation after portable progress and independent certification design

The first bounded environment slice is implemented. A signed active Pack still owns the exact
lesson/module digest; a separate self-hashed fixture admits only secret-scanned UTF-8 text at
portable relative paths. `learn materialize` previews the exact Pack, module, fixture, byte count,
and plan digest, then rechecks Pack authority under a mission lock before writing inert files only
inside Git-common private storage. `learn workspace` verifies those bytes without Pack credentials,
and confirmation-bound `learn reset` removes only the selected machine-local tutorial. The surface
executes no fixture content, changes no application or Git bytes, starts no Process, and grants no
approval, certification, or employee score.

Acceptance gates:

- tutorial repositories are isolated, disposable, bounded, and cannot affect governed work;
- progress is portable without becoming employee productivity telemetry;
- certification is based on explicit evidence and independent criteria;
- reset, interruption, offline use, accessibility, and version migration are covered.

The isolation, bounds, Pack binding, preview/confirmation, byte-integrity, reset, no-model, and
no-authority code-local gates are covered. Portable progress, interruption-resumable exercises,
independently reviewed certification, accessibility validation, offline Pack/fixture distribution,
and cross-version progress migration remain open; therefore this item is not complete.

### [~] SGOS-P2-002 — Meta-tool activation CLI

Expose reviewed activation, observation, revocation, and rollback APIs through a public CLI only
through canonical approved Pack and Device target resolvers.

Acceptance gates:

- callers cannot supply target authority through arbitrary local files;
- every mutation is previewed, confirmation-bound, CAS-protected, and auditable;
- stale, revoked, superseded, self-evaluated, or self-promoted targets are refused;
- CLI, API, VS Code, help, and schema behavior agree.

The code-local Pack and Device operation paths are implemented on `main`: the Pack registry resolves
one current operation from a single verified Authority Store snapshot, the platform service exposes
read-only activation/observation/revocation/rollback plans, and the CLI requires the exact plan
digest before performing its CAS-protected mutation. A Device target uses the canonical qualified
identity `device:<device-id>:<operation-id>`. SFlow accepts it only when the exact operation exists
in an installed, nonrevoked Device manifest and a current signed, independently reviewed Capability
Pack exports that qualified operation. The resulting activation binds both the Device manifest and
version and the Pack activation/review authority. Callers cannot provide a manifest, approval digest,
or parallel trust store.

Stale confirmations, self-activation, superseded or revoked targets, invalid outcomes, and policy
limits fail closed. Help and the VS Code command classifier recognize preview as read-only and
confirmed execution as mutation. The native **Review Meta-tool Authority...** wizard explicitly
selects Pack versus Device, collects only bounded selectors, invokes the same preview, displays exact
Store/target/approval facts, and sends the confirmation only after a modal human decision.

This remains `[~]` under the roadmap completion rule until the supported npm/VSIX and platform
release matrix supplies signed evidence for these public authority surfaces. The former code-local
Device target-resolution gap is closed; external release proof is not inferred from local tests.

Implementation checkpoints: `5cc31bee` (canonical signed-Pack target resolution, deterministic
mutation plans, public CLI, help, VS Code classification, and end-to-end authority tests) and
`8ab16f79` (native bounded preview/confirm review form in the Command Center), and `f24e2db4`
(canonical installed/nonrevoked Device operation resolution, signed-Pack authorization, native
target-kind selection, and end-to-end refusal tests).

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
