# Targeted Code repair through the namespace Engine

A reviewer can return exact approved clauses to their Code owner through `phase.reject`.
The return authenticates the original submitted review, the target's actual Code publication,
its independent approval where required, and the human-approved plan. Selecting clauses does
not authorize edits to another clause's files or another repository.

This extends explicit namespace storage. Installed Git records, CLI outputs, identity rules and
production authority remain unchanged. Artifact-member and document-only targeted returns still
need their separate owners; they do not fall back to unrestricted repair.

## Ownership and records

The kernel derives exact paths and compares actual predecessor/current source deltas. The SDK's
registered rejection path coordinates the return. Read-only namespace readers authenticate the
original publications, plan corrections and conditional receipts. SDA retains those records;
SGOS still executes each fresh test run. Hosts receive structured actions and resource identities.

The new records have explicit versions:

| Record or manifest | Meaning |
| --- | --- |
| Human decision v3 | Clause-targeted return, with the original review and optional repair budget |
| Code history v8 | Actual targeted predecessor and current human-approved scope |
| Code policy/report v14/v15 | Targeted repair, with separate mixed-human-acceptance meaning |
| Code policy/report v16/v17 | Repository-local clause coverage |
| Code policy/report v18/v19 | Repository-local coverage combined with targeted repair |
| Phase entry manifest v4 | Original/current repair scope and exact readable provenance resources |

Original human decision v1/v2, Code v1–v13 and earlier authoring manifests keep their meanings.
Captured pre-change profile values protect the old flags and version precedence. A newer
unsupported version remains an explicit version error.

## Exact scope before authoring

`phase.review` supplies the submitted packet digest. Pass that exact digest, the target phase,
the selected clause IDs and the human's reason to `phase.reject`. No actor or approval claim is
accepted as an operation input.

The reader derives locations from approved plan rows, including actual human plan amendments
and corrections. Clauses must exist and be allocated to the selected Code phase. Duplicate,
unknown, unallocated or wildcard locations are refused. The public change request preserves the
human's clause order; its internal scope has deterministic ordering.

`phase.enter` then exposes:

- the original accepted return and predecessor publication;
- the exact original scope and current human-approved scope;
- repository IDs and local paths, including empty selections for other repositories;
- other clause owners of shared files;
- plan and return resources readable with `phase.context.read`.

Use each issued resource ID with that manifest's `contextSha256`. Do not derive a laptop path
from a logical record key. A changed draft, Story, source or permission invalidates the old
context. Original permission and deadline errors remain available to the caller.

## Repair without resetting the phase

Publication compares actual retained source bytes with the authenticated predecessor. An edit
outside the selected paths returns `ENGINE_TARGETED_REPAIR_SCOPE_EXCEEDED` and preserves the
draft. Its actions identify `phase.source.inspect` and `plan.correction.context` with the actual
`ownerPhase`; the latter also requires the exact correction operations and reason.

An authorized planner can record the correction, after which the author explicitly rebinds the
preserved draft under its new basis. The current scope is recomputed from that real decision.
The original return is immutable. A plan correction creates neither another change request nor
another repair attempt, and it does not approve Code or a visual result.

After source retention and fresh execution, publication retains the replacement Code proof.
Unchanged source still requires a new real execution. Mixed visual acceptance needs a new exact
candidate decision even when the output image bytes are unchanged. Earlier Code phases keep
their own source, tests and original human approvals.

The budget is consumed by the accepted human return. A lost transaction acknowledgement and
retry return the same accepted result. Changing a selector cannot reuse that operation as a new
return, and shared-only replay does not restamp its time or consume another attempt.

## Repository-qualified coverage

Previously, one repository could be checked against clauses allocated exclusively to another.
The new coverage profile derives repository views from the actual qualified plan and retained
Code predecessors. It filters only the evaluator's ephemeral clause view; the original clause
indexes and approved plan references remain bound in the report.

Globally unassigned clauses remain visible in every view. Unknown observations remain available
to the evaluator as invalid evidence and cannot become active clauses. Whole shared views retain
the original profile. Accepted older proofs continue replaying under their original global view.

## Qualification scope

Mac qualification includes real source changes, actual Node tests, independent human decisions,
lost acknowledgements, exact context reads and source-free replay. Targeted returns, shared plan
corrections, unchanged revalidation and qualified repository isolation run on filesystem, SQLite
and application storage. The larger combination of two prior Code phases and mixed visual
acceptance runs on SQLite; existing multi-Code backend journeys remain separate regression cases.

An offline installed consumer uses an empty executable path, records the targeted return, reads
the exact scope resources and replays the accepted replacement after source deletion. This does
not install or mutate production authority. The original installed qualifier and all bundle
ceilings remain unchanged. Qualification passes 231 distinct affected Mac checks, including the
unchanged 34-check package qualifier run alone in 95.2 seconds within its original 120/60-second
limits. Source validation, VS Code types, the unchanged Git audit and all 13 bundle ceilings pass.
Detailed scope and limits are recorded in the active completion ledger.

The remaining Phase 5/7 owners are tracked in
[the completion ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md). This delivery alone does not complete
either phase.
