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

The measured-read-model portion of `SGOS-P2-003` was added at `main@c18b8154` on 2026-09-07.
It supplies a local, content-free release-gated benchmark; it does not supply consent for external
telemetry or signed supported-machine evidence.

The code-local `SGOS-P0-004` release-proof boundary landed at `main@7304c65c` on 2026-09-07.
Platform-evidence schema v2, signed receipt generation, six-cell merge, and release promotion now
require distinct retained proof for both end-to-end journeys, interruption, counterfeit-authority,
cross-machine, and reviewed performance exercises. No physical or independent receipt is inferred
from those validators.

The first `SGOS-P1-003` store-interface increment landed at `main@28819374` on 2026-09-07. The
filesystem Authority Store now publishes a versioned, immutable capability contract; structural
SPI conformance is tested separately from the installed-profile allowlist, so a repository or
caller cannot authorize an alternate Store by supplying a compatible-looking object. This is the
safe Authority interface boundary. The bounded alternate Operational Store landed at
`main@cf06f10d`: its in-memory replay profile is limited to simulation/test, explicitly
non-authoritative, serialized, CAS-protected, append-only, bounded, backup/restore capable, and
rollback-preserving. Commit `32f1afd0` adds the matching durable `filesystem-replay-v1` profile and
runs the unchanged conformance journey against both implementations. The durable profile rebuilds
its head from fsynced immutable events, rejects competing stale CAS writers and corrupt lineage,
recovers an abandoned writer lock, ignores unfinished staging files, and preserves append-only
rollback and exact fast-forward restore. The live filesystem Process store has not migrated through
that SPI, so live-format migration and runtime cutover remain open.

The first `SGOS-P1-002` advanced-orchestration slice is implemented in the current increment. A
bounded `quorum` join can require an exact finite number of successful predecessors, becomes ready
without waiting for unrelated non-contributors, and emits a separate immutable receipt that binds
the full configured predecessor set and the deterministic successful contributors. Record indexes,
transition verification, process fsck, evidence export, schema migration, and terminal scheduling
all understand that receipt without changing historical `join-receipt` bytes.

The next code-local slice installs one model-free `deterministic-reduce` policy. Its only installed
reducer, `canonical-output-ref-set-v1`, waits for every predecessor to succeed, canonicalizes each
predecessor's exact output-reference set, and produces their sorted unique union. A separate
immutable reducer receipt binds the reducer ID, predecessor receipts, exact reducer inputs, and
result. Arbitrary reducer code and unreviewed reducer IDs remain refused.

The manual-reconciliation slice reuses the approved Human Request authority path. It waits for
every predecessor to become terminal, presents only exact predecessor identities as selectable
options, and derives outputs from the selected predecessor rather than accepting human-authored
references. Its immutable receipt binds the complete terminal snapshot, request, response,
selected predecessor, and exact selected outputs. Rejection and cancellation terminate without a
join receipt or successful output.

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

### [~] SGOS-P0-004 — End-to-end release proof

Prove complete software-conversion and hypothesis-analysis journeys and issue an exact signed release
receipt for the supported platform matrix.

Acceptance gates:

- both journeys run from confirmed intent through verified publication and recovery exercises;
- the supported Windows/macOS/Linux and Node matrix is explicit and green;
- performance, interruption, counterfeit-authority, and cross-machine cases are included;
- one signed receipt binds source commit, packaged artifacts, schemas, tests, and platform results.

Depends on: all other P0 items required by the selected end-to-end journeys.

The code-local contract is implemented at `main@7304c65c`. Historical v1 platform evidence remains
readable, but new receipt generation, aggregate merge, and release promotion require the v2 SGOS
profile in every signed cell. The validator binds six distinct external evidence digests and one
reviewed performance-budget profile without admitting raw logs, paths, commands, URLs, prompts, or
credentials. The operator sequence is documented in
[SGOS end-to-end release proof](SGOS-END-TO-END-RELEASE-PROOF.md).

This item remains `[~]`: independent reviewers must still execute both journeys and the recovery,
counterfeit, cross-machine, and performance exercises on physical macOS/Linux/Windows hosts under
Node 20 and 22, then retain one reviewed signed aggregate for the exact final release artifacts.

