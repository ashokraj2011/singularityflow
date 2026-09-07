# SingularityFlow Governed Execution Operating System

SGOS is the additive execution layer that turns confirmed intent into a finite, content-addressed
program. It does not replace the existing Story lifecycle. Story `workflow.json`, phase publication,
submission, and approval remain the authority for existing work; supported lifecycle publishers
delegate their Git mutation to the shared Candidate boundary.

For the developer and operator sequence—from choosing the normal Story flow through explicit
Intent-to-Process execution, recovery, and Git-trusted Pack sharing—read
[How to use SGOS](SGOS-USAGE-GUIDE.md).

## What this release implements

The installed SGOS profile is deliberately bounded enough to audit end to end:

```text
confirmed Intent IR
  -> ratified Workflow IR
  -> deterministic GVM Program
  -> resumable Process
  -> deterministic compatible ready set
  -> verification
  -> immutable Task Receipt
  -> deterministic join or boundary checkpoint
  -> projection-only Work Object and evidence
```

It provides:

- versioned, content-addressed contracts for intent, policy, workflow, ratification, programs,
  process bindings, processes, attempts, receipts, human requests, evidence, and UI projections;
- model-free compiler profile v3 with a closed opcode vocabulary, deterministic output, and an
  exact Capability Pack authority digest;
- compile-time refusal of unbounded work, cycles, orphan tasks, unmapped confirmed clauses,
  missing evidence, ungoverned judgment, unsafe overlapping writes, and consequential external
  effects without recovery;
- a GVM executor for deterministic kernel operations, verification, checkpoints, human requests,
  no-ops, terminal steps, one exact deterministic-translator `AGENT`, one exact read-only
  filesystem `DEVICE`, and a bounded parallel wave selected from exact resource contracts;
- static compile-time fan-out with stable item keys, installed `all-success`, `all-terminal`,
  finite `quorum`, and model-free `deterministic-reduce` joins, immutable resource leases, and
  policy-specific join/fan-out receipts;
- execution admission that requires an exact Program approval loaded from `sflow/config` (or its
  verified state mirror); deterministic recompilation can corroborate it, but a Program self-hash,
  caller-supplied digest, or compiler inputs alone are never authority;
- explicit versioned built-in-core Pack authority for compatibility, plus one signed declarative
  domain-Pack path that binds the exact reviewed activation, publisher, repository identity, and
  operation allowlist at compile time and revalidates them before every execution mutation;
- reviewed, read-only CLI adapters for exact Story inspection and repository-clean verification;
- machine-local operational checkpoints under the repository Git common directory, protected by
  subject locks, expected revisions, atomic replacement, and content hashes;
- durable execution-owner leases, running/terminal attempt lineage, dispatch and pre-publication Git
  binding checks, and exact interrupted-execution recovery confirmations;
- an explicit Process stop boundary that records `paused` immediately, forwards cancellation to an
  active adapter, prevents a late success receipt, and reports quiescence only after the exact
  attempt and owner lease have settled;
- success only after deterministic verification creates a Task Receipt;
- stale-response protection, configured-Git-identity authority pinning, JSON Schema input, and
  non-secret external/broker handles for typed Human Requests;
- deterministic simulation, ready-set calculation, bounded evidence construction from supplied
  trusted observations, and projection-only Work Objects;
- a compatibility adapter that can describe existing Story workflows without giving SGOS local
  state authority over a Story.

The same build also contains separately bounded extension profiles:

- a Git-backed Candidate publication boundary used by the supported Story, Initiative, ad hoc,
  Goal, Epic, capability, and direct-promotion lifecycle surfaces. Automatic lifecycle verification
  proves the exact prospective Git-object tree without checkout hooks, filters, or model work, and
  binds its lifecycle event, verification receipt, commit trailers, journal, and recovery marker.
  Explicit standalone `candidate verify` remains the isolated-worktree path for approved verifier
  commands. Those commands and their timeout come only from the exact approved
  `singularity/sgos/candidate-verifier-policy.json` record on `sflow/config` (or its verified state
  mirror). Legacy command-line verifier inputs remain compatibility assertions only: they must
  equal the approved policy exactly and cannot select different authority. Verification receipts
  bind that policy and the admitted executable digest, but portable race-free execution of
  arbitrary host executables is not claimed;
