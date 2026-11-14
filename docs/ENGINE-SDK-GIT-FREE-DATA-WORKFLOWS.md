# Git-free work products and data execution

This branch adds two bounded namespace-backed reference workflows: analytics over retained
query/data inputs, and a batch transform into an explicitly owned SQLite sink. Both use the
registered Engine SDK, kernel rules, SDA transactions and SGOS execution history. Neither
requires a repository, branch, worktree or Git executable. Copilot remains the only AI harness;
these particular execution steps are deterministic and make no AI call.

This is an SDK-preview delivery under the [revised completion specification](SPEC-ENGINE-SDK-COMPLETION-AND-GIT-FREE-WORKFLOWS-v1.md).
It does **not** complete every outstanding Phase 5/7 owner or perform Phase 8 authority migration
or Phase 9 CLI/VS Code cutover. The [coverage ledger](ENGINE-SDK-PHASE-5-7-COVERAGE.md) lists those
owners explicitly. Installed Git projects and their authority remain unchanged.

## Ownership and wire contracts

The pure work-product rules live in `src/kernel/work-products.mjs`. They validate declared
requirements, measurable acceptance criteria, work-product dependencies, typed datasets and
observed quality results. They cannot access a filesystem, process, model or storage backend.
A work-product reference identifies its project, kind, immutable content, revision, observation
and producer. Retained bytes, an external snapshot identity and a live observation are distinct
claims; retaining a JSON file does not certify an external database snapshot.

Namespace configuration source/compiled v2 add a `workProducts` map keyed by workflow ID.
Original v1 sources still compile to their original v1 shapes. Their hashes and stored records
are not upgraded. Work-product policy v1 requires:

- requirements with exact criterion bindings;
- one producing phase for each asset, with earlier producers and acyclic dependencies;
- a declared query, named input snapshots, output and deterministic adapter for execution;
- actual metric/comparison checks, with unique criterion IDs and no vacuous success;
- a closing phase that consumes all required criterion producers.

An execution declares exactly its one real output; extra outputs that this adapter cannot produce
are refused during configuration. This first data profile is sequential. Routed data products need their own versioned acceptance
owner and are refused during configuration, before Story creation. Existing routed workflows
without a work-product policy retain their original behavior.

The namespace mutation, SQL execution, sink observation and publication report each have their
own versioned record family. Mutable indexes must replay their original accepted mutations.
A retained source or output cannot be substituted by supplying a caller's successful boolean.

## Registered operations

| Operation | Behavior |
| --- | --- |
| `work-product.context` | Returns the exact phase/input binding, actual retained references and applicable SDK actions. |
| `work-product.retain` | Retains declared producer outputs from explicit shared immutable content. |
| `data.execute` | Executes one approved query/batch through a bound SGOS unit, retains its actual outcome, then conditionally records it. |
| `work-product.amend` | An authenticated phase approver changes a current-phase query/input, against its exact inspected binding and with a reason. |

A dataset/query must come from an actual approved producing publication before execution.
The data task pins the query and dataset bytes, configuration, phase, generation, actor,
execution manifest and zero-model budget. The execution manifest also pins the actual runtime
and fixed-driver digests. The installed `execution/data` entry exports its actual driver digest;
a changed driver cannot silently run under an older manifest. Batch writes must match the exact sink capability in
that manifest. An operation ID with another request is refused. Published generations direct
new authoring to their retained review; another execution cannot silently replace their inputs
while approval is pending.

The existing preparation, publication, submission, independent approval and rejection operations
remain the lifecycle path. Publication retains a work-product report from the original conditional
basis. It connects requirement → criterion → actual observation → producer generation → work
product. A receiving acceptance phase preserves the producer's attribution and does not claim
another query or check execution. Process exit zero cannot satisfy a failing or unavailable
business metric. Closing acceptance requires matched evidence for every declared requirement.

## Actual SQL execution and recovery

`execution/data` exposes an explicit Node/SQLite adapter. The embedding host supplies a qualified
Node executable and its digest, content store, project scope, manifest, authorization callback,
deadline and optional sink. Construction does not launch a process or choose an installed runtime.
The concrete SQL runtime is qualified on Node 26.12.0; it needs SQLite's read authorizer.
The SDK's existing general Node minimum is unchanged.

SQL and data travel through stdin to a fixed driver. SQL is never interpreted as JavaScript or
shell syntax. The driver loads bounded typed snapshots into memory, admits one read-only query,
denies writes/attachments/unapproved functions and bounds input, rows, output and runtime.
It uses SGOS's existing pinned-process/termination owner, including actual process-group
quiescence. No additional process/Git bypass site is introduced.

Batch writes use a transaction and stable batch ID in a dedicated owned sink. The sink preserves
its original request, output and task-contract identity. A repeated committed batch returns the
original output and says that the query was not executed again. A reused committed ID with
another transformation is refused. Unrelated tables, another project/sink identity, symlinked
bindings and changed runtime bytes are preserved/refused rather than overwritten.

