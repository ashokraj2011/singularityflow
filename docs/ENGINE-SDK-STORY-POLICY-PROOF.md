# Original policy proof for namespace Stories

Namespace business operations share a read-only Story observer. It verifies the original creation
intent, immutable genesis, creation manifest and both accepted transaction receipts before treating
a lifecycle snapshot as policy. Retained state and source bytes must match their original digests;
configuration approval and its exact immutable version remain independently verified.

The v1 Story creation codec is shared with the existing writer. Logical keys, transaction bytes,
digests, record formats and receipts retain their previous meanings. A captured creation from
`9d486f4d3` qualifies that compatibility, including the distinct historical read-head hash encoding.
Existing imports of the Story genesis and read-head key helpers continue to work.

## Persisted policy, without recompilation

The pure kernel compares the active policy with the actual original lifecycle state. It does not
run today's workflow normalizer or reconstruct a former Story. Creator enrollment authorized by
the original configuration remains part of that retained policy. Later approvals of configuration
do not replace an active Story's original pin.

The comparison covers the resolved workflow, reviewer membership, routing and policy declarations,
Story selection and creator, phase membership/order, and each phase's static approval, generation,
agent, artifact, input, source, test and execution contracts. Lifecycle generation, status,
authorship, evidence, decisions, progress and actual source observations remain the responsibility
of their existing owners. A future amendment or authority migration needs its verified versioned
operation; editing a copied policy in mutable state does not establish that authority.

## One proof owner across operations

Preparation, private draft reads/writes, source binding, publication, submission, human approval,
human routing choices and canonical phase/document/question reads use this observer. Historical
states decoded for receipt acknowledgement receive the same policy comparison. A snapshot reused
within one admission still receives a new comparison; caching its immutable proof does not make
the caller's mutable workflow trusted.

Ordinary Story title and display-label updates remain editable; they do not change policy.

The conditional writer retains ownership of its actual captured snapshot. Business admission
checks that snapshot without substituting another observer's capture or weakening its capability
check. After proof traversal, canonical reads recheck head and authority revisions. Actual writes
retain the writer's existing fresh checks and conditional transaction.

If an identical operation is accepted during preparation or final validation, coordination inspects
that exact operation's real receipt instead of repeating admission or inventing another timestamp. A moved
context without that acceptance remains a conflict. Permission, identity, corruption and timeout
failures retain their original errors.

Missing records, unsupported schemas, different authority bindings, malformed receipts and changed
policy remain distinct failures. Real permission and timeout exceptions retain their original
objects and details. Proof inspection cannot change state, grant a human identity, acquire a new
timestamp, upload a local attachment or repair a missing record. Same-epoch fencing still permits
acknowledgement of genuine retained decisions while refusing new writes.

## Qualification

Mac qualification on Node 26.12.0 passed 480 checks across 24 files, with no failures,
cancellations or skips. The final combined run passed 461 cases; the separately installed SDK
passed its 19 cases within the existing timeout. Coverage includes all three metadata backends,
the captured original v1 creation, shipped-workflow start admission and canonical source reads,
active/historical policy drift, real error identity, independent human approval, routing/rework,
and actual concurrent acceptance during both preparation and final validation. The conditional
storage contract remains independently qualified without requiring production genesis records.

Source validation passed 3,855 checks across 191 skills. VS Code typechecking, the unchanged
2,011-site Git ownership audit and all 13 production bundle budgets passed. Gateway and extension
sizes remain 851 modules / 6,860,814 bytes and 152 modules / 1,291,045 bytes respectively. The
SDK preview builds 51 operations over 125 modules and 1,277,089 bytes. No budget ceiling changed.
No Windows, hosted CI, live model/provider, real Story/workspace, product installation, authority
cutover, merge or push was involved.

## Compatibility and remaining milestones

The low-level lifecycle observer/committer remains a storage contract. Its conformance fixtures
can exercise conditional writes without pretending to have enrolled and approved a production
Story. Read-only projection hosts also retain their existing format and capabilities. This
business-proof layer is selected only by explicit namespace hosts; installed Git behavior and
authority remain unchanged.

This closes the immutable-origin policy projection gap for the implemented namespace profile.
Remaining native policy/query extraction, additional production policy owners, application/test
execution and the complete cross-agent application Story remain Phases 5 and 7. Verified existing-
project migration, archival cross-epoch receipts, obsolete-access removal and final distribution,
surface and performance qualification remain Phases 8 and 9. No real project is migrated by this
delivery.