- proposal-only Copilot and an installed deterministic local-translator Execution Unit. Only the
  local translator's exact registry-pinned manifest can execute an `AGENT` task, and its output is
  independently reconstructed before the runtime can mint verification. Copilot remains unable to
  mint verification or advance Process authority. A fixed-argv pure-process factory remains
  experimental and is not part of the installed manifest catalog because the host cannot yet pin
  an executable handle portably across launch;
- one read-only filesystem Device and one local consequential sandbox-CAS Device with durable Tool
  Intent/Tool Result recovery and exact confirmation-bound revocation;
- confirmation-bound suffix replay plus genesis and exact non-genesis checkpoint fork commands;
  a non-genesis child imports separately receipted recovery attempts, outputs, verification,
  source evidence, and consumed attempt budget while the parent remains the authority for the
  original execution. Replay preserves immutable
  attempt/receipt history, re-executes pure and read-only work, and retains an already-successful
  consequential Device task only after its installed postcondition protocol proves the original
  idempotency key, Tool Result, effect, and current state without executing the effect again;
- an experimental filesystem Authority Store, typed memory promotion, signed/revocable declarative
  Capability Packs, a read-only role lesson catalog, and human-gated meta-tool review, activation,
  observation, revocation, and rollback authority. A meta-tool activation binds the exact candidate,
  independent signed evaluation, promotion, approved Pack/Device operation version and manifest,
  and a bounded observation policy. Runtime lookup revalidates that complete lineage and refuses a
  revoked, superseded, or stale selection. Every
  Pack, memory, and meta-tool mutation derives its actor from the repository Git identity, proves
  membership in the operation's group from refreshed approved configuration, and binds that exact
  configuration commit and group digest into the Authority Store event. Caller-supplied actor and
  reviewer flags are refused, and raw email addresses are represented by a stable private digest;
- a projection-only VS Code Command Center with a deterministic process graph, human-request forms,
  unavailable-Process diagnostics, and lazy slice leases.

These extension profiles are not a claim that the complete SGOS v1 release criteria are met. Their
installed limits and refusal behavior are part of the product contract.

The default platform mutation policy assigns proposals and registrations to
`engineering-reviewers`, signed evaluation recording to `quality-reviewers`, and review,
promotion, activation, revocation, and rollback to `architecture-reviewers`; observation recording
defaults to `quality-reviewers`. An organization may replace an
operation's group under `sgos.platformAuthorities` in approved `workflow.yml`; a working-tree edit
cannot change the decision.

## Safety boundary

The GVM admits only the reviewed registry-pinned adapter identities, including the
`deterministic-translator` Execution Unit, the proposal-only `copilot-cli` Execution Unit, the
read-only `filesystem-read` Device, and the fixture-only consequential `sandbox-cas` Device.
The translator has no model, tools, repository scope, subagents, or effects. The Device accepts
only `read-file` or `stat` inside its compiled canonical read scope, refuses links and path escape,
and must produce a verified effect-free Tool Result. `sandbox-cas` can publish only one absent-state
compare-and-swap value under Git-common SGOS fixture storage when its compiled write and effect scope
exactly match; it records Tool Intent first and verifies recovery without replay. Dotted task
operation IDs remain separate from
the kebab-case adapter IDs; the Program and registry bind both. Approved inline fan-out may be
nested to four finite levels; every level is pre-expanded before Program hashing, receives an exact
expansion receipt, and applies its own distinct-item parallel ceiling. The installed join policies
are `all-success`, `all-terminal`, finite-threshold `quorum`, and `deterministic-reduce` with the
exact `canonical-output-ref-set-v1` reducer, plus Human-authority-bound `manual-reconcile`.
The reducer consumes only already-bound output references; it cannot execute code or upgrade their
assurance. Manual reconciliation waits for terminal predecessors and lets an approved reviewer
select exactly one predecessor; the runtime derives that predecessor's current output references
and binds the request, response, selection, and terminal snapshot in an immutable receipt.
Unreviewed model-backed `AGENT`,
any other consequential or uninstalled `DEVICE`, model-created or runtime-dynamic fan-out, unsafe
parallel execution, and all other join policies still fail closed.

