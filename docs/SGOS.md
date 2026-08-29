# SingularityFlow Governed Execution Operating System

SGOS is the additive execution layer that turns confirmed intent into a finite, content-addressed
program. It does not replace the existing Story lifecycle. Story `workflow.json`, phase publication,
submission, approval, and Git publication remain the authority for existing work.

## What this release implements

The first SGOS vertical slice is deliberately small enough to audit end to end:

```text
confirmed Intent IR
  -> ratified Workflow IR
  -> deterministic GVM Program
  -> resumable Process
  -> deterministic ready task
  -> verification
  -> immutable Task Receipt
  -> boundary checkpoint
  -> projection-only Work Object and evidence
```

It provides:

- versioned, content-addressed contracts for intent, policy, workflow, ratification, programs,
  process bindings, processes, attempts, receipts, human requests, evidence, and UI projections;
- model-free compiler profile v2 with a closed opcode vocabulary and deterministic output;
- compile-time refusal of unbounded work, cycles, orphan tasks, unmapped confirmed clauses,
  missing evidence, ungoverned judgment, unsafe overlapping writes, and consequential external
  effects without recovery;
- a sequential GVM executor for deterministic kernel operations, verification, checkpoints,
  human requests, no-ops, and terminal steps;
- execution admission that requires an exact Program approval loaded from `sflow/config` (or its
  verified state mirror); deterministic recompilation can corroborate it, but a Program self-hash,
  caller-supplied digest, or compiler inputs alone are never authority;
- reviewed, read-only CLI adapters for exact Story inspection and repository-clean verification;
- machine-local operational checkpoints under the repository Git common directory, protected by
  subject locks, expected revisions, atomic replacement, and content hashes;
- durable execution-owner leases, running/terminal attempt lineage, dispatch and pre-publication Git
  binding checks, and exact interrupted-execution recovery confirmations;
- success only after deterministic verification creates a Task Receipt;
- stale-response protection, configured-Git-identity authority pinning, JSON Schema input, and
  non-secret external/broker handles for typed Human Requests;
- deterministic simulation, ready-set calculation, trace-to-evidence compilation, and
  projection-only Work Objects;
- a compatibility adapter that can describe existing Story workflows without giving SGOS local
  state authority over a Story.

## Safety boundary

The first slice refuses `AGENT`, `DEVICE`, dynamic fan-out, and unsafe parallel execution at runtime.
Those opcodes remain part of the closed Program vocabulary so later adapters do not require a
format rewrite, but a Program cannot dispatch them until a reviewed execution-unit or device
adapter is registered.

The runtime API also requires separately registered kernel handlers, Candidate Snapshot capture,
and deterministic verifiers. The CLI installs only two reviewed read-only pairs:
`sflow.story.inspect`/`.verify` and `sflow.repository.assert-clean`/`.verify`. `process step` also
runs intrinsic `NOOP`, `CHECKPOINT`, `HUMAN_REQUEST`, and `END` boundaries. Every other kernel task
without exact registry pins and trusted adapter wiring remains unavailable without mutating state.

Operational SGOS files are rebuildable. Deleting them cannot alter Story or Git authority. A local
process can observe and project existing Story state, but only the established lifecycle kernel may
publish a phase, submit it, approve it, or advance it.

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
state; checkpoint-payload restoration and replay remain staged. A tampered checkpoint, changed
Program, changed policy, stale request, or lost revision is refused.

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

- parallel resource leases, deterministic joins, bounded fan-out, suffix replay, and forks;
- Copilot and other Governed Execution Unit adapters;
- typed device mediation and Tool Intent/Tool Result recovery;
- full candidate freeze/verify/publish commands across every lifecycle;
- unified memory promotion and secret-broker integration;
- a general Authority Store SPI and non-Git authority profile;
- signed Capability Packs, meta-tool promotion, `sf-learn`, and multi-domain packs;
- full Command Center and process-graph UI.

This staged boundary is intentional. Existing product behavior stays compatible while each SGOS
authority claim gains its own deterministic tests.
