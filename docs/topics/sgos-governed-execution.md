---
id: sgos-governed-execution
title: SGOS governed execution
aliases:
  - sgos
  - governed-vm
  - gvm
  - governed-execution-operating-system
commands:
  - intent
  - program
  - process
  - policy
  - task
  - request
  - evidence
  - candidate
  - execution-unit
  - device
  - authority-store
  - pack
  - learn
  - memory
  - meta-tool
related:
  - governed-execution
  - workflow-authoring
  - evidence-and-ledger
version: 16
---
SGOS compiles confirmed intent and a ratified workflow into a finite, content-addressed Governed VM
Program. Its operational Process state never replaces Story, Initiative, configuration, ledger, or
Git authority.

A Story subject must already exist at the exact Process baseline. SFlow validates its durable Story
record and pins the exact path, blob digest, normalized state digest, and Git revision in the
Process Binding before any task—including `NOOP` or `END`—can run.

Follow [How to use SGOS](../SGOS-USAGE-GUIDE.md) for the practical developer and operator sequence,
including normal Story boundaries, explicit Intent-to-Process execution, recovery, and Git-trusted
Capability Pack sharing.

## Purpose and prerequisites

Use this profile to inspect and exercise deterministic SGOS compiler profile v3 and the runtime.
Start inside the selected governed repository with committed input JSON for the Intent IR, Workflow IR,
Ratification, policy snapshot, registry snapshot, and optional Process Binding. The core profile is
model-free by default and supports a bounded deterministic parallel wave for compatible resource
contracts. It can dispatch only the exact registry-pinned `deterministic-translator` Execution Unit,
the exact registry-pinned proposal-only `copilot-cli` Execution Unit, and the exact registry-pinned
read-only `filesystem-read` Device. The only consequential Device is the exact registry-pinned
`sandbox-cas` proof adapter: it can compare-and-swap one compiled key only beneath Git-common SGOS
fixture storage, after a durable Tool Intent, and recovery verifies rather than replays its exact
postcondition. Copilot dispatch additionally requires the reviewed CLI
`--allow-model` operation, has no tools, repository, Device, or effect scope, and cannot create
terminal authority without a downstream independent VERIFY gate. Every other consequential Device
and every uninstalled, stale, or counterfeit manifest refuse safely.

The built-in core profile is an explicit versioned Pack authority and never reads ambient Pack
state. A non-core Workflow must name one exact signed declarative Pack digest. Compilation loads
its reviewed active selection from approved publisher trust and this repository's machine-local
Authority Store; Process admission revalidates that same selection before mutation. Configuration
does not transport the store, so a missing office-machine store fails closed with a portability
diagnostic instead of silently falling back to core or another Pack.

## Lifecycle publication boundary

Candidate handling is automatic for supported Story, Initiative, ad hoc, Goal, Epic, capability,
and direct Story-promotion publications. It is not a second user workflow. Before the lifecycle can
create a governed commit, SFlow freezes the exact prospective Git tree, admits protected paths and
secrets, verifies the normalized lifecycle event, retains the Candidate, and binds its commit,
tree, verification receipt, trailers, journal, and pending recovery record.

If publication is interrupted, recovery reuses that retained Candidate rather than current `HEAD`
or newly edited worktree bytes. An equal competing remote ref is not treated as success unless this
transaction completed its local compare-and-swap or recorded a sealed transport-indeterminate
attempt. Authenticated legacy pending records remain recoverable as exact-but-unverified history;
SFlow never invents Candidate verification for them.

## Use it from each surface

- **Shell:** use `singularity-flow intent`, `program`, `process`, `policy`, `task`, and `request` for the
  execution core. The bounded extension profile exposes `candidate`, `execution-unit`, `device`,
  `authority-store`, `pack`, `learn`, `memory`, and `meta-tool`; run each command with `--help`
  before a mutation.
