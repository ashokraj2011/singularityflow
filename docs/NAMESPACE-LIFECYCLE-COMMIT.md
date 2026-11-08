# Namespace lifecycle persistence

`engine-storage/namespace-lifecycle-commit` is an internal persistence port for a transition
already admitted by the Engine SDK's policy owner. It composes explicit namespace and content
ports. It has no checkout discovery, Git, provider, process, filesystem or environment access.
Filesystem, SQLite and an application-owned SQLite journal execute the same commit protocol.

This is a Phase 7 writer prerequisite. It is not a public lifecycle operation, a complete
namespace-backed engine, or a selector for installed authority. No CLI, VS Code, Copilot or
native Git composition imports it. The installed Story branches, state projection and approved
configuration keep their existing authority. Public SDK exports remain unchanged.

## Boundaries

The application supplies a project scope, Story ID, shared metadata/content ports and an exact
authority ID/epoch. The factory refuses machine-local stores. It opens only an explicitly
enrolled Story; missing authority, configuration or Story records are errors. It never creates
an authority, imports an existing project or searches another backend to fill missing records.

These record families are separate from native workflow files and read projections. Authority,
configuration, head, prepared-intent and operation-manifest records retain their frozen v1 formats.
State bodies use the version-preserving profile described below. Future versions retain their
unsupported-schema diagnostic and are never reinitialized. Technical authority records must come
from an explicit enrollment/migration owner. Their presence does not authenticate an actor or
prove a configuration approval.

| Namespace | Logical record | Meaning |
|---|---|---|
| `state` | `authority/lifecycle` | Active/fenced authority ID, epoch and adapter binding |
| `state` | `stories/<identity>/head` | Conditional sequence, configuration pin and immutable state reference |
| `config` | The head's exact immutable version key | Configuration closure content binding |
| `runtime` | `lifecycle/prepared/<identity>` | Immutable operation intent and original revision preconditions |
| `evidence` | `lifecycle/operations/<identity>` | Immutable before/after state, input digest and retained evidence references |

Story and operation key identities use stable digests, independently of source branch names and
laptop paths. Source branch names can remain in the full workflow body as source-control facts.
Large workflow histories use immutable `state` content, bounded to 16 MiB, 250,000 JSON nodes and
64 levels. Metadata remains within the existing 64 KiB record limit. Encoding, identity, structural
bounds and content integrity checks do not replace the kernel's lifecycle and evidence policies.

## Capture, prepare, commit and inspect

`capture()` loads the exact head, authority, immutable configuration and complete state body.
It verifies content and rereads the head/authority to reject a mixed observation. Its returned
workflow is detached; revision preconditions stay private to that host instance. A fabricated
snapshot cannot be used to prepare a write. Configuration pins remain fixed for the active Story;
moving a future-Story approved pointer neither rebinds it nor invalidates its existing pin.

`prepare(snapshot, proposal)` accepts a registered mutation name, explicit operation ID, request
digest, complete proposed state bytes and shared evidence references. It copies inputs before
awaiting I/O. It stores the immutable body and verifies evidence, then conditionally writes an
immutable runtime checkpoint against the captured authority, Story and configuration revisions.
No lifecycle head has advanced at this point. Reusing an ID with changed intent is refused.

`commit(operationId)` reconstructs the exact transaction from that durable checkpoint, rather
than recomputing a proposal from current state. It first inspects the same storage operation.
An accepted operation returns its original receipt, including after later Story writes or fencing.
A pending one rechecks active authority and retained content, then conditionally commits the head,
immutable manifest, audit event and SDA receipt together. Record revisions and transaction revisions
remain opaque and independent; receipt validation does not assume record ordering.

The final transaction retains the original authority, head and immutable configuration revision
preconditions. A stale writer gets a conflict. A fenced-and-reactivated authority cannot refresh
an old prepared operation into a new write. There is no unconditional overwrite, automatic retry
with new preconditions, dual write or backend fallback.

`inspect(operationId)` distinguishes missing, prepared and committed. Lost acknowledgements retain
their original errors and causes; the caller inspects the same ID before deciding what to do next.
A restarted process can finish a prepared write without its original in-memory snapshot. After
acceptance, a cancellation or result-projection error cannot erase the stored receipt. A malformed
post-commit receipt keeps the durable operation available for inspection.

Local attachment references cannot become shared evidence. This component has no local attachment
port and never copies uploaded bytes. Only explicitly supplied shared evidence is integrity-checked.
Bodies stored before a failed checkpoint/metadata transaction can remain unreferenced; they are
not accepted lifecycle state. Their cleanup requires the later verified retention policy.

