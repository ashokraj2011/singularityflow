# State authority and recovery contract

The lifecycle branch owns operational state; local context selects it; the state branch proves and mirrors it; every mutation passes through one deterministic publication transaction.

## Authority table

| Plane | Stored at | Role | May select work? | May authorize a mutation? | Recovery rule |
|---|---|---|---:|---:|---|
| Story lifecycle | `singularity/work-items/<ID>/workflow.json` on the Story lifecycle branch | Operational authority for Story phase, artifacts, decisions, and revision | Yes | Yes | Fetch and fast-forward the registered canonical or child branch; never reconstruct it from session state or the ledger |
| Initiative lifecycle | `singularity/initiatives/<ID>/state.json` on the Initiative lifecycle branch | Operational authority for Initiative phase, evidence, approvals, and breakdown | Yes | Yes | Fetch and fast-forward the registered lifecycle branch; append-only retry is a conflict strategy, not a second authority |
| Local context | `.git/singularity-flow/session.json` and the workspace selection under the user profile | Selects a lifecycle subject and governed agent for this checkout | Yes | No | Recreate it from a selected lifecycle branch; deleting it loses no governed state |
| Pending publication | `.git/singularity-flow/pending-publication/<kind>--<ID>.json` | Local recovery record for a commit that exists but did not reach its remote | No | Blocks new mutations until synchronized | Retry the recorded fast-forward push; never rewrite or amend the retained commit |
| Capability state branch / ledger | Configured orphan state branch | Append-only proof, binding, and cross-repository mirror | Read-only fallback only | No | Reconcile from committed lifecycle events; ledger-only subjects remain read-only until their lifecycle branch is available |
| Human and audit projections | `STATUS.md`, managed artifact metadata, approval summaries, review packets, ledger intents, reports, dashboards, and VS Code snapshots | Derived presentation or exact reproducible audit material | No | No | Regenerate from authoritative lifecycle state and immutable records at one captured revision |
| Remote systems | Jira, CI, storage providers, GitHub observations | Timestamped evidence and external receipts | By explicit identity/reference | No, unless an exact reviewed write plan says otherwise | Refresh observations and record drift; never silently overwrite Git-owned state |

## Resolution contract

`RepositorySubjectIndex` reads Story `workflow.json` and Initiative `state.json` using their actual schemas. It indexes stable IDs, canonical branches, registered child branches, and declared aliases. Every surface follows the same rules:

1. An explicit Story or Initiative argument wins over local context.
2. A registered canonical or child branch resolves to its owning lifecycle subject.
3. More than one match is an error that lists candidates; the system never guesses.
4. A missing reference may be treated as a new ID only by an explicit creation command.
5. A ledger-only binding is readable evidence, not a mutable aggregate.

Workspace selection and VS Code state are therefore convenient pointers, never an alternative source of truth.

## Publication contract

A lifecycle mutation must verify its branch, current HEAD, aggregate, and absence of a pending publication; write state and projections; validate invariants; stage only allowed paths; create one commit; and push without force. A failed push leaves the commit intact and writes only the local recovery record under `.git`. Cross-machine concurrency remains governed by Git fast-forward rejection.

Story and Initiative publication both delegate this algorithm to `GitPublicationUnitOfWork`. Sequence evaluation and reduction are pure; confirmation is a surface port. A subject-local lock prevents same-checkout read/modify/write races, while Git fast-forward rejection remains the cross-machine arbiter.

Projection repair never invents lifecycle facts. It may only regenerate a declared
projection from the currently loaded authoritative aggregate. It cannot recreate a
missing approval, artifact, lifecycle event, or remote receipt, and it cannot use
the ledger or local session as a substitute for a missing lifecycle branch.

`singularity-flow state reconcile <ID> --check` reports every declared projector and
its expected and current hash without writing. `--repair-projections` replaces only
the managed bytes produced by `projectStatusMarkdown`, `ArtifactMetadata`,
`ApprovalSummary`, `ReviewPacket`, and `LedgerIntent`. Review-packet and ledger-intent
recipes are captured in lifecycle state when they are created; authored artifact
content is preserved while only its managed metadata block is replaced.

This development line has no state migration layer. Only the current Story and
Initiative schemas are accepted; disposable development state must be recreated
with `singularity-flow factory-reset` and a fresh start.