The runtime API also requires separately registered kernel handlers, Candidate Snapshot capture,
and deterministic verifiers. The CLI installs only two reviewed read-only pairs:
`sflow.story.inspect`/`.verify` and `sflow.repository.assert-clean`/`.verify`. `process step` also
runs intrinsic `NOOP`, `CHECKPOINT`, `HUMAN_REQUEST`, and `END` boundaries. Every other kernel task
without exact registry pins and trusted adapter wiring remains unavailable without mutating state.

Process projections and caches are rebuildable. Deleting Process operational state cannot alter
Story or Git authority, but it can destroy resumability and evidence and is never an approved
recovery action. Candidate retention refs and the experimental platform Authority Store are durable
authority and are explicitly **not** rebuildable caches. A local Process can observe and project
existing Story state, but only the established lifecycle kernel may publish a phase, submit it,
approve it, or advance it.

Candidate publication treats branch ref advancement and index alignment as two recoverable durable
boundaries. A retry after the ref advances first proves that the worktree still equals the exact
verified Candidate, idempotently aligns the index to that tree, verifies clean HEAD/index/worktree
identity, and only then writes the publication receipt. It never resets or overwrites a divergent
worktree during recovery. A same-valued competing remote ref is not inferred to be this transaction's
success unless the local compare-and-swap completed or a sealed transport-indeterminate attempt binds
that exact Candidate. Authenticated legacy recovery remains exact-only and never receives invented
verification assurance.

The Candidate verifier policy is a strict, content-addressed JSON record. It declares
`format: sflow.sgos.candidate-verifier-policy/v1`, one canonical `policyId`, `decision: approved`,
bounded absolute-argv `commands`, the exact `timeoutMs`, a typed `approvedBy` principal,
`approvedAt`, and the derived `policySha256`. Missing, malformed, locally substituted, or newly
superseded policy bytes fail closed. A policy update invalidates earlier verification for new
publication plans; if the application branch already completed the confirmed compare-and-swap,
recovery finishes only that exact transaction before recording its receipt.

For a Story Process, start is admitted only after the Work ID resolves to a contract-valid Story in
the exact baseline commit. The Process Binding pins that Story's repository-relative path, content
digest, normalized state digest, and revision; dispatch and the built-in Story adapter revalidate
the same immutable authority instead of trusting a caller-supplied Work ID or working-tree bytes.

Security note for the first hardened build: v1 Process state, Process Bindings, and Human Requests
did not contain the complete authority required by v2 and are intentionally not resumed as trusted
records. They remain machine-local evidence. Run `singularity-flow process quarantine <PROCESS-ID>`
to preview their exact bounded tree digest, then rerun the printed command with `--confirm
<TREE-SHA256>`. The confirmed operation rehashes under the Process lock, refuses a live execution
owner, and atomically moves the unchanged directory into managed SGOS quarantine. It never deletes
or rewrites evidence and never restores the v1 Process as v2 authority. `process archive` is only a
compatibility alias and returns the same quarantine-labelled result.

The same fail-closed quarantine accepts three readable Process crash shapes. The first is an exact
current-v3 private creation seed interrupted before genesis publication: revision 1, null control
head, deterministic Program-and-Binding task materialization, no progressed task, and no attempt,
receipt, evidence, request, lease, checkpoint, or control record. The other two shapes (including a
stored v2 Process migrated only in memory) have exactly one latest interrupted task whose terminal
attempt was either marked `succeeded` without its immutable receipt, or marked `failed` before
either Action Evidence or a receipt was durably published. The failed shape is never retryable, and
none of the three shapes is task success. The execution lease must be missing or owned by a dead
process. Quarantine validates every readable current record and the complete available lineage,
preserves the exact bytes, and offers no retry, restore, or resume path.

Exact writer leftovers named `<recognized-target>.pending-<PID>-<UUID>` are reported in the preview,
bound into the confirmed tree digest, and moved as opaque bytes. They are never parsed or restored;
pending-like files outside that exact writer pattern are refused. Every writer and quarantine use the
same installed per-record byte ceiling, while the quarantine tree limit is derived from the admitted
worst-case attempt and control-record envelopes plus a bounded leftover allowance. Healthy current
state, multiple incomplete terminal attempts, live leases, future schemas, malformed contracts,
hash/path mismatches, and unrelated corruption are refused. Start a new Process from the approved
Program afterward; Story and Git state are not changed.

