# Rejection through the Engine SDK

`phase.reject` is a registered human decision. `engine.rejectPhase(inputs)` and
`engine.run('phase.reject', inputs)` enter the same coordinator. The native CLI keeps its existing
`reject` grammar, messages, command-result envelope and Copilot routes. It supplies interaction
callbacks to the Git composition; it no longer opens the lifecycle transaction itself.
The native interaction resolves both `reject PHASE --work-id ID` and the retained
`reject ID --phase PHASE` grammar. The SDK binds its verified phase rather than interpreting a raw
positional token as a phase or branch name.

## Ownership and input

The SDK coordinates `load`, `prepare`, `commit` and `finish`. The kernel binds the Story/source
generation and projects the recorded result. Rejection targets and required comments are pure
rules in `kernel/approval-policy.mjs`; the native transition calls them at their original decision
points, preserving refusal ordering. A technical correction can return to the same phase; business
returns follow the pinned configured targets. An upstream-owner return must be to an earlier phase.

| Input | Meaning |
|---|---|
| `workId`, `phaseId` | Optional explicit Story and source phase selections |
| `target` | Return destination; defaults to the source phase |
| `reason` | The change-request comment, subject to the existing policy |
| `clauseIds`, `members` | Exact specification clauses and members of the target artifact set |
| `repair`, `confirm` | Existing early testing-repair request and exact change-set confirmation |
| `selectionReceipt`, `fetch`, `agent` | Existing native binding options; the agent is audit context |

The Git port loads the accepted Story definition and native actor through the same admission used
by the CLI. Presence signing remains before writes. Public inputs cannot supply an actor,
authority group, signer, native repair plan, transaction callback or unsubmitted-phase exception.
Internal convergence and upstream-return coordinators retain their existing verified exceptions
through the compatibility aggregate; exposing this operation creates no new exception.

## Native records and effects

The installed rejection transition lives in `engine-compatibility/rejection-transition.mjs`.
The `state.mjs` compatibility export supplies its existing collaborators. The transition retains
the original change-request and rejection-decision fields, IDs, timestamps, hashes, retained review
packet references, history events and context-boundary handoff. It uses the original authority,
sequence, specification, artifact-set, repair-budget, checkpoint and workflow writers.

Clause IDs must exist in the active specification. Surgical member selections are checked against
the target phase's set. Budget exhaustion remains a refusal before checkpoint creation. Reopening,
conditional approval retention, work-interval baselines and later publication promises keep their
existing semantics. No model provider, application test, approval or automatic successor
publication is invoked by the SDK coordinator.

The Git operation port wraps that transition in the existing `PHASE_REJECTED` `transactStory`
unit. Publication preflight and atomic rollback remain the existing writer's responsibility;
the CLI cannot first save an unauthenticated decision and publish it afterward. The native
transition is separate from the interaction port so importing the record writer does not pull
review prompts, receipt selection or specification-library services into lightweight runtimes.

## Result and recovery

The SDK receipt reports the exact source phase/generation, returned phase, opaque publication
revision and push outcome. It projects the recorded change-request ID, scope, reason, actor,
authority and retained packet reference, plus consumed/maximum repair budget when applicable.
Legacy numeric generation metadata is projected to numbers without rewriting the retained workflow;
the receipt checks the exact requested clause and normalized logical member selections.
The host keeps raw native records, local paths and conversation-reset wording in its private
presentation context. A rejection records a request for changes, not phase approval.

Cancellation stops before acceptance. A confirmed commit is still reported if cancellation arrives
after commit. Native conflict, unknown-outcome, pending-publication and scope/authority failures
retain their error identity and recovery details. If result projection fails after acceptance, the
actual accepted publication is attached as `enginePublication` rather than reported as no effect.

After the accepted transition, the existing session activation follows the returned phase. A
local activation failure or a failing notice observer does not erase or misreport the decision.
The CLI renders its existing refresh route; a headless host receives the notice through the
trusted observer and the SDK notification buffer.

## Qualification and remaining work

Contract tests exercise custom phases, forbidden identity/exception injection, exact binding,
pre/post-commit cancellation and preserved failures. Real disposable Story tests cover unknown
clauses, incorrect target members, required comments, native actor authorization, earlier and
same-phase returns, actual source CLI/SDK receipt parity, the built CLI and post-commit session
failure. The broader qualification also exercises existing repair, upstream, convergence,
approval and packaging paths. Architecture guards restrict native transition access and prohibit
direct rejection transactions in the CLI.

This is the native rejection slice of Phase 5. Remaining queries and native policy extraction,
namespace-backed lifecycle writers, complete headless Story execution and verified migration
retain their scope in [the migration plan](ENGINE-SDK-MIGRATION.md). Existing Git authority remains
unchanged. Qualification for this branch is Mac only; no hosted CI or provider execution is used.

The broader macOS 26.7.2 / Node 26.12.0 qualification passed 128 checks across 16 files, including
the explicitly enabled slow rework and testing-repair journeys. After tightening generation/member
receipt binding, a final 55-check run across five files passed, including rebuilt CLI execution,
native actor/refusal checks, packed SDK consumers, declaration compilation and import guards.
Both runs had zero failures, cancellations or skips. Source validation passed 3,683 checks;
VS Code typechecking, Git ownership audit, all 13 unchanged bundle budgets and dry-run packaging
passed. The gateway has 852 modules / 6,749,319 bytes; no limit was raised. The SDK archive includes
38 registered operations and 50 owned source modules. The extraction removes 237 net lines from
`state.mjs` and the CLI no longer owns rejection
transactions. Namespace lifecycle writes and migration are not enabled by this change.
