# Namespace publication of authored documents

The explicit `hosts/namespace-publication` SDK entry implements registered `phase.publish` over
real device-local drafts and the conditional namespace lifecycle writer. It also exposes the
preparation and read operations supplied by the preparation host. The core registry coordinates
publication. Installed CLI, VS Code and Copilot hosts retain their Git compatibility writer;
this entry does not migrate them.

## Construct and use the host

```js
import {
  createNamespacePublicationEngine,
  NAMESPACE_PUBLICATION_PROFILE
} from '@singularity-flow/engine-sdk/hosts/namespace-publication';

const engine = createNamespacePublicationEngine({
  records, content, localRecords, localContent,
  scope: { projectId }, workId, authority,
  access: applicationPhaseAccess,
  clock: applicationClock,
  sources: explicitlyBoundSourceUnits
});

await engine.run('phase.prepare', { phaseId });
const draft = await engine.run('phase.draft.read', { phaseId });
const saved = await localContent.put({ projectId }, 'local', authoredBytes);
await engine.run('phase.draft.write', {
  operationId: stableWriteOperationId, phaseId,
  expectedRevision: draft.manifest.draft.revision,
  content: saved.reference, reason: authoringReason
});
const publication = await engine.run('phase.publish', {
  phaseId, authored: 'governed-agent', channel: 'copilot-host'
});
```

Shared and machine-local ports remain explicitly bound. The access port supplies authenticated
project, principal, actor, identity, phase agent and permissions. New publication requires
`phase.publish`, the pinned author and fresh authority, configuration, Story revision, resource
and private-draft checks. Operation inputs cannot supply identity or claimed readiness.

## Current policy profile

`NAMESPACE_PUBLICATION_PROFILE` is `sflow-primary-document-publication/v1`. This first portable
writer supports phases whose pinned semantics declare only review responsibility and a primary
artifact, without additional execution or policy requirements. It checks actual authored bytes
using native required-artifact rules: normalized fingerprints, untouched templates, headings,
placeholders and binary size/contracts.

Code delivery, clarification records, specification/coverage analysis, artifact sets, checks,
required assignments, model assurance, signed audits, MCP readiness, external design evidence,
required integrations and repair/risk decisions need their own owners. Their actual pinned
configuration or retained state returns `ENGINE_PORT_UNAVAILABLE` with the required owner names.
Import and usage-file inputs similarly require explicit owners. No success flag substitutes for
these requirements.

This is an incremental Phase 7 delivery. Complete code publication, submission, human review,
approval, phase entry, custom execution and cross-agent Story journeys remain required.

## Retained records and effects

Publication stores exact authored artifact bytes and a separately versioned manifest in shared
`evidence` content. The manifest binds configuration, private draft revision/digest, authenticated
author, agent, authorship, time and actual resource references. Its codec validates those
bindings without inventing a model run, source commit, test execution or approval.

The canonical phase gains one generation, actual artifact metadata and an immutable publication
reference. State and evidence are accepted through the conditional lifecycle committer. A moved
revision, fenced writer or changed draft cannot overwrite concurrent work. Read-only inspection
cannot supply a writer basis. `phase.review` and `document.read` expose the retained artifact.
The private draft remains preserved and reads as stale against the moved canonical basis.

The result's `revision` is the actual namespace receipt's opaque Story revision, not a Git hash.
`effects.committed: true` means shared namespace acceptance; `pushed: false` records no Git push.
No test execution, human review, approval or phase advancement is fabricated.

## Retry and another laptop

The same selected draft and normalized publication inputs resolve to one stable operation
identity. Concurrent calls reconcile to the first candidate and timestamp. A prepared candidate
must pass fresh author, permission, draft and canonical checks before acceptance. A newer edit
cannot be overwritten by an older candidate.

After a lost acknowledgement, retrying the accepted operation returns `status: retained`, its
original generation and revision, and `effects.committed: false`. It does not restamp or
republish. Acknowledging that accepted receipt requires no new author permission. A failure
during final result construction preserves the original error and attaches the actual accepted
receipt as `enginePublication`.

A fresh device can acknowledge the matching current publication through shared state without
recreating the Story or copying private drafts. Machine-local attachment references remain
metadata only; their bytes are not uploaded. Acknowledgement does not require reuploading inputs
already used by an accepted publication. New preparation/publication that needs a local document
requires matching bytes and reports `DOCUMENT_REUPLOAD_REQUIRED` when absent. Complete attachment
reupload coordination remains a separate runtime delivery.

Permission failures and timeouts retain their original errors and details. Missing, malformed
or future-version publication records remain explicit storage errors. Acknowledgement does not
authorize a new operation or bypass an authority cutover.

## Qualification

Focused Mac qualification covers real filesystem, SQLite and application-backed stores,
concurrency, exact bytes, template/content findings, unavailable policy owners, revoked permission,
changed drafts, fencing, lost acknowledgements, malformed manifests and fresh-device receipt
inspection. The packed SDK publishes and reopens its original receipt in independent empty-PATH
Node processes in an isolated consumer outside the checkout.

On macOS with Node 26.12.0, 287 distinct checks across 21 affected test files passed with no
failures, cancellations or skips. This includes 115 focused publication/runtime, architecture
and installed-package checks plus 172 native lifecycle and namespace regression checks. Native
source/CLI/SDK publication, submission, approval, entry, preparation, prepublish, draft inspection
and next-step results retain their compatibility contracts.

Source validation passed 3,809 checks across 191 skills; VS Code typechecking, whitespace
validation and the Git ownership audit passed with no new process sites. All 13 existing bundle
budgets passed without increasing any ceiling. The gateway remains 851 modules / 6,854,091 bytes;
the extension remains 152 modules / 1,289,398 bytes. The SDK preview contains 49 registered
operations and 104 owned modules / 1,091,109 runtime bytes. These measurements do not establish
complete-Story latency or completion of the portable lifecycle milestone.

No Windows, hosted CI, live provider, real Story migration, install, push or merge ran.