## P1 — execution breadth

### [ ] SGOS-P1-001 — Additional governed execution adapters

Support model-backed or tool-bearing `AGENT` execution beyond the reviewed Copilot proposal-only
GEU, mutating Devices beyond sandbox CAS, and reviewed third-party adapters.

Acceptance gates:

- each adapter has an exact manifest, bounded inputs/outputs, cancellation, timeout, and quiescence;
- proposal, verification, approval, and execution authorities remain separate;
- counterfeit model, tool escalation, prompt leakage, and post-effect failure suites pass;
- no adapter can mint success, verification, or policy authority.

### [~] SGOS-P1-002 — Advanced orchestration and recovery

- **Owner:** Codex orchestration continuation
- **Branch:** `main`
- **Started:** 2026-09-07
- **Target:** staged SGOS execution-breadth release after the P0 release gates

Add dynamic or nested bounded fan-out, quorum/reducer/manual-reconcile joins, general idempotent
effect replay, non-genesis fork import, and consequential-effect task retry.

Implemented in the current increment:

- `quorum` is an installed finite join policy with an explicit `requiredSuccesses` threshold;
- readiness distinguishes a reachable threshold from an impossible one and can dispatch as soon as
  the threshold is met;
- a new immutable `quorum-join-receipt` v1 family binds the full configured input set, exactly the
  canonical successful threshold, their attempt/receipt lineage, and their output references;
- compilation, runtime publication, record indexes, transition verification, fsck, evidence export,
  schema migration, and the umbrella JSON Schema share that contract;
- `END` scheduling waits until every other task is terminal, so an early quorum cannot strand a
  still-running non-contributor by prematurely blocking the Process;
- malformed thresholds, missing contributors, counterfeit lineage, and mismatched receipts fail
  closed while existing all-success/all-terminal Programs retain their historical receipt family.
- approved inline fan-out can be nested to the installed depth of four while the compiler enforces
  the 2,000-task and 63-group ceilings before Program publication;
- every nesting level receives its own immutable expansion receipt, and each child carries its exact
  ancestor membership chain so execution admission can reject missing, substituted, or forged
  hierarchy;
- scheduling applies both immediate and ancestor concurrency bounds to distinct item identities,
  allowing parallel leaves within one item without accidentally opening another outer item;
- existing one-level fan-out compiles to the same shape; dynamic/model-created collections remain
  unavailable.
- `deterministic-reduce` is installed with exactly one model-free canonical output-reference-set
  reducer; Program admission, scheduling, immutable receipt validation, transition verification,
  process fsck, evidence export, schema migration, and the umbrella schema share the exact
  reducer identity and input/output contract;
- unreviewed reducers cannot be introduced by Workflow metadata, and the reducer does not execute
  code, read output bodies, access tools, or mint verification authority.
- `manual-reconcile` uses an explicit approved Human authority, becomes `waiting-human` only after
  all predecessors are terminal, and exposes one exact predecessor choice per option;
- accepted selection emits a separate immutable receipt bound to the request, response, complete
  predecessor snapshot, selected predecessor, and exact current outputs; failed predecessor
  selection yields no outputs, while rejection or cancellation yields no success receipt;
- transition verification, process fsck, record indexes, schema migration, and portable Process
  Evidence independently recheck that lineage without trusting mutable task state or arbitrary
  human-provided output references.
- the replay runtime now supports installed-protocol idempotent effect reconciliation without
  repeating a consequential Device operation; the first reviewed protocol retains an exact
  successful `sandbox-cas` task plus its complete in-plan predecessor closure, binds an immutable
  `effect-replay-receipt` to the prior Task Receipt, Tool Intent, Tool Result, idempotency key,
  effect, current postcondition, and outputs, and reopens only downstream work;
- missing or counterfeit reconciliation receipts, changed postconditions, unsupported effects,
  stale plans, and crash/retry at the Process transition boundary fail closed, while read-only
  Devices continue through an ordinary new attempt.

