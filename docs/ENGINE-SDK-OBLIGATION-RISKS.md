# Exact obligation risks and final evidence

`decision.risk` now has a namespace owner. It reconstructs the actual retained evidence, identifies
the original obligation and its approval groups, and records an authenticated human decision through
the shared conditional mutation coordinator. The namespace request needs an explicit `operationId`.
The native Git operation, native risk records and native JSON remain unchanged.

The new `namespaceObligationRisks` collection uses `sflow-namespace-obligation-risk/v1` and original
accepted decision receipts. It is not an alias for the native `riskDecisions` array. Each decision
binds its exact observation, owning generations and publication references. Renewal appends another
decision; revocation preserves the original. A replacement delivery overtakes the old decision even
when its missing/partial status happens to be unchanged. Lost acknowledgements recover the original
operation without restamping its time or claiming another commit.

The shared rules still restrict risk acceptance to eligible obligations and the terminal transition,
with a bounded reason and expiry. Missing scope decisions, outstanding human reviews, stale evidence,
integrity failures and pending deliveries cannot be accepted as risks. Test publication and human
visual acceptance keep their own required owners. A risk does not turn a failed test into passing
evidence, run a command, approve a phase, or waive the no-waiver recovery agreement. Configured
person-presence requirements remain explicit. Story-wide risk evaluation is a separate required owner;
the present profile covers exact clause obligations.

`story.evidence` is the read context. New namespace risks select evidence-context v2 and evaluation
v2, which additionally checks the original owning-delivery bindings. Ordinary/native v1 evaluations
retain their captured behavior. The decision list offers eligible decisions or original revocations;
its confirmed batch invokes the same registered operation. An existing linked upstream issue retains
one original owner and disposition rather than acquiring a second risk decision.

When a risk-bearing Story's actual human approval would close it, vote v4 (sequential) or v5
(configured end route) retains a separate final-evidence report. The report explicitly evaluates an
**uncommitted human-vote proposal**; it never invents an accepted vote receipt. Approval authority,
quorum, the original submitted packet, all previous accepted evidence and the actual pinned route
are checked before constructing that proposal. The final commit checks current expiry, source
observations, authenticated identity, authority and conditional record revisions again. Original
v1/v2 approvals and v3 forward-amendment projections retain their meanings.

The accepted closing vote authenticates the final report for later views. A view remains read-only;
its current evidence can never be outweighed by an old completion label. Original decisions and
approvals replay using shared storage without a private checkout, executor, provider or new clock.

## Document-only verification

A non-Code inspection now has its own document-review v2 publication profile. It retains actual
approved definitions and plans, the original Story source and the authored inspection document.
Its report states `testsExecuted: false` and `criterionAcceptance: false`. A later evidence evaluation
uses the original human phase approval and exact clause citations; merely publishing the document
does not establish inspection or test acceptance. Existing document-review v1 reports are unchanged.

## Qualification and remaining scope

Mac journeys exercise filesystem, SQLite and application stores, independent configured reviewers,
actual end routes, expiry between preparation and commit, replacement inspection generations,
revocation/renewal, duplicate prevention, decision batches and lost acknowledgements. Genuine content
permission and timeout errors are preserved. An offline installed consumer performs the decision and
closing approval outside the checkout with an empty PATH and native Git/CLI/state imports denied,
then acknowledges the original receipts with a new clock denied. Strict NodeNext checks cover the
new admitted binding values and reject caller approval flags.

This checkpoint passes 311 distinct affected Mac checks across 26 files, with no skips or
cancellations. The original standalone 34-check package qualifier passes in 90.4 seconds within
its unchanged 120/60-second deadlines. Source validation passes 4,373 checks; VS Code types, the
unchanged 2,011-site Git ownership audit and all thirteen original bundle ceilings pass. The gateway
remains 852/852 modules. The vocabulary is still 89 operations: the default native host binds 42
and the namespace host with private working stores binds 81 before optional execution.

The complete Phase 5/7 ledger remains open for approved witness-mapping/renewal ceremonies, Code and
environment-sensitive reuse, risk/recovery combinations, live application review, required external
evidence/execution owners and final combined qualification. This delivery changes neither installed
authority nor the Phase 8/9 migration and cutover gates.