## State body v2 and terminal Stories

The kernel closes a completed Story with `status: closed` and `currentPhase: null`. The first
namespace state format required an active, owned phase pointer for every body and therefore
refused that transition. A regression reproduced this refusal through actual conditional prepares
on filesystem, SQLite and application-owned metadata stores before the format was extended.

New state bodies use schema version 2 and `sflow-namespace-lifecycle-state/v2`. A v2 body carries
an explicit owned `currentPhase`. It may be null only alongside an explicit `closed` or
`cancelled` status. Active pointers still name an owned phase; missing pointers, unrecognized
terminal statuses, mismatched version/format tags and unsupported future versions are refused.
The existing Story, project, authority, configuration and phase identity checks remain in force.

The state family declares `preserve-versions`: the foundation schema owner selects the version's
format and wire-shape constraints, and the namespace contract validates that profile without its
own version branches or record migration. This is independent of the native workflow migration
registry. A v1 body keeps its original active-phase meaning, tag and bytes. The v2 reader does
not reinterpret a v1 terminal
body or restamp a retained record. A prepared v1 operation still commits its original bytes and
returns its original receipt. A later admitted operation may write a v2 body while retaining the
v1 predecessor as immutable lineage. Head, intent, event and receipt formats remain unchanged.

Storage acceptance does not grant phase approval, cancellation or reopening authority. Those
remain policy-owner decisions. A closed aggregate still returns the kernel's confirmation gate
before reopening, and a local `phase.begin` operation cannot be relabelled as a shared commit.
Project enrollment, local-draft coordination and production lifecycle admission remain separate
runtime work; the terminal tests do not constitute a complete headless Story.

## Remaining integration

The committer does not authorize publication, submission, approval or human decisions. It does
not compile configuration, execute tests, infer acceptance, sign evidence or run source-control
effects. A test composition passes the real registered `phase.publish` coordinator and shared
kernel state updates through the port, without treating that test host as a production policy
implementation. Complete namespace lifecycle ports must still enforce the same actor, policy,
artifact, evidence and generation rules as the installed engine.

SGOS execution attempts and source-control effects retain separate intents and acknowledgements;
a namespace metadata transaction cannot atomically push source code. Complete headless Story
execution, public host composition, verified export/import, installed-client fencing and authority
cutover remain required. This component's local authority checks do not close Phase 8.

## Initial v1 qualification

Mac qualification on Node 26.12.0 passed 288 checks across 18 files, with no failures, cancellations
or skips. Thirty-five new persistence cases cover all three metadata compositions, simultaneous
writers, durable restart, changed intent, immutable configuration, fencing/reactivation, receipt
reconciliation, missing evidence, encoding/bounds, cancellation and local-content exclusion.
A separate empty-PATH process opens actual SQLite stores, finishes a prepared operation and
replays its original receipt while module hooks refuse Git, filesystem discovery and providers.
The suite also covers native SDA crash/durability checks, content integrity, namespace read parity,
the real installed SDK archive and unchanged native CLI/SDK publication.

The first receipt check incorrectly equated record and transaction revisions. Qualification caught
that assumption; the final validator retains opaque independent revisions and unordered record
bindings, with explicit regression coverage. No native store semantics were changed.

Source validation passed 3,712 checks. VS Code typechecking, all 13 existing bundle budgets, Git
ownership audit (2,011 sites) and whitespace checks passed. The gateway remains at 852 modules /
6,788,712 bytes. Test repositories, remotes, databases and machine state are isolated. No Windows,
hosted CI, live provider, installed-project migration, install, push or merge was performed.

## Terminal-state v2 qualification

Mac qualification on Node 26.12.0 passed 335 tests across 19 files, with no failures,
cancellations or skips. Fifteen terminal-state cases cover the actual kernel completion update,
all three metadata compositions, separate-process completion and receipt replay, preserved v1
heads and prepared bodies, immutable predecessor lineage, invalid/future records and unchanged
reopening admission. The suite also checks native workflow journeys, SDK archive installation,
namespace read parity, storage conformance and crash/durability behavior. The terminal cases
exercise storage of admitted transitions; they do not stand in for production actor admission
or a complete headless Story runtime.

Source validation passed 3,731 checks. VS Code typechecking, the Git ownership audit (2,011
sites), all 13 bundle budgets and whitespace checks passed. The gateway remains at 849 modules
and 6,802,228 bytes. Test repositories, content stores and machine state are isolated. No Windows,
hosted CI, live provider, installed-project migration, install, push or merge was performed.