- **Copilot:** ask `@sflow /how` for the reviewed SGOS topic, then prepare the exact CLI command in
  the repository terminal. Help does not execute it for you.
- **VS Code:** run **Singularity Flow: Open Command Center** for the projection-only Process board,
  graph, evidence links, unavailable-Process diagnostics, and Human Request forms. Actions pass only
  exact identifiers back to reviewed commands; the webview is not a second execution engine.

### Guided learning missions

`singularity-flow learn` is a deterministic tutor over lesson entries in signed active Capability
Packs. List by role, optionally narrow to one Pack, then supply the repository-contained JSON module
whose `moduleSha256` equals that lesson's `contentSha256`:

```sh
singularity-flow learn list --role developer --trust publisher-trust.json
singularity-flow learn start recovery-basics --role developer \
  --module learning/recovery-basics.json --trust publisher-trust.json
singularity-flow learn inspect recovery-basics --role developer \
  --module learning/recovery-basics.json --trust publisher-trust.json
singularity-flow learn explain-change recovery-basics inspect-refusal --role developer \
  --module learning/recovery-basics.json --trust publisher-trust.json
singularity-flow learn quiz recovery-basics safe-action --role developer \
  --module learning/recovery-basics.json --answers learning/quiz-answer.json \
  --trust publisher-trust.json
```

A v1 module is a strict self-hashed `learning-module` descriptor: role, title, bounded objectives,
one `{ kind: "descriptor-only", fixtureId, fixtureSha256 }` sandbox reference, finite typed steps,
expected evidence, failure/recovery exercises, and quiz or teach-back checks. There is deliberately
no command, path, URL, callback, executable fixture, or raw-secret field. `start` returns a plan; it
does not clone or materialize the fixture. `explain-change` proves the installed surface can affect
neither Git, repository files, Devices, nor a governed Process. Quiz uses an exact option set;
teach-back uses deterministic declared-concept presence and reports that limitation explicitly.

No progress is persisted in this bounded release. Results have no approval, Process, Pack,
certification, or employee-performance authority; no model, tool, employee metric, ranking, or raw
answer text is produced. Durable tutorial repositories, pack-author certification, semantic
teach-back judgment, and signed portable learning completion remain staged.

Command Center publishes one closed render descriptor for each canonical Work Object view:
`overview`, `graph`, `board`, `timeline`, `table`, `document`, `form`, `evidence`, `diff`, `matrix`,
`chart`, `log`, `metrics`, `simulation`, and `approval`. A descriptor contains only bounded fields,
rows, relationships, accessibility metadata, and notes. It cannot contain HTML, a callback, or a
command. VS Code escapes every value and interprets only the closed descriptor keys; an extension
field is refused rather than rendered. Heavy descriptors use the lazy SGOS snapshot slice, which is
acquired when Command Center opens, released when it closes, and not rendered again when the exact
slice revision is unchanged.

**Needs you** shows the declared request type and reason, exact Process/task/request/checkpoint/policy
references, evidence receipts, required authority, choices with their declared consequences, work
that remains active, continuation behavior, and expiry. Secret-broker handles and external response
URLs are deliberately absent. A non-sensitive response is offered only when its action names the
reviewed `request.respond` operation and binds the exact Process revision, Process digest, and request
digest. The host re-reads those values after confirmation; sensitive or typed input remains CLI-only.

## Guided workflow

1. Capture natural language only as an Intent Envelope. Preview exact answer JSON with
   `intent packet <ENVELOPE> --answers <FILE>`, then repeat it through `intent confirm` with the
   printed `--confirm` digest and an explicit `--confirmed-at` timestamp. Confirmation preserves
   field provenance and derives the human from approved product authority; no identity flag can
   grant it.
2. Build a finite Workflow Candidate with `intent workflow <INTENT-IR> --policy <FILE>
   --declaration <FILE>`. Preview the complete policy/registry/storage/coverage binding through
   `intent ratification-packet`, then ratify only that exact packet using `intent ratify --confirm
   <PACKET-SHA256> --decided-at <RFC3339>`. These commands consume explicit JSON and run no model.