Attempts are durably recorded before dispatch. A pending attempt prevents another phase attempt
from silently replacing it. Uncertain ownership remains an explicit SGOS recovery condition.
The active-attempt index must match its original immutable intent and accepted transaction
revisions. A missing index cannot erase its original claim; an older intent cannot replace the
current index. Future versions and actual receipt-read errors remain explicit refusals.
A deadline proves neither a successful batch nor an absent effect. After genuine quiescence,
the optional sink inspector reads the actual original batch without executing its query. A
confirmed absent batch permits a reviewed input repair; a committed conflicting batch requires
an explicit distinct logical batch ID. Inspection evidence is retained separately from the
original timeout. This is transactional SQLite-sink behavior, not a distributed exactly-once
claim for arbitrary external systems.

A current-phase input amendment preserves the approved producer, original bytes, failed run,
criterion and expected outcome. It requires the configured phase approval authority. It cannot
manually replace an execution output or rewrite an earlier approval. Genuine failures remain
failed/unavailable after repair; the later passing execution has its own identity.

Contexts and publication failures share the kernel's continuation rules. A failed run leads to
reviewed input repair or resolution of the execution environment; it does not suggest a blind
identical rerun. Once data execution has passed, the next step is phase authoring. Already
published generations lead to review, preserving their accepted evidence.

The actual process status, timeout flags, error code and diagnostic details remain observable.
The context contains a bounded UTF-8 diagnostic preview and an exact immutable observation
reference. `document.read` and `phase.context.read` can read the complete retained bytes without
guessing laptop paths. These Story-level input/observation documents are available before phase
publication; their receipts retain the exact producing phase and generation separately.

## Context, takeover and packaging

Namespace phase-entry manifest v6 carries the approved data policy and exact work-product
resources. `phase.context.read` reads those references with explicit budgets and truncation.
Original v1–v5 manifests retain their shapes. The SDK emits structured context and actions;
Copilot integration owns prompt wording and command rendering.

Completed execution inspection uses a read-only SGOS reader, sharing the original durable
execution wire validator. It verifies the event chain, candidate, failure and quiescence without
an executor, ownership lease, clock or write capability. A second host can acknowledge completed
`data.execute` with `data: {mode: 'retained-only'}` and no private draft store. An actual completed
SGOS result whose lifecycle acceptance was interrupted can also receive that original acceptance
without the old interpreter, after fresh current authorization and exact input/actor/configuration
checks. Already accepted acknowledgement does not restamp its original observation. An unfinished
attempt still needs its original owner/executor; a new run requires an explicit qualified binding.

The SDK archive exports `work-products` and `execution/data`, with NodeNext declarations.
No direct model-provider adapter or SField dependency is added. Local attachment handling is
unchanged: ordinary uploads remain device-bound; these data operations accept only explicitly
shared immutable content, never a laptop path.

The qualified scope is retained typed snapshots, the bounded SQLite query dialect, one owned
transactional sink and the declared sequential reference workflows. Distributed sinks, notebook
execution, routed data acceptance, live Copilot sessions and production surface cutover need
separate qualification. The registered action is an SDK operation, not an invented CLI or
Copilot slash command.

## Qualification

Mac tests cover real SQL, failed business checks despite process success, schema/requirement
validation, write/attachment/function refusal, deadlines and actual termination, batch replay,
read-only sink reconciliation, changed permissions/runtime/intent, human input repair, independent
phase approvals, concurrent worker claims, exact diagnostic reads and completed-generation protection. Analytics, transactional batch and reviewed
input-repair journeys complete across filesystem, SQLite and application stores. A real offline npm consumer executes SQL with Git/AI imports
blocked, completes the Story, removes private files and acknowledges the original result without
an executor or clock. NodeNext checks include negative content-path and missing-binding examples.

Qualification ran on this Mac (darwin/arm64, Node 26.12.0): 1,159 distinct affected checks across
134 files, including 45 checks in the six new data/work-product files, 118 architecture guards
and 41 native SDK/CLI parity checks. Ten additional installed consumers pass. The unchanged
original 34-check package qualifier ran alone in 65.8 seconds, within its original 120-second
parent and 60-second child limits. Final runs contain zero failures, cancellations, skips or
TODOs. Counts deduplicate repeated files; earlier failed runs are not counted as qualification.

Affected files ran serially in isolated test-machine directories. This is targeted qualification,
not the entire repository test suite or a cold/warm product latency benchmark. Fixture approvals
use separate authenticated test principals, not a customer approval. Source validation passes
4,471 checks; VS Code types, the unchanged 2,011-site Git audit and all 13 bundle ceilings pass.
The gateway has 852 modules and 6,950,161 bytes, within its unchanged limits.

Validation corrected stale inventory/future-version test expectations and a guard that confused
an observed `process` property with access to the global process. A new consumer initially used
the pure execution entry instead of the actual `execution/node` manifest factory; the corrected
consumer passes. The diagnostic read regression exposed and fixed a real draft-versus-published
generation binding error. The new timeout-recovery fixture now separates its deliberately
500 ms failing attempt from the repaired operation's normal 30-second window, inside the same
five-minute task budget; original failing evidence is retained. One existing filesystem risk
journey also exceeded its original 170-second case limit during the initial combined run. Its
complete six-case file passed separately without raising that limit; the timeout's cause is not
established. No failed receipt or negative quiescence result was waived.

Windows, hosted CI, live AI calls, installation changes and a main merge are outside this run.
