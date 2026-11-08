# Routed human approvals over shared records

The explicit namespace approval host now applies the pinned decision after a real human approval
threshold. The SDK still coordinates registered `phase.approve`; the kernel selects and plans
the transition; SDA retains the vote, proposal, evidence and original transaction receipt.
No private draft, Git checkout, model provider or readiness flag participates in approval.

## Immutable meaning

Sequential approvals continue writing `sflow-namespace-phase-approval-vote/v1` under
`sflow-primary-document-approval/v1`. Actual earlier v1 packets and their receipt outcomes are
captured and remain byte-identical. The schema owner reads both versions without restamping old
history. The artifact-set and phase vote-binding formats remain v1.

An approval after a pinned decision writes `sflow-namespace-phase-approval-vote/v2` under
`sflow-primary-document-approval/v2`. Its routing member binds the decision ID, the interpreter's
structured outcome and, when waiting for a person, the exact pending-question key. A vote below
threshold has no routing outcome. The source is the real v2 submitted input packet, including
proved earlier sources for reused inputs.

The [human-choice follow-up](ENGINE-SDK-NAMESPACE-ROUTING-CHOICES.md) versions the nested routing
contract separately: new v2 routing records bind the question to its actual generation, while
original v1 routing records retain their payload-derived keys and immutable bytes.

Before counting an active v2 vote, the shared reader recomputes the original human quorum and
pinned routing outcome. A v1 vote cannot stand in for routed evidence. Unknown future schemas,
changed outcomes and malformed receipt inventories remain explicit errors.

## Branches, rework and waiting

The kernel plans on detached JSON, so a malformed range cannot partially change the caller's
snapshot. The conditional writer accepts only the final verified proposal.

- A branch starts the pinned target or ends the Story. Skipped phases gain no approvals.
- A loop records its actual round and change request, invalidates affected approvals and decisions,
  and reopens its range. Existing generations and immutable submissions remain retained.
- The next author explicitly rebinds the preserved draft through the returned rebase operation,
  writes actual successor content and republishes. Approval of the repaired target resolves its
  change request; original vote receipts remain available after later completion.
- An ask decision or exhausted automatic loop leaves an approved current phase and an unanswered
  question. No passing result, human answer or additional automatic round is invented.

Generation readiness uses the retained successor publication's logical generation for versioned
publication bindings. It therefore works when an application clock returns equal or earlier wall
times. Legacy records without those bindings keep their existing timestamp compatibility rule.
This is a readiness rule; publication bytes, permissions and final authority still require their
actual owners and checks.

## Original receipts across rework

V2 proposals append typed receipt links. Those links select evidence; they cannot authorize a
vote. Acknowledgement verifies the original prepared operation and committed receipt, decodes its
immutable pre-transition state, checks exact submission and artifact evidence, recomputes quorum,
and reconstructs the complete expected post-transition workflow. The retained proposal must match
that reconstruction. A changed live receipt pointer cannot replace the accepted vote.

This verification uses the original basis even if the phase was reopened, its current inputs were
cleared, a successor was published or the Story subsequently completed. It returns that vote's
original revision, threshold and next phase. It does not claim the live Story is still at that
point; callers read current state before choosing a new action.

The original authenticated human may acknowledge without fresh approval permission or a new clock
sample. The recorded agent stays on the receipt. A new vote still needs fresh permission, exact
confirmation, pinned membership, independent/self-approval policy and the current conditional
basis. A revoked prepared vote remains retained until legitimate permission is restored.

## Remaining execution gates

These are reviewed-document workflows. Actual code/test execution, source reviews, visual
witnesses, presence, automatic dispositions and other production policies still need their real
owners. [Human route-choice context and recording](ENGINE-SDK-NAMESPACE-ROUTING-CHOICES.md) now have
a separate runtime owner; reading an unanswered question is not a completed workflow. New nested
v2 routing records bind question identity to generation while original v1 routing bytes and keys
remain readable. Existing-project migration must also verify
archived receipts across authority-epoch cutover, beyond the existing same-epoch fencing support.
Phases 5, 7, 8 and 9 remain open with their complete scope.

## Mac qualification

On macOS 26.7.2 / Node 26.12.0, 225 distinct checks across 19 affected files passed in their final
runs, with no failures, cancellations or skips. Actual filesystem, SQLite and application-backed
journeys cover independent routed approval, reused-input provenance, loop rework, successor
publication, final completion and old-receipt acknowledgement. The limit test retains its real
unanswered question. Permission restoration, multi-authority partial votes, lost acknowledgement,
altered receipt pointers, missing phase names and malformed inventories are exercised separately.

The original sequential approvals and captured v1 bytes passed, along with native CLI approval
parity, unchanged lifecycle/interpreter goldens, preparation/publication checks and architecture
guards. The installed archive passed 18 checks, including actual independent routed approval and
receipt replay in separate empty-PATH processes. The initial four loop failures exposed equal-
clock readiness; the causal-generation rule fixed those paths without changing the legacy
unbound timestamp case. Source validation passed 3,834 checks across 191 skills; VS Code
typechecking and the existing 2,011-site Git ownership audit passed.

All 13 bundle budgets passed with unchanged limits: gateway 851 modules / 6,860,324 bytes and
extension 152 modules / 1,290,786 bytes. The SDK preview has 50 registered operations, 115 owned
modules and 1,207,870 runtime bytes. These local checks establish this document-routing slice,
not complete application/test execution, cross-epoch migration or the remaining milestones.
