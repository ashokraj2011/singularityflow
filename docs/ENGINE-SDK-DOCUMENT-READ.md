# Document body query

`engine.run('document.read', {reference, workId?, includeDetached?, maximumBytes?})` resolves and
reads one document in the explicitly bound project checkout. This is a registered read operation,
not an authoring, attachment, source-review retention, submission or approval operation. It never
attaches a Story, changes a branch, fetches a URL, restores a missing attachment or creates a
terminal-review receipt.

## Selection and result

`reference` accepts the existing catalog ID, name, alias or registered path, or a structured
reference returned by another engine read:

- A `phase-document` reference contains its opaque ID, canonical Work ID, phase and generation.
  It resolves the same retained identity as `phase.review`. A changed generation requires a new
  reference. Missing retained members remain resolvable to their real native file error.
- A `story-document` reference contains its catalog ID and canonical Work ID. Supporting files,
  links, system documents and package indexes use these references. Detached supporting inputs
  remain hidden unless `includeDetached` is true.

A string reference retains the native lookup precedence: exact ID/alias, normalized document
name, then registered path/basename. An arbitrary path is not permission to read that file. The
native accepted-Story loader still recognizes an explicit `workId`'s existing branch aliases;
structured references always name the canonical Work ID. Neither form changes the checkout.

The immutable `sflow-engine/v1` receipt has `status: read`, an opaque observed revision and a
`sflow-document-read/v1` document. All commit, push, human-review and approval effects are false.

| Document field | Meaning |
|---|---|
| `id`, `reference`, `phase`, `generation` | Captured document identity and phase association |
| `role`, `name`, `kind`, `mimeType` | Domain metadata; no prompt or command rendering |
| `locality` | `machine-local`, `project` or `external` |
| `provenance` | `retained`, `catalog`, current `snapshot`, or `external` reference |
| `expected`, `observed`, `integrity` | Expected and observed byte bindings, separate from meaning or acceptance |
| `budgetBytes` | Applied native preview policy and request budget |
| `content` | Bounded text or extracted Office text; null for a binary without text or an external link |
| `extractionFailure` | The native extractor's unreadable-format reason, when present |
| `uri` | An external link's reference; no remote content is fetched |

`maximumBytes` is an integer from zero to 1,048,576, defaulting to 1,048,576. The native document
preview policy may lower it. Text is cut at a UTF-8 boundary, with explicit byte length and
truncation; the SDK does not append a human-facing truncation message. Extracted Office text
retains its extractor/version and complete extracted-text hash. Original binary bytes and image
base64 are never placed in this result. A binary's verified hash is not visual acceptance.

## Integrity and authority

Before asynchronous catalog resolution, the pure kernel captures the selected phases and their
retained artifact/brief hashes and lengths. Native resolved facts must preserve these bindings.
The native reader enforces the existing regular-file, symlink, Story scope, environment-local,
hash, LFS and line-ending rules. It also checks that its request-local catalog did not change
during the read. A final text/Office body read is compared to its observed hash and length, so
bytes changing after the snapshot cannot inherit its verified identity. Real native errors retain
their original object, code, details, cause and recovery
route, without retries or empty-content substitution.

A scoped phase reference reads retained bytes; a dirty retained file produces the native hash
mismatch error. Legacy string views of the primary draft continue to show its current bytes, as
before. The SDK labels a difference from the retained generation `changed`, and a draft/system
snapshot `unbound`; discovery cannot promote either to a retained binding. Expected hashes only
verify byte identity. This read cannot verify clause coverage, test success or a human review.

Machine-local attachments stay in their existing local store. Public reference metadata contains
no laptop path, storage key or physical Git address; document contents retain their authored text.
Another clone/laptop with only their catalog
gets the original `DOCUMENT_LOCAL_UNAVAILABLE` error and exact restore route. Restoring the
original locally lets the existing Story continue; it does not recreate or republish that Story.

## Ownership and compatibility

The SDK coordinates `documentRead.load`, `resolve` and `read`. Pure `kernel/document-read.mjs`
owns selection, fact validation, byte budgets and result interpretation. The explicit Git port
uses the canonical installed readers, plus the shared native retained-reference inventory also
used by `phase.review`. The opaque reference algorithm and all existing Git authorities,
record/hash formats and authorizations are unchanged.

The Node API routes the operation through the narrow query composition; it does not load the
publication composition, full phase-review assembly or legacy command dispatcher. The full native
composition supplies the same registered port for parity. Each invocation starts outside inherited
advisory/configuration read scopes. No cross-request body or approval cache is introduced.

`documents view` now uses that registered operation. Its host receives the original native view
privately and retains the previous text, JSON, paths, binary/Office display and configured preview
length. The SDK's narrower body budget does not truncate this legacy display. Shared option typo
checks and labels have explicit host owners. Non-view document operations still load the legacy
handler; its old view entry forwards to the same registered path instead of keeping a second
reader. This presentation coupling is temporary, documented compatibility debt.

This is a Phase 5 extraction. Phase entry, authoring-context manifests and remaining admission
coordination are still pending, as are the alternate backends, portable runtime/resume, explicit
authority migration and final removal/distribution/performance milestones.