Still required: dynamic fan-out, additional independently reviewed reducer implementations,
non-genesis fork import, consequential-effect retry, and additional reviewed Device-specific
postcondition protocols. The advanced orchestration family also needs shared signed
supported-platform release evidence before this item can become `[x]`.

Acceptance gates:

- every expansion and retry has finite installed ceilings;
- prefix imports prove exact receipts, outputs, effects, evidence, budgets, and event cursors;
- effect replay is idempotency- and reconciliation-bound rather than inferred from task state;
- concurrency, crash-boundary, stale-plan, and duplicate-confirmation tests pass.

### [~] SGOS-P1-003 — General store interfaces

Define a stable Authority Store SPI and add at least one alternate Operational Store.

Implemented code-locally in `main@28819374`:

- Authority Store adapters declare one exact SPI version, canonical profile, Store identity,
  complete method surface, and explicit CAS/lineage/locking/liveness/bounds/schema/backup/rollback
  capabilities;
- the filesystem adapter conforms to that contract;
- conformance never grants installation authority: runtime consumers accept only the immutable
  profile allowlist shipped by the current build;
- counterfeit newer versions, missing methods, weakened capabilities, malformed profiles, and
  uninstalled conforming profiles fail closed.

The alternate Operational Store landed in `main@cf06f10d`:

- `memory-replay-v1` supplies a versioned Operational Store descriptor and one unchanged bounded
  conformance journey for CAS, serialized concurrent writers, append-only event replay, exact
  backups, fast-forward restore, and append-only rollback;
- rejected oversized writes, tampered backups, divergent restore, stale confirmation, and losing
  CAS writers retain the last verified head;
- the selection boundary accepts only `simulation` or `test`, requires the Program's exact pinned
  storage-profile digest, and permanently declares `authorityEligible: false`;
- live runtime and lifecycle publication do not call or auto-select this alternate profile.

The second Operational Store implementation landed in `main@32f1afd0`:

- `filesystem-replay-v1` implements the same SPI and passes the unchanged CAS, concurrent-writer,
  event-replay, backup, fast-forward restore, and append-only rollback journey;
- every committed event is a bounded, fsynced immutable file and the current state is reconstructed
  from exact lineage, so a process loss cannot make an uncommitted head authoritative;
- abandoned writer locks are reclaimed only after the bounded liveness condition, unfinished hidden
  staging files are ignored, and malformed, renamed, missing, reordered, or digest-mismatched events
  fail closed before a later event can be published;
- like the memory profile, it is permanently non-authoritative, accepts only `simulation` or `test`,
  and cannot be selected by the live SGOS runtime or a lifecycle publisher.

Still required: migrate the live filesystem Process store behind the Operational Store SPI and prove
an explicit old-live-format migration plus atomic runtime cutover without changing Program or policy
authority. The unchanged conformance journey now passes against both generic implementations, but
neither generic profile is installed as live execution authority.

Acceptance gates:

- stores preserve CAS, append-only lineage, locking, liveness, size, and schema invariants;
- conformance tests run unchanged against every implementation;
- migration, partial failure, backup, restore, and rollback are proven;
- store selection cannot weaken Program or policy authority.

### [~] SGOS-P1-004 — Fresh-authority evidence reconstruction

- **Owner:** repository maintainers
- **Branch:** `main`
- **Started:** 2026-09-05
- **Code-local implementation:** `0b39863e`
- **Target:** next signed supported-platform release

Reconstruct evidence from fresh authority rather than trusting historical projections.

Acceptance gates:

- every reconstructed claim links to exact immutable source records;
- omissions, contradictions, stale authority, and unavailable evidence remain visible;
- reconstruction is deterministic and bounded;
- counterfeit or reordered trace material is refused.

Implemented on 2026-09-05 as a separate read-only, model-free reconstruction report. Portable
historical evidence keeps its original limited assurance. `evidence reconstruct` first validates
the exact content-addressed local trace, then refreshes Program/Capability Pack authority and
revalidates exact Story-baseline and pinned-policy sources. Claims cite immutable Process records
or approved Git blobs; missing, stale, unconfigured, and contradictory authority remains explicit.
The code-local deterministic, bounded, missing/stale-authority, command-contract, no-model, and
counterfeit-trace tests pass. This item remains `[~]` until the unchanged command and packaged
engine receive signed Windows/macOS/Linux release-matrix evidence; local tests are not that proof.

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
- **Implementation commits:** `258ce110`, `6768e191`
- **Target:** staged P2 continuation after independent certification design

