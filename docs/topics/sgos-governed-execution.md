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
related:
  - governed-execution
  - workflow-authoring
  - evidence-and-ledger
version: 1
---
SGOS compiles confirmed intent and a ratified workflow into a finite, content-addressed Governed VM
Program. Its operational Process state never replaces Story, Initiative, configuration, ledger, or
Git authority.

## Purpose and prerequisites

Use this profile to inspect and exercise the deterministic SGOS compiler and runtime. Start inside
the selected governed repository with committed input JSON for the Intent IR, Workflow IR,
Ratification, policy snapshot, registry snapshot, and optional Process Binding. The first profile is
model-free and sequential. Unsupported agent and device execution refuses safely.

## Use it from each surface

- **Shell:** use `singularity-flow intent`, `program`, `process`, `task`, and `request`; run each
  command with `--help` before a mutation.
- **Copilot:** ask `@sflow /how` for the reviewed SGOS topic, then prepare the exact CLI command in
  the repository terminal. Help does not execute it for you.
- **VS Code:** use the integrated terminal for this first profile and inspect the generated JSON
  with the editor. A dedicated Process graph is a later surface, not a second execution engine.

## Guided workflow

1. Validate the exact input records with `singularity-flow intent validate <FILE>`.
2. Compile with `singularity-flow intent compile <INTENT-IR> --workflow <FILE> --ratification
   <FILE> --policy <FILE> --registry <FILE> --out <PROGRAM>`.
3. Inspect with `singularity-flow program validate|explain|simulate <PROGRAM>`; simulation performs
   no task execution.
4. Start one local Process with `singularity-flow process start <PROGRAM> --binding <FILE>` and
   retain the returned Process ID and checkpoint hash.
5. Use `process status|graph`, then execute one intrinsic deterministic boundary at a time with
   `process step`. Kernel work stays refused until the host registers a separate handler, Candidate
   Snapshot capture, and verifier. Inspect immutable results with `task evidence`.
6. Answer a typed Human Request only with its exact request hash. Pause or resume only with the
   current checkpoint confirmation.

The same confirmed inputs compile to the same Program hash. Compilation refuses unknown task
kinds, unbounded constructs, cycles, orphan tasks, unmapped clauses, unknown registry operations,
missing evidence or authority, unsafe writes, consequential effects without recovery, and
unreachable terminal states.

## State and safety

- Models may propose Intent or Workflow IR; they cannot ratify it.
- Ratification binds exact intent, workflow, policy, registry, and storage hashes.
- Process updates use a repository-bound subject lock and expected revision.
- A task succeeds only after an independently checked immutable candidate and Task Receipt.
- Human responses bind the exact request, pinned authority, and current Process revision.
- Process checkpoints live below the Git common directory and do not alter application or Story
  state. Existing Story transitions continue only through existing lifecycle commands.

## Troubleshooting

- A digest mismatch means the reviewed input moved. Revalidate and recompile; do not copy the new
  digest into an old confirmation blindly.
- An unsupported opcode stays visible in explain/simulate but will not run until a reviewed adapter
  and verifier exist.
- A stale response or checkpoint must be re-read with `request show` or `process status` before it
  can be retried.
- A missing receipt means the task did not succeed. Inspect `task evidence`; never infer completion
  from a handler message or changed file.

## Related topics

See `docs/SGOS.md` for the implemented boundary and staged roadmap. Continue with
`sflow explain governed-execution`, `sflow explain workflow-authoring`, or
`sflow explain evidence-and-ledger` for the existing authoritative lifecycle.