3. Validate the exact records, then compile with `singularity-flow intent compile <INTENT-IR> --workflow <FILE> --ratification
   <FILE> --policy <FILE> --registry <FILE> --out <PROGRAM>`.
4. Inspect with `singularity-flow program validate|explain|simulate <PROGRAM>`; simulation performs
   no task execution.
5. Run `program approve <PROGRAM>` without confirmation to preview the exact record and digest.
   Re-run with `--confirm <PROPOSAL-SHA256> --approved-at <RFC3339>` to publish a normal review
   proposal based on `sflow/config`. This leaves the selected application branch and approved
   configuration tip unchanged; it never grants application-branch authority. Review and merge the
   proposed branch through the existing configuration path. The resulting approved record lives at
   `singularity/sgos/program-authorities/<PROGRAM-SHA256-WITHOUT-PREFIX>.json` through the normal
   `sflow/config` review path. A local or application-branch copy is not authority.
6. Start one local Process with `singularity-flow process start <PROGRAM> --compiler-request
   <COMPILER-REQUEST.json> --subject <ID> --subject-kind story|repository` and retain the returned
   Process ID and checkpoint hash. Alternatively provide all five compiler input files. A Program
   self-hash, compiler inputs without approved authority, or caller-supplied digest is refused.
7. Use `process status|graph`, then execute one intrinsic deterministic boundary at a time with
   `process step`. The CLI includes reviewed read-only Story-inspection and repository-clean adapter
   pairs; other kernel work stays unavailable until the host registers a separate handler,
   Candidate Snapshot capture, and verifier. Inspect immutable results with `task evidence`.
8. Answer a typed Human Request only with its exact request hash. Use `--decision approved` for an
   approval, `--option <EXACT-ID>` for a declared choice, or `--decision provided --input-json
   '<JSON>'` for non-sensitive schema input. Sensitive requests accept only a non-secret typed
   reference through `--sensitive-handle`; never place a credential or secret value on the command
   line. Also pass `--expected-revision` and `--expected-process-sha256` from `request show`; both
   are rechecked immediately before mutation so a response cannot drift to a newer Process. Authority
   is pinned from the repository's configured reviewer membership when the Process
   starts and cannot be supplied by a response flag. Pause or resume only with the current
   checkpoint confirmation. To interrupt active work, use `process stop <PROCESS-ID>`: it records
   the Process as paused immediately and reports `stop-requested` until the exact execution and
   owner lease settle. Repeat `process stop` or inspect status to prove quiescence before resume.
9. If a CLI process is interrupted, run `process recover <PROCESS-ID>` to inspect the exact owner,
   binding, attempt lineage, and confirmation-bound actions. Never recover while it reports an active
   owner. Use the printed `reconcile-success`, `retry-safe`, or `fail` command exactly as shown.
10. If migration doctor reports v1 Process state, a v1 Process Binding, or a v1 Human Request, run
   `process quarantine <PROCESS-ID>` without confirmation first. Review the bounded tree digest and path, then run the
   exact printed `--confirm <TREE-SHA256>` command. The move preserves every byte outside the active
   runtime; v2 deliberately offers no restore or resume path for an authority claim it cannot prove.
   The same command can quarantine an exact current-v3 private creation seed interrupted before its
   genesis event, one exact readable Process terminal-attempt-before-receipt crash, or one failed
   terminal attempt for which neither Action Evidence nor a receipt was published (including a
   stored v2 Process migrated only in memory), after the owner is dead. The seed must still match its
   readable Program, Process Binding, and deterministic zero-progress task materialization. A failed
   terminal without evidence is never retryable. Exact writer `.pending-<PID>-<UUID>` leftovers are
   listed and moved as digest-bound opaque bytes; they are never parsed or restored. It validates
   every current record and does not claim that the Process or task succeeded. Process listing keeps
   healthy peers visible and labels a refused private Process explicitly unavailable; it never hides,
   repairs, or resumes that Process.
   `process archive` remains only as a compatibility alias.
