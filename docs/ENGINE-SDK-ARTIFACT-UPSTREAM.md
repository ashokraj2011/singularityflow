# Artifact-derived upstream issues

The namespace `upstream.raise` operation accepts `fromArtifact: true` and an explicit batch
`operationId`. It reads the current authored report or authenticates its original publication.
The shared pure discrepancy parser selects exactly named earlier owners, derives the complete
issue text and deduplicates the original item digests. Unowned items remain visible. Invalid or
overlong items refuse the batch before any issue transaction.

Each issue has its own conditional transaction and accepted receipt. The source uses
`sflow-namespace-upstream-source/v2`, binding the actual producer publication, original report
bytes, item digest, batch request and authenticated actor. Manual source v1 is unchanged.
The authored report is retained only by an authorized mutation. Input documents and images
uploaded on a laptop are not copied into shared storage by this operation.

An interrupted batch resumes its accepted prefix and applies each remaining item once. A retry
with different inputs under the same ID is refused. A changed report cannot authorize a pending
item. Once the batch is accepted, another device can replay its original acknowledgement from
shared evidence without the old private working store, including after the Story closes.
Original permission, missing-content and timeout errors retain their identity and details.

Seven Mac cases pass across filesystem, SQLite and application storage, including actual
cross-device historical replay, a lost shared acknowledgement, source edits during acceptance,
unowned items, duplicate filing and unchanged original read errors. Native Git still uses its
installed authority and transaction owners. Forward amendments, upstream returns and plan
corrections remain separate completion-ledger work.
