# SingularityFlow Governed Execution Operating System

SGOS is the additive execution layer that turns confirmed intent into a finite, content-addressed
program. It does not replace the existing Story lifecycle. Story `workflow.json`, phase publication,
submission, approval, and Git publication remain the authority for existing work.

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
- model-free compiler profile v2 with a closed opcode vocabulary and deterministic output;
- compile-time refusal of unbounded work, cycles, orphan tasks, unmapped confirmed clauses,
  missing evidence, ungoverned judgment, unsafe overlapping writes, and consequential external
  effects without recovery;
- a GVM executor for deterministic kernel operations, verification, checkpoints, human requests,
  no-ops, terminal steps, one exact deterministic-translator `AGENT`, one exact read-only
  filesystem `DEVICE`, and a bounded parallel wave selected from exact resource contracts;
- static compile-time fan-out with stable item keys, installed `all-success` and `all-terminal`
  joins, immutable resource leases, and join/fan-out receipts;
- execution admission that requires an exact Program approval loaded from `sflow/config` (or its
  verified state mirror); deterministic recompilation can corroborate it, but a Program self-hash,
  caller-supplied digest, or compiler inputs alone are never authority;
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

- a Git-backed Candidate lifecycle that freezes one exact tree behind a retained ref, verifies it
  in an isolated worktree, and publishes only the exact confirmation-bound commit. Verifier
  commands and timeout come only from the exact approved
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
- one read-only filesystem Device with durable Tool Intent/Tool Result recovery and exact
  confirmation-bound revocation;
- pure-suffix replay and genesis-only fork commands; replay preserves immutable attempt/receipt
  history and refuses repeated writes, Devices, and external effects;
- an experimental filesystem Authority Store, typed memory promotion, signed/revocable declarative
  Capability Packs, a read-only role lesson catalog, and human-gated meta-tool review packets. Every
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
promotion, activation, and revocation to `architecture-reviewers`. An organization may replace an
operation's group under `sgos.platformAuthorities` in approved `workflow.yml`; a working-tree edit
cannot change the decision.

## Safety boundary

The GVM admits only two adapter identities: the exact registry-pinned
`deterministic-translator` Execution Unit and the exact registry-pinned `filesystem-read` Device.
The translator has no model, tools, repository scope, subagents, or effects. The Device accepts
only `read-file` or `stat` inside its compiled canonical read scope, refuses links and path escape,
and must produce a verified effect-free Tool Result. Dotted task operation IDs remain separate from
the kebab-case adapter IDs; the Program and registry bind both. Model-backed `AGENT`, mutating or
uninstalled `DEVICE`, model-created fan-out, nested fan-out, unsafe parallel execution, and join
policies other than `all-success` and `all-terminal` still fail closed.

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
worktree during recovery.

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

This hardened profile is an intentional SGOS contract boundary change: compiler output is v2 and
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
state. The installed replay profile can reopen only a pure suffix from an ancestor checkpoint, and
the installed fork profile can create an independent Process only from genesis. General
checkpoint-payload restoration and non-genesis prefix import remain unavailable. A tampered
checkpoint, changed Program, changed policy, stale request, or lost revision is refused.

Replay clears the suffix tasks' current receipt/output projection while retaining every immutable
historical attempt and receipt for audit; old outputs cannot appear current until a new successful
attempt publishes them. An `all-terminal` join records failed predecessors as terminal without
borrowing their historical success receipt or outputs. Fork first writes an immutable predecessor
intent and creates one deterministic child genesis bound to the parent's immutable Process Binding;
repeating confirmation recovers the same receipt even if the child has since progressed, while
lineage fsck reports orphaned, corrupt, or incomplete fork records.

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
person's membership from the pinned approved group, and never accepts authority supplied by a flag.
This lets another currently authorized reviewer complete a handoff without inheriting the starter's
identity or weakening the approved authority definition.
Use `task show` for the compiled template and attempt/receipt lineage, and `task evidence` for exact
candidate, Action Evidence, Human Response, and unresolved external-reference status.

## What remains staged

The following larger SGOS capabilities remain behind explicit refusal boundaries until their
conformance suites exist:

- model-backed or tool-bearing `AGENT` execution, mutating Devices, arbitrary third-party adapters,
  and their complete independent conformance/counterfeit-model programs;
- dynamic or nested fan-out, quorum/reducer/manual-reconcile joins, general idempotent effect replay,
  non-genesis fork import, and arbitrary task retry;
- Candidate execution as the universal publication path for every existing lifecycle;
- working-set memory composition inside Process checkpoints, secret-broker execution integration,
  garbage-collection plans, and portable Authority Store migration/cutover;
- a general Authority Store SPI and an alternate Operational Store; the filesystem Authority Store
  remains explicitly experimental;
- Capability Pack consumption by the compiler/runtime, full guided learning missions, governed
  meta-tool activation/rollback, and multi-domain proof packs;
- fresh-authority trace-to-evidence reconstruction, assurance-classified simulation, OpenTelemetry
  export, and measured semantic read-model latency targets;
- full software-conversion and hypothesis-analysis end-to-end proofs, the supported OS/Node matrix,
  and an exact signed release receipt for this change.

This staged boundary is intentional. Existing product behavior stays compatible while each SGOS
authority claim gains its own deterministic tests.