Process listing remains fail-safe when one private or unreadable Process cannot be authorized. It
returns healthy Processes normally and an explicit `sgos-process-unavailable` diagnostic for each
refused Process, with no runnable state, success claim, or resume permission. Inspect that exact ID
with `process quarantine`; listing never repairs, migrates, or silently hides its bytes.

### Runtime API compatibility

This hardened profile is an intentional SGOS contract boundary change: compiler output is v3 and
mutable Process state is schema v3, rooted in an immutable predecessor-keyed control lineage.
Unshipped/interrupted-development v2 state requires the internal exact-hash upgrade path; ordinary
reads never rewrite it, and shipped v1 state remains quarantine-only because its authority cannot
be recovered. The public `src/sgos/index.mjs` barrel no longer exports local
store writers or CAS primitives (`createSgosProcess`, `mutateSgosProcess`,
`putSgosImmutableRecord`, `sealSgosImmutableRecord`, `buildSgosProcessBinding`, or raw Process-path
helpers). Raw execution adapters, Candidate writers, and injectable test clocks are excluded too.
Those functions remain interpreter internals for the runtime and recovery implementation;
external integrations must use `startSgosProcess`, `stepSgosProcess`, response/recovery operations,
or the `process` CLI. `stepSgosProcess` always constructs the installed manifest-checked adapter
registry; it never accepts caller handlers, Candidate capture, verifiers, or evidence assertions.
Read-only Process, checkpoint, receipt, quarantine-plan, and diagnostic APIs remain public. This
prevents a caller from treating a self-hashed local record or cooperating callback set as execution
authority.

## Contract authoring

Intent and workflow inputs are JSON records. Normative intent fields retain provenance such as
`explicit`, `human-confirmed`, `policy-derived`, or `model-proposed`. A model proposal is never
silently relabelled as human intent.

A workflow task declares:

- one closed opcode;
- dependencies and terminal behavior;
- inputs, outputs, evidence, and verification;
- resource reads and writes;
- external effects and their recovery policy;
- human authority where judgment is required;
- finite retry and expansion ceilings.

For the installed adapter slice, an `AGENT` task keeps its dotted operation ID separate from
`metadata.executionUnitId`; that kebab-case ID, version, and manifest must exist in the pinned
registry's optional `executionUnits` collection. A `DEVICE` task similarly uses a dotted operation
and a separate `metadata.deviceId` present in `devices`. Compilation stamps both identities and
execution admission rechecks the exact registry bytes before the installed-manifest comparison.

For a `HUMAN_REQUEST` task, the typed request descriptor is stored at
`metadata.humanRequest`. A top-level `humanRequest` or `request` field is not valid Workflow IR;
the strict contract refuses it instead of maintaining two representations for the same authority
boundary.

Compilation is pure: timestamps are not injected, source key order is irrelevant, and the same
confirmed records produce the same Program hash.

## Execution and recovery

The scheduler derives the ready set from the Program and current durable Process state. Completion
order is never an authority rule. Each state mutation compares the expected process revision while
holding the process subject lock. Resume requires the exact checkpoint that guards that durable
state. The installed replay profile can reopen a suffix from an ancestor checkpoint. Pure and
read-only tasks are re-executed. A successful consequential Device task is retained only when an
installed exact postcondition protocol can reconcile it without repeating the effect; its complete
in-plan predecessor closure is retained as well so inputs cannot change underneath a reused effect.
The installed fork profile creates an independent Process from genesis or from an exact ancestor
checkpoint. For a non-genesis checkpoint it first reconstructs the parent's historical Process
state from its control lineage and verifies the checkpoint, Program, record index, Task Receipts,
running and terminal attempts, Candidate Snapshots, passing Action Evidence, outputs, human
decisions, and consumed attempt count. The child receives new recovery-attempt identities and one
immutable import record per successful prefix task, followed by an aggregate import checkpoint and
receipt. It never claims that the child executed the parent's work. Consequential Device results
are imported only when an installed protocol revalidates the original idempotency key and current
postcondition without repeating the effect. Unsupported or changed effects, incomplete prefix
closure, stale source evidence, a moved Program/policy/binding, and partial or counterfeit import
receipts fail closed. An interrupted task or aggregate publication is recovered and retried against
the exact same plan without duplicating an attempt or receipt.