The first bounded environment slice is implemented. A signed active Pack still owns the exact
lesson/module digest; a separate self-hashed fixture admits only secret-scanned UTF-8 text at
portable relative paths. `learn materialize` previews the exact Pack, module, fixture, byte count,
and plan digest, then rechecks Pack authority under a mission lock before writing inert files only
inside Git-common private storage. `learn workspace` verifies those bytes without Pack credentials,
and confirmation-bound `learn reset` removes only the selected machine-local tutorial. The surface
executes no fixture content, changes no application or Git bytes, starts no Process, and grants no
approval, certification, or employee score.

The portable-progress slice is also implemented. `learn check` persists only successful check IDs
in private Git-common storage after revalidating the same signed Pack mission before and after
deterministic evaluation. `progress-export` creates an explicit canonical content-addressed copy
token; `progress-import` accepts it only for an exact matching materialized workspace, previews the
merge, requires its exact confirmation digest, and can only add completed checks. Records and
transfers exclude failed attempts, answers, identity, timing, paths, scores, approval, and
certification.

The recovery and migration slice is implemented in the current increment. A pre-manifest partial
workspace is now surfaced as `interrupted`, with a stable `repeat-confirmed-materialize` recovery;
the same confirmed operation reuses only byte-identical immutable files and publishes the missing
manifest, while conflicting learner edits remain refused. Learning progress schema v2 adds an
explicit identity-free monotonic profile. Canonical v1 records and copy tokens are integrity-checked,
migrated in memory, remain importable, and upgrade durably only on the next successful monotonic
write.

The offline-distribution slice is implemented in the current increment. `bundle-create` publishes
one new bounded canonical module/fixture bundle only after the exact local active Pack validates all
bindings. `bundle-inspect` is authority-free; `bundle-materialize` still requires that exact active
Pack and the normal confirmation digest. Existing Git-trusted or signed Authority Store transport
carries Pack authority separately. The learning bundle grants no activation, authority,
certification, model, tool, repository, Git, or network capability.

Acceptance gates:

- tutorial repositories are isolated, disposable, bounded, and cannot affect governed work;
- progress is portable without becoming employee productivity telemetry;
- certification is based on explicit evidence and independent criteria;
- reset, interruption, offline use, accessibility, and version migration are covered.

The isolation, bounds, Pack binding, preview/confirmation, byte-integrity, interruption resume,
reset, no-model, no-authority, identity-free portable-progress, monotonic import, cross-version
migration, and offline-distribution code-local gates are covered. Independently reviewed
certification and accessibility validation remain open; therefore this item is not complete.

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

### [~] SGOS-P2-003 — External telemetry and measured read models

- **Owner:** repository maintainers
- **Branch:** `main`
- **Started:** 2026-09-07
- **Code-local read-model implementation:** `c18b8154`
- **Target:** next signed supported-platform release; external transport remains separately gated

Add a consented external transport beyond the current local, content-free OpenTelemetry projection
and establish semantic read-model latency targets.

The measured read-model half is implemented. `npm run benchmark:sgos-read-model` exercises the
actual canonical Work Object catalog and Command Center projection at 1, 200, and the installed
2,000-task ceiling. It validates byte-deterministic output, emits only aggregate timing/CPU/row/byte
counts, and invokes no model, network, store, Git, lifecycle mutation, or exporter. The enforced
variant applies explicit p95 and serialized-byte ceilings and is part of the POC release gate. The
script and its tests are included in the npm package. See
[SGOS read-model benchmark](SGOS-READ-MODEL-BENCHMARK.md).

This item remains `[~]`: the local budgets still need signed supported-machine baselines, and no
external transport exists. An external transport must not be added until consent, destination,
retention, retry, and independent-disable policy are approved. Local benchmark output cannot grant
that authority.

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
