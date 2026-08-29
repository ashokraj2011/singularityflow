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
- a model-free compiler with a closed opcode vocabulary and deterministic output;
- compile-time refusal of unbounded work, cycles, orphan tasks, unmapped confirmed clauses,
  missing evidence, ungoverned judgment, unsafe overlapping writes, and consequential external
  effects without recovery;
- a sequential GVM executor for deterministic kernel operations, verification, checkpoints,
  human requests, no-ops, and terminal steps;
- machine-local operational checkpoints under the repository Git common directory, protected by
  subject locks, expected revisions, atomic replacement, and content hashes;
- success only after deterministic verification creates a Task Receipt;
- stale-response protection for typed Human Requests;
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
and deterministic verifiers. The first CLI surface intentionally does not invent those adapters:
`process step` runs intrinsic `NOOP`, `CHECKPOINT`, `HUMAN_REQUEST`, and `END` boundaries, while a
kernel task without trusted adapter wiring is refused.

Operational SGOS files are rebuildable. Deleting them cannot alter Story or Git authority. A local
process can observe and project existing Story state, but only the established lifecycle kernel may
publish a phase, submit it, approve it, or advance it.

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

Compilation is pure: timestamps are not injected, source key order is irrelevant, and the same
confirmed records produce the same Program hash.

## Execution and recovery

The scheduler derives the ready set from the Program and current durable Process state. Completion
order is never an authority rule. Each state mutation compares the expected process revision while
holding the process subject lock. Resume requires the exact checkpoint that guards that durable
state; checkpoint-payload restoration and replay remain staged. A tampered checkpoint, changed
Program, changed policy, stale request, or lost revision is refused.

Every successful task names its attempt, input and output references, verification result, evidence,
and exact Task Contract hash. Without that receipt, the task is not successful.

## What remains staged

The following larger SGOS capabilities remain behind explicit refusal boundaries until their
conformance suites exist:

- parallel resource leases, deterministic joins, bounded fan-out, replay, and forks;
- Copilot and other Governed Execution Unit adapters;
- typed device mediation and Tool Intent/Tool Result recovery;
- full candidate freeze/verify/publish commands across every lifecycle;
- unified memory promotion and secret-broker integration;
- a general Authority Store SPI and non-Git authority profile;
- signed Capability Packs, meta-tool promotion, `sf-learn`, and multi-domain packs;
- full Command Center and process-graph UI.

This staged boundary is intentional. Existing product behavior stays compatible while each SGOS
authority claim gains its own deterministic tests.