Replay clears the suffix tasks' current receipt/output projection while retaining every immutable
historical attempt and receipt for audit; old outputs cannot appear current until a new successful
attempt publishes them. For an installed consequential Device, an immutable
`effect-replay-receipt` instead binds the replay plan, prior Task Receipt, Tool Intent, Tool Result,
idempotency key, effect digest, current postcondition proof, and exact outputs. The replay Process
CAS roots that receipt and retains the effect task and its predecessor closure byte-for-byte while
reopening only downstream work. Crash recovery repeats the transition, never the Device effect. An
`all-terminal` join records failed predecessors as terminal without borrowing their historical
success receipt or outputs. Fork first writes an immutable predecessor intent and creates one
deterministic child genesis bound to the parent's immutable Process Binding; repeating confirmation
recovers the same receipt even if the child has since progressed, while lineage fsck reports
orphaned, corrupt, or incomplete fork records.

An ordinary failed task can be retried only while its Program still has an unused attempt and its
recovery policy explicitly says `retry-safe`. `task retry` first writes a content-addressed preview
bound to the exact Process revision, Program, policy, Binding, checkpoint, failed attempt, and failed
Action Evidence. Confirmation dispatches only that task through the normal Process CAS; the new
attempt names the failed attempt as its immutable parent. Pure work and installed read-only Devices
are supported. Writable, external-effect, and consequential Device retries remain refused: even a
verified consequential effect is a reconciliation fact, not permission to mint a different Tool
Intent.

`process stop <PROCESS-ID>` is distinct from an idle `process pause`. Stop may win while an attempt
is active: it durably records `paused`, requests adapter cancellation, and returns
`stop-requested` until the active attempt and lease disappear. Repeat the command or inspect status
to prove `quiescent`. `process resume` refuses the intermediate paused-but-active state and still
requires the exact current checkpoint. The Command Center exposes the same revision-bound action
behind an explicit confirmation.

Before `process start`, the exact Program must be reviewed at
`singularity/sgos/program-authorities/<PROGRAM-SHA256-WITHOUT-PREFIX>.json` on the approved
configuration authority. That closed record binds the Program hash, ratification hash, approving
principal, decision, and time. `process start` loads it from the exact fetched authority ref; it
never accepts approval bytes or a trusted digest from command arguments. Supplying
`--compiler-request` (or all five compiler input files) additionally proves deterministic
recompilation, but compiler inputs alone do not grant execution authority.

Every dispatched task records an operational owner lease and an immutable running attempt before
the adapter can publish success. Recovery refuses while the owning process is alive. After a crash,
`process recover <ID>` returns confirmation-bound choices. A verified receipt written before the
crash can be reconciled exactly. `retry-safe` is offered only when the task explicitly declares
`recovery.interruptedExecution: retry-safe`, has no writes, devices, or external effects, retains an
attempt, and the repository binding is still current. `fail` stabilizes uncertain work without
claiming success. No recovery action guesses a new digest or discards application files.

Every successful task names its attempt, input and output references, verification result, evidence,
and exact Task Contract hash. Without that receipt, the task is not successful.

When a Program declares a Human Request role matching an approved `approvalAuthorities` group,
`process start` reads that group only from the exact approved `sflow/config` commit or verified
`state` mirror. The Process Binding and Human Request pin the configuration ref, commit,
`workflow.yml` blob digest, required group, minimum assurance, and exact group-definition digest;
they intentionally do not pin the identity that started the Process. Dirty or
application-branch-only protected configuration is refused, so a local self-add cannot grant
authority. `request respond` observes the repository's current Git identity, re-derives that
person's membership from the pinned approved group, requires the exact reviewed Process revision
and Process digest as compare-and-swap inputs, and never accepts authority supplied by a flag.
This lets another currently authorized reviewer complete a handoff without inheriting the starter's
identity or weakening the approved authority definition.
Use `task show` for the compiled template and attempt/receipt lineage, and `task evidence` for exact
candidate, Action Evidence, Human Response, and unresolved external-reference status.

## Simulation and outcome evaluation

`program simulate`, `program what-if`, and `program fault-plan` are deterministic, model-free reads
of immutable Program bytes. They classify every claim, report unknown live-system facts as unknown,
and never start a Process or inject a fault. See [SGOS-SIMULATION.md](SGOS-SIMULATION.md).

