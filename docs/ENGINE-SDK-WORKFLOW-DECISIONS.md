# Workflow decision compiler and interpreter

`src/kernel/workflow-decisions.mjs` owns decision configuration validation and route evaluation.
The compiler checks named inputs, reused values, authority groups, dependency skips, review
checkpoints and bounded loops. The interpreter reads the pinned program and recorded inputs; it
does not read Git, discover a repository, invoke a provider, write records or authorize a person.

Native configuration loading, route simulation, phase retention and submission input recording
use that same owner. The old decision-input module and the unchanged public compiler/matching
exports remain compatibility aliases. The registered `decision.choose` operation still uses the
existing native transaction and authority checks. This extraction adds no second execution route.

## Facts and native presentation

`decisionOutcomeFacts` returns the selected route, destination, skipped phases, round count and
structured predicates. The native `decisionOutcome` projection supplies the existing rationale
strings, preserving durable records and output ordering. A failed loop pauses at its configured
limit. A human may request earlier rework; neither that choice nor forged echoed values can make
failed recorded conditions pass. Conditions are recomputed from the pinned program and submitted
values before accepting a constrained choice.

`pendingDecisionPayload` constructs the same pending question without sampling time or hashing.
The native record owner receives the existing explicit timestamp and appends the original
canonical SHA-256 key. Expected-key validation, identity, membership and transaction publication
remain native checks. A payload alone is not permission to record a decision.

`resolveDecisionChoicePlan` enforces choice rules and raises typed refusals. Its native wrapper
preserves the existing CLI messages and recovery command. Rule descriptions, command assignments,
screen projections and command guidance remain in the native adapter. Existing decision-input
diagnostics remain compatibility text in the shared normalizer; they are not executable actions.

`skippedDeliveryObligations` conservatively identifies omitted delivery responsibilities. The native
applicability owner still evaluates any approved no-change exception before using that analysis.
There is no caller-supplied boolean that grants an applicability exception. Earlier delivered
generations retain their established meaning in a later repair round.

## Compatibility and remaining work

The qualification fixture was captured from `53c343157` before production edits. It binds 35
serialized results, including compiler errors, reused inputs, branch/loop/ask outcomes, pending
keys, display projections and constrained-choice refusals. It also fingerprints the original
bodies of 24 unchanged functions. Tests separately exercise detached predicates, conservative
obligation analysis and attempted condition bypasses, and execute the interpreter while refusing
all infrastructure imports and executable discovery.

This is a Phase 5 policy extraction. It does not migrate installed storage, authorize approvals,
replace the native lifecycle writer or complete portable Story execution. Those remain later
gates in the migration plan.

Mac qualification on Node 26.12.0 passed 151 checks across 20 files, without failures, skips or
cancellations. This includes native routing and limit journeys, source/bundled CLI lifecycle parity,
next-step guidance, architecture guards and the externally installed SDK archive. Source validation
passed 3,696 checks, VS Code typechecking passed, and the Git ownership audit found no new bypasses
among 2,011 registered sites. All 13 unchanged runtime bundle budgets passed; the gateway remains
852 modules / 6,758,433 bytes. Tests use isolated machine state and disposable repositories. No
Windows, hosted CI, model, real Story, installation or storage-authority change was performed.
