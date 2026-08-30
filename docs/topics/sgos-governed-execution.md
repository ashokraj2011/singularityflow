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
  - task
  - request
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
version: 5
---
SGOS compiles confirmed intent and a ratified workflow into a finite, content-addressed Governed VM
Program. Its operational Process state never replaces Story, Initiative, configuration, ledger, or
Git authority.

A Story subject must already exist at the exact Process baseline. SFlow validates its durable Story
record and pins the exact path, blob digest, normalized state digest, and Git revision in the
Process Binding before any task—including `NOOP` or `END`—can run.

## Purpose and prerequisites

Use this profile to inspect and exercise deterministic SGOS compiler profile v2 and the runtime.
Start inside the selected governed repository with committed input JSON for the Intent IR, Workflow IR,
Ratification, policy snapshot, registry snapshot, and optional Process Binding. The core profile is
model-free and supports a bounded deterministic parallel wave for compatible resource contracts.
Unsupported agent and device execution refuses safely.

## Use it from each surface

- **Shell:** use `singularity-flow intent`, `program`, `process`, `task`, and `request` for the
  execution core. The bounded extension profile exposes `candidate`, `execution-unit`, `device`,
  `authority-store`, `pack`, `learn`, `memory`, and `meta-tool`; run each command with `--help`
  before a mutation.
- **Copilot:** ask `@sflow /how` for the reviewed SGOS topic, then prepare the exact CLI command in
  the repository terminal. Help does not execute it for you.
- **VS Code:** run **Singularity Flow: Open Command Center** for the projection-only Process board,
  graph, evidence links, unavailable-Process diagnostics, and Human Request forms. Actions pass only
  exact identifiers back to reviewed commands; the webview is not a second execution engine.

## Guided workflow

1. Validate the exact input records with `singularity-flow intent validate <FILE>`.
2. Compile with `singularity-flow intent compile <INTENT-IR> --workflow <FILE> --ratification
   <FILE> --policy <FILE> --registry <FILE> --out <PROGRAM>`.
3. Inspect with `singularity-flow program validate|explain|simulate <PROGRAM>`; simulation performs
   no task execution.
4. Review the exact Program authority record at
   `singularity/sgos/program-authorities/<PROGRAM-SHA256-WITHOUT-PREFIX>.json` through the normal
   `sflow/config` review path. A local or application-branch copy is not authority.
5. Start one local Process with `singularity-flow process start <PROGRAM> --compiler-request
   <COMPILER-REQUEST.json> --subject <ID> --subject-kind story|repository` and retain the returned
   Process ID and checkpoint hash. Alternatively provide all five compiler input files. A Program
   self-hash, compiler inputs without approved authority, or caller-supplied digest is refused.
6. Use `process status|graph`, then execute one intrinsic deterministic boundary at a time with
   `process step`. The CLI includes reviewed read-only Story-inspection and repository-clean adapter
   pairs; other kernel work stays unavailable until the host registers a separate handler,
   Candidate Snapshot capture, and verifier. Inspect immutable results with `task evidence`.
7. Answer a typed Human Request only with its exact request hash. Use `--decision approved` for an
   approval, `--option <EXACT-ID>` for a declared choice, or `--decision provided --input-json
   '<JSON>'` for non-sensitive schema input. Sensitive requests accept only a non-secret typed
   reference through `--sensitive-handle`; never place a credential or secret value on the command
   line. Authority is pinned from the repository's configured reviewer membership when the Process
   starts and cannot be supplied by a response flag. Pause or resume only with the current
   checkpoint confirmation.
8. If a CLI process is interrupted, run `process recover <PROCESS-ID>` to inspect the exact owner,
   binding, attempt lineage, and confirmation-bound actions. Never recover while it reports an active
   owner. Use the printed `reconcile-success`, `retry-safe`, or `fail` command exactly as shown.
9. If migration doctor reports v1 Process state, a v1 Process Binding, or a v1 Human Request, run
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
10. For an intentional replay, preview `process replay <PROCESS-ID> --from <CHECKPOINT-SHA256>` and
    repeat with the printed `--confirm` digest. The installed profile reopens only a pure suffix and
    refuses prior writes, Devices, external effects, stale state, or exhausted attempts. Fork uses
    the same preview/confirm pattern and supports only a genesis checkpoint.

The same confirmed inputs compile to the same Program hash. Compilation refuses unknown task
kinds, unbounded constructs, cycles, orphan tasks, unmapped clauses, unknown registry operations,
missing evidence or authority, unsafe writes, consequential effects without recovery, and
unreachable terminal states.

## State and safety

- Models may propose Intent or Workflow IR; they cannot ratify it.
- Ratification binds exact intent, workflow, policy, registry, and storage hashes.
- Process updates use a repository-bound subject lock and expected revision.
- Dispatch and successful publication both recheck the exact repository/worktree/branch/HEAD
  binding. Portable contract paths round-trip across POSIX, Windows drive, and UNC forms.
- A live execution owns a durable local lease. Recovery never races that owner, and every retry has
  immutable parent-attempt lineage.
- A task succeeds only after an independently checked immutable candidate and Task Receipt.
- Human responses bind the exact request, current Process revision, and authority read from the
  immutable approved-configuration ref/commit/workflow-blob tuple recorded at Process start.
- Process checkpoints live below the Git common directory and do not alter application or Story
  state. Existing Story transitions continue only through existing lifecycle commands.
- Static fan-out is expanded by the compiler, joins are limited to `all-success` and `all-terminal`,
  and parallel dispatch is selected canonically under exact resource leases. Timing is never an
  authority input.
- Standalone Execution Unit and Device profiles are inspectable through their CLI commands, but
  their presence does not authorize the GVM to dispatch `AGENT` or `DEVICE` opcodes.

## Troubleshooting

- A digest mismatch means the reviewed input moved. Revalidate and recompile; do not copy the new
  digest into an old confirmation blindly.
- An unsupported opcode stays visible in explain/simulate but will not run until a reviewed adapter
  and verifier exist.
- A stale response or checkpoint must be re-read with `request show` or `process status` before it
  can be retried.
- An interrupted execution must first be inspected with `process recover <PROCESS-ID>`. Safe retry
  appears only for explicitly idempotent read-only work; otherwise stabilize it with the exact
  printed failure action or reconcile an already verified receipt.
- A missing receipt means the task did not succeed. Inspect `task evidence`; never infer completion
  from a handler message or changed file.
- A quarantined Process is preserved machine-local evidence, not runnable authority or proof of
  success. Start a new Process from an approved Program rather than copying, editing, restoring, or
  resuming quarantined records.

## Related topics

See `docs/SGOS.md` for the implemented boundary and staged roadmap. Continue with
`sflow explain governed-execution`, `sflow explain workflow-authoring`, or
`sflow explain evidence-and-ledger` for the existing authoritative lifecycle.