The public SGOS API also provides strict two-arm outcome evaluation across the closed v1 metric and
classification vocabularies. It refuses employee ranking and prompt export, and its OpenTelemetry
projection is content-free and returned locally without transport. See
[SGOS-AGENTIC-EVALUATION.md](SGOS-AGENTIC-EVALUATION.md).

The native Work Object and Command Center read models have a deterministic, content-free benchmark
at 1, 200, and 2,000 tasks. Its enforced ceilings run in the POC release gate without sending
telemetry. See [SGOS read-model benchmark](SGOS-READ-MODEL-BENCHMARK.md).

## Bounded guided learning

The installed `learn` surface now supports role- and Pack-filtered lesson discovery plus strict,
digest-bound guided mission descriptors. A mission can explain its objectives, steps, evidence,
failure/recovery drills and declared non-effects, then evaluate exact quizzes or deterministic
teach-back concept presence. The lesson must still come from a signed active Pack and the module's
self-hash must equal that lesson's content digest. An optional self-hashed fixture can materialize
bounded, secret-scanned UTF-8 tutorial files only under Git-common private storage after an exact
preview/confirmation. SFlow never executes those files. `learn workspace` verifies their bytes and
`learn reset` preview-removes only that local tutorial. `learn check` records only successful check
IDs in private Git-common storage. An explicit `progress-export` token can be preview-merged with
`progress-import` on another machine that already has the exact matching tutorial. The merge is
monotonic and contains no failed attempts, answers, identity, timing, paths, or scores. It grants no
approval, Process, Pack, certification, or employee-performance authority. No model, tool, Device,
application-tree or Git write, or Process transition is created. See
`singularity-flow learn --help` and the SGOS governed-execution topic.

Materialization publishes the manifest last. If the process stops after one or more exact fixture
files are durable, `learn workspace` reports `interrupted` instead of hiding the state as absent;
repeating the same reviewed and confirmed `learn materialize` command verifies/reuses exact bytes
and completes the manifest. Conflicting learner bytes are never overwritten. Learning progress v2
also reads canonical v1 local records and copy tokens through the migration registry, recomputes the
identity-free content seal, and writes v2 only on a later successful monotonic mutation.

For disconnected learning, `learn bundle-create` writes a new, bounded, canonical module/fixture
bundle only after the local active Pack validates the exact lesson, role, module, and fixture.
`learn bundle-inspect` verifies copied bytes without Pack credentials. `learn bundle-materialize`
then rechecks that the destination has the same exact active Pack and requires the ordinary
materialization confirmation. Pack authority travels separately through the existing approved
Git-trusted or signed Authority Store transport; the learning bundle contains no key, signature,
activation, approval, certification, identity, machine-local path, or network capability.

## Governed meta-tool activation

The platform API deliberately separates finding a recurring pattern from deploying it. Verified
accepted traces create a candidate, an independent signed evaluator supplies security, quality and
cost results, and a different approved reviewer promotes the exact candidate/evaluation pair. Only
that retained promotion can activate an exact, already approved Pack or Device operation.

Activation does not execute the operation. It creates a versioned Authority Store selection with a
bounded observation policy. Observations append outcome evidence only and cannot contain an approval
decision. Revocation removes a current selection immediately. Rollback is confirmation- and
CAS-bound and may select only an existing, nonrevoked activation whose complete approval and target
authority still validate; historical observations and activations are retained.

The platform API and public `meta-tool activate|observe|revoke|rollback` CLI expose the same guarded
transitions. Each CLI mutation first returns a content-addressed plan; repeating the identical
command with `--confirm <plan-sha256>` re-resolves approved configuration and exact Authority Store
state before the CAS mutation. A Pack target is derived from the one current signed Pack operation
in approved `singularity/sgos/capability-pack-trust.json` authority. A Device target is identified as
`device:<device-id>:<operation-id>` and is admitted only when that exact operation exists in an
installed, nonrevoked Device manifest and is exported by a current signed, independently reviewed
Capability Pack. Its authority binds both the Device manifest/version and the Pack activation/review.
The caller cannot supply a target manifest, approval digest, or arbitrary local authority file.
VS Code exposes the same two-step ceremony through **Singularity Flow: Review Meta-tool Authority...**;
it explicitly selects Pack or Device and displays the exact actor, Store revision/state, target,
approval, and confirmation before invoking the confirmed CLI mutation.