11. For an intentional replay, preview `process replay <PROCESS-ID> --from <CHECKPOINT-SHA256>` and
    repeat with the printed `--confirm` digest. The installed profile reopens only a pure suffix and
    refuses prior writes, Devices, external effects, stale state, or exhausted attempts. It clears
    the current suffix receipt/output projection but preserves immutable history. Fork uses the
    same preview/confirm pattern, supports only a genesis checkpoint, writes a predecessor intent,
    and recovers the same deterministic receipt after an interrupted confirmation.
12. Before `candidate verify`, review and publish the strict content-addressed verifier policy at
    `singularity/sgos/candidate-verifier-policy.json` through `sflow/config` (or its verified state
    mirror). The policy owns the exact absolute-argv commands and timeout. Legacy `--commands` and
    `--timeout-ms` values are compatibility assertions only and must equal the approved policy;
    they cannot choose a verifier. Candidate publication rechecks the current policy before its Git
    compare-and-swap and repairs an exact ref-advanced/index-not-aligned crash before it receipts.
13. Manage runtime policy changes with `policy status|fsck|plan|apply`. Planning is read-only and
    binds the exact approved current and candidate bundles, component classification, impacted
    Programs and Processes, selected restart-required invalidations, authority commit, and runtime
    revision. Apply requires both the printed `--expected-revision` and `--confirm` digest and
    re-reads every authority input. Existing Processes retain their starting policy unless the
    exact amendment receipts a selected invalidation. One central policy-authority preflight covers
    start admission, task execution, Human responses, stop/pause/resume, recovery, replay/fork,
    quarantine, and the Process store publication boundary; an invalidated Process refuses before
    any runnable-state mutation and must be restarted under the replacement policy. An exact
    preserve-only quarantine remains available for state already classified as unreadable or
    unrecoverable and binds its reviewed tree without trusting those Process policy bytes.

The same confirmed inputs compile to the same Program hash. Compilation refuses unknown task
kinds, unbounded constructs, cycles, orphan tasks, unmapped clauses, unknown registry operations,
missing evidence or authority, unsafe writes, consequential effects without recovery, and
unreachable terminal states.

## Portable Process Evidence

Export an exact, repository-contained evidence bundle without changing Process state:

```sh
singularity-flow evidence export PROC-... --out .sflow/evidence/process.json --json
```

The output is canonical and content-addressed. Publication is atomic and refuses an existing file,
path traversal, symbolic links, and a bundle above the installed export ceiling. It contains the
final Process, Program, Process Binding, record-index and control lineage, plus every indexed
checkpoint, attempt, receipt, Candidate, Action Evidence, Human Request/Response, agent proposal,
resource lease, join, fan-out, and replay record. Referenced Tool Intents/Results and active
execution leases are included when durably available.

Copy the file into a fresh directory and verify it without the original Git repository or SGOS
sidecar:

```sh
singularity-flow evidence verify process.json --json
```

Verification is deterministic and model-free. It detects omitted, reordered, duplicated,
tampered, orphaned, and unreferenced records. Its assurance is deliberately limited to
content-addressed local-export integrity: it does not claim a signature, an Authority Store proof,
fresh authority verification, or approval. Missing task-contract bytes, approved authority bytes,
raw Device evidence, transient agent events, and non-durable stop/quiescence receipts remain
explicit gaps rather than being upgraded into proof.

## Move Authority Store and Capability Packs to another laptop

