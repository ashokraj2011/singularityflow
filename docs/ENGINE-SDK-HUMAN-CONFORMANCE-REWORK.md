# Human conformance decisions and reviewer returns

This extends the opt-in namespace Engine with explicit human decisions for retained conformance
gaps and reviewer-requested Code rework. It does not select installed project authority or change
native Git commands. Operations enter the existing SDK registry; no surface implements another
decision or transition path.

## Operations and authority

| Operation | Binding | Who may perform it |
|---|---|---|
| `conformance.context` | Exact published generation, policy, report and configuration | Principal with the read permission |
| `conformance.decide` | Context digest, clause and original Code owner | Authenticated human in that owner's pinned approval group, with the operation permission |
| `phase.reject` | Submitted review packet, configured return target and reason | Authenticated current-phase reviewer with the rejection permission |

The trusted access port grants mutation permissions after a real human confirms the action.
Configured Git identity, model-generated text and a copied receipt are not substitutes for that
confirmation. Author submission still requires its pinned phase agent. Reviewer decisions do not
select that author, publish code or count as phase approval.

The context lists each gap's original owners and groups, existing decision, human identity, reason,
time, expiry and available choices. Active decisions offer no duplicate choice. An expired risk
offers a new decision. A model does not invent an owner, reason, date or disposition.

```js
const context = await engine.run('conformance.context', { workId, phaseId });
const gap = context.gaps[0];
const owner = gap.owners[0];
// humanReview comes from the host's actual human confirmation.
await engine.run('conformance.decide', {
  workId,
  phaseId,
  expected: context.expected,
  clauseId: gap.clauseId,
  ownerPhase: owner.phase,
  outcome: 'accept-risk',
  expires: humanReview.expiresAt,
  reason: humanReview.reason
});
```

`dismiss` requires a reason and no expiry. Accepted risks need an expiry after the decision time
and within 90 days. The shared pure rule preserves native upstream reason and expiry semantics.
Every owner of a gap must have its own valid disposition. A decision for another report, clause,
owner, configuration or Code generation cannot clear it. Partial verdicts remain partial, and a
decision never certifies an unrecorded test run or visual witness.

After the phase author submits, its reviewer may inspect the exact packet and return it:

```js
const { manifest } = await reviewerEngine.run('phase.review', { workId, phaseId });
await reviewerEngine.run('phase.reject', {
  workId,
  phaseId,
  target: codeOwnerPhase,
  confirm: manifest.reviewBinding.packetSha256,
  reason: humanReview.reason
});
```

The target must be allowed by the current phase's pinned rejection policy. The return reopens
the target and subsequent phases through the shared lifecycle rule and retains prior evidence.
Code rework still needs the same repository selection and actual predecessor delivery. Its
preparation preserves the original Story baseline; publication needs a fresh retained test run.

## Durable proof and recovery

`sflow-namespace-human-decision/v1` stores normalized intent, actor, authority group, original
lifecycle/configuration basis, source binding, timestamp and outcome. One conditional lifecycle
transaction retains the immutable evidence, resulting state and receipt. Retries acknowledge the
original operation. Concurrent intents cannot overwrite a moved head or create two active decisions
for the same gap. Risk renewal appends a new record after expiry and preserves the previous one.

Readers reconstruct the original source, authority and whole proposed transition from the accepted
receipt. They do not trust a copied change request or a state flag. Approval includes the actual
decision evidence, checks expiry again before committing, and replays historical approvals at their
original time. A risk expiring later does not rewrite an earlier approval or make an old receipt
renew the risk. Real content, permission, conflict and timeout errors retain their identity.

Code v1 retains initial-delivery meaning. V2 retains configured human-approved loops. A reviewer
return uses Code v3 and a distinct history proof binding its rejection receipt and original packet.
Old reports, source archives and execution records remain readable after later generations and
after the original checkout is removed.

## Ownership and limits

Kernel modules own disposition validation and lifecycle rules. A shared namespace mutation adapter
coordinates access, immutable retention and conditional acceptance. Separate read-only owners verify
conformance decisions and reviewer returns. SDA owns persistence; SGOS owns actual test execution.
Host adapters own questions, wording and command rendering.

This supports source-backed Code and the previously qualified artifact/conformance profile. It does
not implement all native upstream operations, arbitrary source-selection changes, unchanged Code
revalidation, returns into a phase that has never published, surgical member/clause regeneration, Code returns through
an ask-choice, or every advanced acceptance/test-recovery owner. Unsupported owners remain explicit
requirements. The current phase's rejection policy is preserved, not broadened automatically.

Mac qualification uses isolated projects and identities, actual Node tests, all three storage
backends for return recovery, native upstream regressions, and offline installed SDK checkpoints.
The original installed-package qualifier retains its 120-second parent and 60-second child bounds.
The new durable checkpoints use the same bounds. Complete source-backed filesystem journeys took
about 11–12 minutes under concurrent local qualification load. This is correctness evidence;
proof-traversal performance, wider Phase 5/7 coverage, Phase 8 cutover and Phase 9 release remain
open. No Windows CI, live model, real Story or installation mutation is part of this slice.

The aggregate installed-package gate is currently unqualified on this Mac. The unchanged qualifier
hit its 120-second parent / 60-second child limits for this feature snapshot (about 149 seconds
including cancellation cleanup); a separately archived, unchanged `0491270f9` baseline also missed
the parent limit (about 138 seconds including cleanup). Earlier qualification of that baseline
passed near 118 seconds. These are deadline failures, not grounds to increase a test limit or claim
the complete package qualified. Native and namespace functional cases remain separate evidence.

The operation-checkpoint qualifier passed all 44 installed tests across conformance, configured
loops, reviewer returns and partial-verdict decisions, with no skips or cancellations. Each action
runs in a fresh process from an offline-packed SDK; the final checks remove the checkout and use
shared evidence only. It took about 614 seconds overall and its longest checkpoint took about
38 seconds. Splitting publication, submission, approval and replay preserves the existing bounds
and qualifies durable resumption; it does not clear the separate aggregate performance gate.

A separate offline-packed NodeNext check also passes for the new operation inputs, including
rejection of identity overrides, invalid digest types and unregistered approval vocabulary. New
operation families initialize on demand; ordinary approvals avoid extra historical-basis reads
and decision-time checks when no conformance disposition is required.

Final Mac checks passed source validation, schema contracts, 84 architecture-boundary cases,
VS Code typechecking, the Git ownership audit and all 13 existing bundle budgets. SDK protocol
checks reject malformed Story/phase contexts before reading, while preserving original missing
publication and permission errors. These checks do not change the aggregate timing limitation above.