## Store interfaces and authority separation

The filesystem Authority Store implements SPI version 1, with explicit CAS, append-only lineage,
exclusive-writer locking, liveness recovery, bounds, schema validation, backup/restore, and
rollback capabilities. Structural conformance does not grant installation authority: the running
build separately allowlists installed Authority Store profiles, and repository configuration
cannot widen that list.

`memory-replay-v1` is the first alternate Operational Store. It is a bounded, deterministic,
in-memory journal for simulation and conformance work. It serializes writers, rejects stale CAS,
replays every event, emits exact backups, accepts only lineage-preserving fast-forward restore, and
implements rollback by appending a compensating event instead of deleting history. Its descriptor
is permanently non-authoritative and the selection guard admits it only for `simulation` or
`test` when the selected storage-profile digest equals the Program's pinned digest. The live SGOS
runtime cannot select it.

`filesystem-replay-v1` is the durable counterpart behind the same SPI. It reconstructs state from
bounded fsynced immutable event files, serializes independent writers, detects stale CAS and corrupt
or non-contiguous lineage, recovers an abandoned lock, and treats unfinished staging files as
non-authoritative. The exact same conformance journey exercises both profiles, including backup,
fast-forward restore, and compensating rollback. This profile is also restricted to `simulation`
and `test`; durability does not make it Program, policy, or lifecycle authority.

This is a staged `SGOS-P1-003` boundary. The existing live filesystem Process store still owns
runtime operations directly; moving it behind the same Operational Store SPI and proving an exact
old-format migration plus atomic runtime cutover remain open.

## Portable Authority Store and Capability Packs

The `authority-store` surface supports two explicit transport profiles. The recommended team
profile is key-free `git-trusted` v3: it requires an approved, reachable Git remote and configured
state branch, publishes one deterministic Store projection there, and lets another laptop install
or strictly fast-forward it through an exact preview/confirm sync. It works on Windows, macOS, and
Linux and never creates or transfers an Authority transport key. Git remote permissions, branch
controls, and current branch history are the transport root of trust. The Git identity confirming
sync must be a member of the approved `architecture-reviewers` authority because the command makes
an audited local Authority Store cutover.

Normal compiler and Process admission read Pack lineage only from the installed Store in the
repository's Git-common sidecar. They never fetch the state branch or auto-sync Store authority.
A command may separately refresh approved `sflow/config` policy under the existing configuration
authority rules; that check does not import Pack history. Store network freshness is an explicit
operator action: every `authority-store sync` preview freshly observes approved configuration and
the exact remote state commit, and confirmation rechecks the same plan before installing it.
Another laptop therefore sees a local Pack change only after the source publishes it and that
laptop explicitly previews and confirms sync.

The stronger signed v2 profile creates a local Ed25519 transport signer on supported POSIX hosts,
exports a canonical repository-bound bundle, and imports it through the same guarded boundary. It
remains appropriate when authority must survive a compromised or force-rewritten Git host. Pack
state is not copied independently: the complete portable Store event lineage
carries every signed Pack, review, activation, revocation, and supersession record and revalidates
them with current approved publisher keys before cutover.

Git-trusted mode removes only the outer Authority Store transport signer. Capability Pack publisher
signatures remain: the projection carries the signed Pack records and their publisher signatures,
which prove Pack bytes and provenance independently of how the Store travels. The projection
contains no remote URL, credential, machine path, private key, or outer Authority transport signer
or signature. Its exact blob, remote state commit, repository binding, policy digest, and local
Store head are bound into the sync plan and durable Git cutover receipt. An unavailable or missing
configured state branch never falls through to a local or cached branch, and an explicit local
rollback cannot cross the approved v3 minimum revision/state checkpoint.