Authority transport is one complete Store operation, not a separate Pack copy. The portable
profile accepts a Pack-only Store lineage, so every event must be an exact authorized Pack proposal,
review, activation, or revocation and a Pack arrives with its complete history. Mixed legacy,
Memory, Meta-tool, Secret Broker, or unknown Store namespaces are refused as unportable rather than
copied without a schema-specific verifier. The bundle contains no repository path, hostname, remote
URL, credential, or private signing key, and it can be imported only into another clone whose raw
repository identity is admitted by refreshed approved configuration.

### Key-free Git-trusted mode

Generate the v3 scaffold, place its `trustScaffold` value at
`singularity/sgos/capability-pack-trust.json`, retain the approved Pack publisher public keys, and
publish that configuration through `sflow/config`. This mode requires an approved reachable Git
remote and configured state branch. It cannot use an offline root-commit binding; that fallback is
available only to signed v2. The Git identity that confirms synchronization must belong to the
approved `architecture-reviewers` group because sync makes an audited local Store cutover:

```sh
singularity-flow authority-store trust-scaffold \
  --mode git-trusted --store repository-platform --json
```

Publish the complete local Store to the configured state branch using preview and exact confirm:

```sh
singularity-flow authority-store publish --json
singularity-flow authority-store publish --confirm sha256:<PUBLISH-PLAN> --json
```

On another laptop, clone the same repository, refresh approved configuration, then preview and
confirm synchronization. No bundle file or transport key is copied:

```sh
singularity-flow authority-store sync --json
singularity-flow authority-store sync --confirm sha256:<SYNC-PLAN> --json
singularity-flow authority-store verify --json
```

Ordinary compilation, Process admission, and Pack lookup read Pack lineage only from the installed
Store under the repository's Git-common sidecar. They never fetch the state branch or auto-sync
Store authority. The surrounding command may independently refresh approved `sflow/config` policy;
that is not a Pack-history import. Freshness is deliberate: each `authority-store sync` preview
freshly observes approved configuration and the exact remote state commit; confirmation re-observes
and refuses if that plan changed. A Pack update on laptop A is visible on laptop B only after A
publishes and B explicitly previews and confirms sync.

Sync accepts only install, exact no-op, or a strict lineage fast-forward. It refuses a missing,
unreachable, changed, malformed, older, divergent, or wrong-repository state projection before
cutover. A retained cutover may be rolled back only when its target is not below the approved v3
minimum revision/state/projection checkpoint; neither rollback nor sync has an override that can
cross `minimumAuthority`. The checkpoint may be null only while bootstrapping; after a successful
first publish, advance it in approved configuration as defense in depth. The projection has no
outer Authority transport signer, signature, or private key, but it does carry every signed Pack
record and its publisher signature. The application checkout and branch are not changed. A new
laptop deliberately trusts the current Git state-branch authority; unlike signed v2, this profile
cannot independently detect a malicious Git administrator who rewrites both branch history and the
approved checkpoint.

The `publishers` map contains public Pack-signing verification keys, not Authority transport keys.
Adding a key through approved `sflow/config` permits future Pack signatures from that publisher to
verify, but creates no Pack and changes no activation. Removing a key makes every historical Pack
record signed by it unverifiable; runtime and sync fail closed and neither deletes nor re-signs the
record. To stop using a publisher's Pack, revoke or supersede it while retaining the public key for
historical verification. The current format does not distinguish “verify old history” from “admit
new Pack proposals” for one publisher key.

### Signed mode

An administrator performs the signer bootstrap once on the source machine:

```sh
singularity-flow authority-store signer-create \
  --signer organisation-authority --store repository-platform --json
```

