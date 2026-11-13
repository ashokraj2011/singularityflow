# Test-run risk values and namespace decisions

This slice keeps test failure classification, human risk acceptance, execution and persistence in
separate owners. It does not complete Phase 5 or 7. Native Git records, risk IDs, expiry rules,
authority and public results keep their existing meanings.

## Rule and operation boundary

`kernel/test-recovery.mjs` now owns the native test-risk record values. The native adapter still
owns presence-counted records, its optional clock, hashes and command rendering. The SDK exports
the value factory as `@singularity-flow/engine-sdk/testing/risks`, with explicit cause values and
timestamps. A value function cannot authenticate a person, execute a command or retain a decision.
An independent capture contains 46 outcomes from the native owner at `9d2ab9f54`, with its source
digest. Those fixtures establish value compatibility; they are not execution evidence.

The registry adds `test-risk.context` and binds the existing `decision.test-risk` operation to a
namespace human writer. Context lists actual configured and human-accepted Story commands, their
argument digests, supported environment classes, original decisions and approval groups. It claims
neither an observed run nor passing tests. The human decision uses the exact command, argument
digest, environment class, cause, reason and bounded expiry. It has its own
`sflow-namespace-test-run-risk/v1` record and `namespaceTestRunRisks` collection. It does not invent
a native private attempt ID or put a namespace revision in a Git commit field.

Only authenticated human phase approvers may record or revoke the decision. Configured person
presence still requires its real evidence owner. A standing decision for the same command and
cause cannot be duplicated; lost acknowledgements return the original accepted receipt.

## What an accepted run means

The initial namespace profile supports artifact phases without an enabled no-waiver recovery
agreement. The separately versioned [Code and recovery-risk owners](ENGINE-SDK-COHORT-AND-CODE-RISKS.md)
now cover those combinations with actual execution and original human decisions. Existing v1
and full-command no-waiver agreements retain their original meanings; a recovery agreement must
explicitly enable the environment-risk category before that separate ceremony is available.

The publication owner reads the real SGOS contract, accepted intent, exact draft, result, raw
reports, process closure, quiescence and before/after source observations. It replays the report
parser and cause classifier, including the original source baseline's changed paths. Every
configured command and selected repository remains accounted for. Every failed test must have an
environment cause; assertion, compilation/import errors, timeouts, unknown failures, incomplete
processes, source changes and integrity failures cannot consume an environment risk. Passing
lint or build commands do not become test executions.

The publication carries separate `test-risk/v1` policy evidence. Its ordinary `checks` binding
stays null because that binding promises passing checks. The readable report retains actual
failed counts, the original task and human decision, `testsPassed: false`,
`codeFailuresWaived: false`, `crossPhaseReuse: false`, and `freshness: same-draft-retained-run`.
Prepublication says `accepted-environment-failure`; the Story evidence view does not count it as
passing evidence. Namespace publication and submission consume the exact retained run; they do
not claim a new execution at those gates. Native Git publication/submission retain their existing
rerun behavior.

Current source bytes, command inventory, decision status and conditional record revisions are
checked before publication, submission and independent approval, including the final commit
checks. Expiry or revocation cannot silently pass a later gate. A reviewer can renew the exact
expired decision while approval is pending; the original publication and submission stay
immutable. The historical report keeps the original decision, and the accepted approval also
retains the effective renewal's proof. A different command or cause needs its own decision.

Ordinary phases without an accepted risk keep `PHASE_CHECKS_NOT_PASSED`. Their refusal can expose
an actual environment-risk recovery action in a separately identified diagnostic. Code failures
offer repair/execution rather than a risk acceptance that could not succeed. Permission errors,
missing original content and storage timeouts retain their original identity and details.

## Replay and qualification

Accepted decision, publication, submission and approval replay needs the original shared receipts,
not the old private draft, checkout, executor or a new timestamp. Submission acknowledgement now
also works after its phase has been approved, without creating or authorizing another write.

Mac qualification uses an actual stopped local service and instrumented Node tests, genuine
assertion failures and repairs, independent reviewer identities, all three storage implementations,
expiry and renewal, revocation, source changes, interrupted acknowledgements and original read
errors. The offline installed consumer records the human decision, publishes the actual failed
execution, submits and independently approves with an empty PATH and strict NodeNext declarations.
No Windows CI, provider call, production Story, installation mutation or main merge is included.

This delivery passes 307 distinct affected Mac checks across 26 test files, with no skips or
cancellations. They include 108 architecture checks, native CLI/SDK compatibility, mixed compiler
and failed-test observations, the decision-batch path and the original 34-check installed qualifier.
That original qualifier ran alone in 74 seconds, within its unchanged 120-second parent and
60-second child limits. Source validation passes 4,365 checks; VS Code types, the unchanged
2,011-site Git audit and all 13 original bundle limits pass. Gateway remains at 852/852 modules.
One pre-existing recovery test still treated the already shipped mixed-command check-plan v4 as
a future version; it now asserts v4's original meaning and refuses v5. No reader range was raised.

Code/environment-sensitive reuse, baseline/cohort selection, witness-exception ceremonies, the
remaining risk/application-review owners and final combined journeys remain on the completion
ledger. This delivery must not be represented as completing either phase.