Transport trust is explicit format v3 (`git-trusted`) or v2 (`signed`) in
`singularity/sgos/capability-pack-trust.json`. Both separate Pack publishers from the outer Store
transport authority. Git-trusted v3 binds the raw credential-free fingerprint of the approved
configured state remote and does not support an offline-root substitute; offline root-commit
binding belongs only to signed v2. Signed v2 requires its minimum revision/state/export checkpoint
before import. A v3 policy may bootstrap with no minimum; after the first successful publish, advance
the approved minimum revision/state/projection as defense in depth. Once that checkpoint exists,
neither sync nor rollback can cross below it.
Signed-v2 private keys remain in the source clone's owner-only Git-common sidecar and are never
placed in argv, tracked repository content, the bundle, or diagnostics. Import accepts install, exact no-op, or strict
fast-forward only. It stages and verifies a complete sibling Store before a stable-lock,
tamper-evident journaled directory cutover; stale, divergent, cross-repository, counterfeit,
secret-bearing, partial, revoked, or superseded authority fails closed. The imported signed proof
and exact cutover receipt are retained for verification and guarded rollback.

Pack publisher keys are reviewed verification anchors, not transport credentials. Adding a public
publisher key through `sflow/config` authorizes SFlow to verify future Packs signed by that key; it
does not add a Pack, change an activation, or mutate the Store. Removing a publisher key makes every
historical Pack record signed by that key unverifiable, so runtime and transport validation fail
closed without deleting or re-signing any bytes. To stop a publisher's Pack from being selected,
revoke or supersede the Pack and retain its public key for historical verification. The current
trust map has no separate “may verify history but may not publish new Packs” publisher state.

The current portable profile is intentionally limited to fully authorized Capability Pack events.
Legacy or mixed Memory, Meta-tool, Secret Broker, and unknown Authority Store namespaces are
reported as unportable instead of being copied without a schema-specific semantic verifier. The
public status, verify, recovery, and Pack-maintenance paths can still open an existing nonportable
Store ID on POSIX only when refreshed approved v1 trust names that exact local Store; new Store
creation and every v2/v3 transport action continue to require a portable ID. The
v2 policy must explicitly grant each approved exporter `full-authority-store-snapshot` authority:
the outer signature attests the complete historical Store lineage, while deterministic replay
proves that lineage is a legal Pack proposal/review/activation/revocation sequence. Exporter keys
are therefore high-privilege authority roots and must be reviewed and protected as such. The
full operator recipe is in the
[SGOS governed-execution topic](topics/sgos-governed-execution.md#move-authority-store-and-capability-packs-to-another-laptop).

## What remains staged

The following larger SGOS capabilities remain behind explicit refusal boundaries until their
conformance suites exist. Their durable backlog, priorities, dependencies, and acceptance gates are
tracked in [SGOS-PENDING-WORK.md](SGOS-PENDING-WORK.md):

- model-backed or tool-bearing `AGENT` execution beyond the reviewed Copilot proposal-only GEU,
  mutating Devices beyond the exact sandbox-CAS profile, arbitrary third-party adapters, and their
  complete independent conformance/counterfeit-model programs;
- runtime-dynamic fan-out, additional reviewed reducers, and consequential-effect task retry;
  bounded nested inline fan-out, quorum, deterministic-reduce, manual-reconcile joins,
  installed-protocol idempotent effect replay, and exact non-genesis fork import are implemented;
- universal Candidate routing is implemented for the supported lifecycle surfaces; its
  cross-platform signed release promotion remains tracked as `SGOS-P0-001`;
- Secret Broker integration with real external adapters, the corresponding cancellation/leakage/
  restart proof, and garbage-collection plans; bounded automatic working-set injection into the
  proposal-only Copilot Agent path is implemented;
- migration of the live filesystem Process store through the Operational Store SPI and an exact
  old-format/runtime-cutover matrix; bounded memory and durable filesystem replay profiles both
  exist only for simulation/test, while the separate platform filesystem profile remains the only
  installed and explicitly experimental Authority Store implementation;
- executable tutorial environments, independent learning certification, a
  public meta-tool activation/rollback CLI, and multi-domain proof packs;
- external telemetry transport beyond the content-free read-only OpenTelemetry projection and
  signed supported-machine baselines for the implemented semantic read-model budgets;
  fresh-authority trace-to-evidence reconstruction is available through
  `singularity-flow evidence reconstruct PROC-... --json`;
- full software-conversion and hypothesis-analysis end-to-end proofs, the supported OS/Node matrix,
  and an exact signed release receipt for this change.

This staged boundary is intentional. Existing product behavior stays compatible while each SGOS
authority claim gains its own deterministic tests.