The command keeps the Ed25519 private key under the repository's private Git-common SFlow sidecar
with owner-only POSIX permissions and prints a complete public v2 trust scaffold. Windows import and
inspection work with the public trust policy; Windows signer creation/export remains gated pending
an owner-only OS credential backend and signed platform proof. Add that public key, the
approved credential-free remote fingerprints, and the Store ID to
`singularity/sgos/capability-pack-trust.json` using format
`singularity-flow-sgos-capability-pack-trust/v2`, then publish it through the normal `sflow/config`
review. The scaffold deliberately sets `transport.exporterAuthority` to
`full-authority-store-snapshot`: an approved exporter is a high-privilege snapshot attestor whose
signature vouches for the complete historical approval/activation lineage, not merely a file-copy
transport. Pack publisher keys and Authority export signer keys are independent; approve and
protect exporter keys accordingly.

Create the first signed bundle without replacing an existing output:

```sh
singularity-flow authority-store export \
  --signer organisation-authority \
  --out .sflow/authority/repository-platform.json \
  --json
```

Before anyone imports it, copy the returned `revision`, `stateSha256`, and `exportSha256` into the
v2 trust manifest's `transport.minimumAuthority`, publish that approved configuration update, and
refresh it on both machines. This checkpoint is mandatory for import: a signature alone cannot
distinguish a valid old snapshot from current authority after a Pack was revoked.

On the new laptop, clone the same repository, refresh approved configuration, copy the canonical
bundle into a repository-relative file, and run the guarded sequence:

```sh
singularity-flow authority-store inspect .sflow/authority/repository-platform.json --json
singularity-flow authority-store import .sflow/authority/repository-platform.json --json
singularity-flow authority-store import .sflow/authority/repository-platform.json \
  --confirm sha256:<IMPORT-PLAN> --json
singularity-flow authority-store verify --json
```

Import accepts only an absent/genesis Store, an identical Store, or an exact lineage
fast-forward. It never merges histories and never treats an older bundle as rollback. A complete
sibling Store is verified before the directory cutover. A stable parent lease prevents a live
cutover from being mistaken for recovery; its crash journal has machine-local integrity and is
removed only after the complete lineage, retained signed bundle, and receipt verify. An
interruption restores the exact old Store or retains the exact new Store, never a copied prefix.
The import result names a cutover receipt. Preview an operational rollback and confirm its exact current plan only while no later
Store mutation has occurred:

```sh
singularity-flow authority-store rollback --receipt sha256:<CUTOVER> --json
singularity-flow authority-store rollback --receipt sha256:<CUTOVER> \
  --confirm sha256:<ROLLBACK-PLAN> --json
```

Rollback retains both complete histories and refuses to reactivate a Pack that the imported state
revoked or superseded. Neither import nor rollback has a force, caller-trust, merge, or
cross-repository override.

Legacy trust v1 remains local-only. On POSIX, public Store status, verification, recovery, and Pack
maintenance can open an existing nonportable Store ID only when refreshed approved v1 trust names
that exact Store. New Store creation, signer scaffolds, export, inspect, import, and rollback always
use the portable v2 identifier contract; Windows does not open a nonportable legacy path.

## State and safety

- Models may propose Intent or Workflow IR; they cannot ratify it.
- The public runtime API never accepts a model-permission option and therefore cannot silently
  upgrade `process step` or `process run`. Model-backed proposal dispatch is intentionally available
  only under an explicit reviewed `process.step.model` or `process.run.model` operation context; the
  CLI establishes that context only for `--allow-model`, while global `--no-model` refuses it before
  Process state or the provider is opened.
- Ratification binds exact intent, workflow, policy, registry, and storage hashes.
- Process updates use a repository-bound subject lock and expected revision.
- Policy amendments cannot authorize themselves. Tightening is automatic only for exact targets
  explicitly allowlisted by the current policy; weakening or mixed changes require an exact
  approved `policy.amend` decision from current authority.
- An older Process policy remains legal only when the exact local amendment graph connects it to
  the approved active policy and contains no invalidation for that Process. Policy apply holds the
  same Process lock as publication, so an invalidation cannot race a late state transition.
- Dispatch and successful publication both recheck the exact repository/worktree/branch/HEAD
  binding. Portable contract paths round-trip across POSIX, Windows drive, and UNC forms.
