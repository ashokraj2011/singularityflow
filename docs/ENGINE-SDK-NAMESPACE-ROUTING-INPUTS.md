# Immutable inputs for portable workflow routing

The explicit namespace submission host records decision inputs through registered `phase.submit`.
The kernel owns value normalization and which earlier approved decision supplies a reused input.
The SDA host verifies immutable packets and real human-vote evidence. The SDK coordinates the same
submission stages; there is no new command path, Git discovery or caller-supplied readiness flag.

```js
const submitted = await engine.run('phase.submit', {
  phaseId: 'intake',
  decisionValues: { channel: 'Web', confidence: 75 }
});
```

These names and values must be declared by the pinned workflow. Existing choice casing, bounded
numeric normalization, missing-input and unknown-input errors come from the shared decision
compiler. Recording values does not change the pinned definition or authorize a human decision.

## Two immutable packet versions

A phase without a following decision keeps `sflow-namespace-phase-review-packet/v1` and
`sflow-primary-document-submission/v1`. Captured packets from the previous writer retain their
exact canonical bytes and hashes. V1 does not acquire a `routing: null` member.

A phase with a following decision writes `sflow-namespace-phase-review-packet/v2` under
`sflow-primary-document-submission/v2`. Its additional `routing` member binds:

- The pinned decision ID.
- The normalized own-input record, including its original author and timestamp, when inputs exist.
- Each reused source decision, phase, generation, selected values and immutable submission-packet
  content reference.

The format and readable versions have one shared schema owner. Unknown future packet, routing or
input-record schemas remain explicit unsupported-record errors. No reader upgrades accepted
history, infers new routing values for a v1 packet or substitutes a storage revision for a Git
commit.

## Provenance and authority

Reused values must originate from an earlier approved phase in the pinned phase order. Its
canonical input record must match the exact retained source packet. The shared proof reader also
reads the real approval votes, their publication/artifact bindings and human authority, and
recomputes the approval threshold. Merely setting an earlier phase's status to `approved` cannot
make its inputs reusable.

Source-packet reads coalesce only within an invocation; later reads use fresh proof. Real storage
deadlines, permission failures and missing-content details pass through unchanged. Invalid values,
altered provenance, duplicate source records and incomplete approvals cannot acquire a review
binding or become accepted submission evidence.

Normalization occurs before submission identity selection. Equivalent choice/numeric forms resume
one prepared candidate with its original timestamp. Revoked permission leaves that candidate
retained and requires fresh permission before acceptance. An already accepted submission returns
its original receipt and inputs, even if a retry supplies different values; the existing ignored-
values notice and retained-result meaning are unchanged.

## Deliberate execution boundary

An `ask` decision has no invented human answer: its submitted routing record can have no own
inputs, and submission leaves the phase awaiting approval. The
[routed approval owner](ENGINE-SDK-NAMESPACE-ROUTED-APPROVAL.md) applies pinned branches and bounded
rework only after the actual human threshold. It preserves original vote receipts across later
generations and terminal completion. Ask and exhausted-loop outcomes retain an unanswered question;
recording the human's route choice uses the separate
[question context and writer](ENGINE-SDK-NAMESPACE-ROUTING-CHOICES.md).

Reviewers receive [exact issued resource references](ENGINE-SDK-REVIEW-RESOURCES.md) to the routing
packet and its retained sources. Complete production execution policy, existing-project migration,
writer fencing, cleanup and distribution/performance qualification retain their full Phase 5–9
scope.

## Local qualification of the initial input-packet slice

Disposable Mac fixtures exercise actual publication/submission on filesystem, SQLite and
application stores, accepted and prepared retries, schema/metadata corruption and original I/O
errors. Real registered human approval supplies the source-vote proof test; a separate adversarial
projection verifies that an unbacked approved flag is refused and never stored. The installed SDK
archive submits and reopens v2 in separate empty-PATH processes with no private-draft dependency.
Native compiler goldens and decision-free CLI/SDK outputs remain compatibility checks.

On macOS 26.7.2 / Node 26.12.0, the final affected set contains 172 distinct checks across 14
files, with no unresolved failures, cancellations or skips. The final isolated routing/provenance
set passed 15 checks, and the installed archive passed all 17 package checks. An invalid one-route
adversarial fixture was corrected to follow the existing two-route minimum. A loaded parallel
package run exceeded its existing parent deadline; isolated qualification passed within that
unchanged deadline.

Source validation passed 3,826 checks across 191 skills. VS Code declarations and the Git ownership
audit passed, with 2,011 existing production process/Git sites and no new sites. All 13 bundle
budgets passed with unchanged limits: gateway 851 modules / 6,857,293 bytes and extension 152 modules
/ 1,290,541 bytes. The SDK preview retains 49 operations and contains 114 owned modules / 1,172,026
runtime bytes. These artifact counts do not establish complete application-Story performance or
finish any remaining migration milestone.
