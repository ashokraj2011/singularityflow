# Phase review query and manifest

`engine.run('phase.review', {workId?, phaseId?})` inspects the explicitly bound checkout. An omitted
phase selects its current phase. Historical phases remain inspectable. An explicit Work ID must
match the checkout; a query never attaches a different Story, switches branches, creates a
generation or grants authoring permission.

The registered operation returns an immutable `sflow-engine/v1` receipt with `status: inspected`
and a `sflow-phase-review-manifest/v1` manifest. It contains no prompt, artifact body, command string,
provider selection or human consent. A trusted `phaseReview` port supplies `load` and `read`; the
pure kernel selects the phase, validates native facts and orders the read plan.

## Manifest

| Field | Meaning |
|---|---|
| `workId`, `phase`, `generation`, `phaseStatus` | The captured Story and phase selection |
| `observedRevision` | An opaque native observation token, not a new lifecycle write |
| `budgets` | Existing document preview, source preview and source full-document limits |
| `items` | Primary document first, other artifacts next, then agent briefs; deterministic order within each group |
| `integrity` | `matched`, `changed`, `unavailable` or `unbound` byte bindings |
| `reviewBinding` | Exact submitted packet/source observation, only when all retained members match |
| `humanReviewRecorded`, `approvalRecorded` | Always false for this read |

Each item names an opaque, engine-binding-scoped `phase-document` reference, its role, artifact
kind, media type and generation. Expected SHA-256/byte length come from retained records; observed
SHA-256/byte length and binary status come from the canonical byte reader. Briefs may have a retained
hash without a retained byte length. A draft has observed bytes but no retained binding. A changed
primary document cannot acquire the immutable submission's identity merely because discovery
hashed its current contents. Hashes verify byte identity; they do not verify meaning, tests or a
person's visual review.

The selector captures every retained artifact and submitted brief binding before awaiting the
reader. A returned list must contain every captured member and preserve its expected hash/length;
an omitted member or a replacement expected hash is a port-contract failure. Source keys used for
that internal join are not exposed as storage paths in the public manifest. Submitted brief-list
selection now has one pure kernel owner, shared with the installed document registry, retaining
the original strict generation comparison.

Missing registered artifacts and briefs remain in the SDK inventory even when discovery omitted
their local files. Their native error name, code, message, details and bounded cause chain remain
visible. Filesystem causes retain their native code, errno, syscall and path when present; failure
to stat a file does not silently become absence. Existing legacy messages remain unchanged. Overall
native read failures are thrown with their original identity and recovery details, without retry.

An unavailable or changed member suppresses the SDK review binding. Empty or draft-only inventories
are unbound. Truncated UI previews do not change a retained file's byte hash or claim that a person
read its full body. Binary byte verification does not record visual acceptance.

References are opaque within the selected engine/project binding; they are not globally unique
storage addresses or laptop paths. The registered [document body query](ENGINE-SDK-DOCUMENT-READ.md)
resolves them through the same native retained inventory and canonical reader. Later namespace/backend
migration must preserve that scope and reference-to-retained-record mapping. These queries do not
implement the authoring context manifest or a storage-authority cutover.

## Native and host ownership

The Git query composition is narrow and lazy. The normal Node API routes this registry port to
`git-query.mjs`, avoiding import of the publication composition and the legacy CLI dispatcher.
The full native composition can provide the same port, with identical semantic results.

`native-phase-review.mjs` owns one request-local catalog and canonical document read pass. Its
headless inspector avoids optional legacy approval advisories, continuation prose, step-sheet
rendering and attribution labels. Its existing `phaseReview` function still assembles the legacy
display for CLI callers. The old command helper is a compatibility re-export of that function.
This legacy assembly remains explicit presentation debt; the pure SDK never returns it.

`phase show` parses host flags, invokes the registered query, and renders the native composition's
private legacy view. It retains existing text, full JSON, compact agent JSON and opt-in artifact
display. Only its interactive text path records that a terminal showed a review. A headless SDK
read or JSON request never records a terminal review or a selection receipt. Approval continues
to perform its existing fresh packet, identity, presence and lifecycle checks.

The query's semantic receipt may be stricter than legacy display metadata when files are missing
or locally edited. The legacy display remains a compatibility projection, not the definition of
SDK integrity or approval readiness. Registered query parity tests compare its actual SDK receipt
and the legacy document identities; they do not relabel a display as a human approval.

All existing Git/configuration authorities and record/hash versions remain installed. This is one
Phase 5 query extraction. Phase entry, authoring-context manifests, other reads and admission
helpers, alternate backends and final removal of legacy presentation coupling remain in the
migration plan.