- A live execution owns a durable local lease. Recovery never races that owner, and every retry has
  immutable parent-attempt lineage.
- Stop is a durable two-part boundary: `paused` prevents new dispatch immediately, while an exact
  active attempt/lease may remain only until the owner settles. Resume refuses that intermediate
  state, and a late handler result cannot publish success across the stop boundary.
- A task succeeds only after an independently checked immutable candidate and Task Receipt.
- Human responses bind the exact request, current Process revision, and authority read from the
  immutable approved-configuration ref/commit/workflow-blob tuple recorded at Process start.
- Capability Pack, platform memory, and meta-tool mutations derive the actor from the repository's
  current Git identity and refreshed approved configuration. Caller-supplied actor/reviewer flags
  are refused; the Authority Store transaction binds the exact group, configuration commit, and
  authorization witness that admitted it.
- A meta-tool candidate is not executable authority. Activation requires its exact independently
  signed evaluation and human promotion plus an already approved Pack/Device operation, version,
  manifest and approval digest. Runtime lookup revalidates the lineage; superseded, revoked, stale,
  or counterfeit activations fail closed. Observation records carry bounded outcome evidence only,
  while rollback can select only a retained nonrevoked activation through exact confirmation and
  Authority Store CAS. The activation/observation/revoke/rollback API is implemented, but its public
  CLI remains intentionally staged.
- Process checkpoints live below the Git common directory and do not alter application or Story
  state. Existing Story transitions continue only through existing lifecycle commands.
- Static fan-out is expanded by the compiler, joins are limited to `all-success` and `all-terminal`,
  and parallel dispatch is selected canonically under exact resource leases. Timing is never an
  authority input.
- Adapter presence alone is not authority. An `AGENT` Program must separately bind a dotted
  operation and a kebab-case `executionUnits` registry entry; a `DEVICE` Program must separately
  bind its operation and Device registry entry. Runtime dispatch then requires those exact pins to
  equal the installed deterministic-translator or read-only filesystem manifest.

## Troubleshooting

- A digest mismatch means the reviewed input moved. Revalidate and recompile; do not copy the new
  digest into an old confirmation blindly.
- An unsupported opcode or adapter stays visible in explain/simulate but will not run until a
  reviewed registry pin, installed adapter, and independent verifier exist.
- A stale response or checkpoint must be re-read with `request show` or `process status` before it
  can be retried.
- An interrupted execution must first be inspected with `process recover <PROCESS-ID>`. Safe retry
  appears only for explicitly idempotent read-only work; otherwise stabilize it with the exact
  printed failure action or reconcile an already verified receipt.
- A missing receipt means the task did not succeed. Inspect `task evidence`; never infer completion
  from a handler message or changed file.
- A missing or changed Candidate verifier policy requires configuration review and a new
  verification; do not copy commands into a local JSON file and treat them as authority.
- A quarantined Process is preserved machine-local evidence, not runnable authority or proof of
  success. Start a new Process from an approved Program rather than copying, editing, restoring, or
  resuming quarantined records.
- Amendment and invalidation receipts in this runtime slice are Git-common local state, not yet a
  portable shared authority. If approved configuration exposes a pending policy candidate but the
  exact local amendment graph is absent—or an older Process pin cannot be joined to that graph—all
  Process mutations fail closed with `SGOS_POLICY_AUTHORITY_UNESTABLISHED` or
  `SGOS_POLICY_AUTHORITY_DIVERGED`. Complete a newly reviewed plan/apply boundary, restore the exact
  authority through an administrator-reviewed machine transfer, or start a new Process under the
  approved current snapshot; a second clone never assumes continuation.

## Related topics

See `docs/SGOS.md` for the implemented boundary and staged roadmap. Continue with
`sflow explain governed-execution`, `sflow explain workflow-authoring`, or
`sflow explain evidence-and-ledger` for the existing authoritative lifecycle.
