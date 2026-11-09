# Retained changed-source content

`engine.run('phase.source.retain', { operationId, workId, phaseId })` retains the exact current
contents of changed application files for an actual private code generation. It accepts no
caller-provided file list, passing verdict or readiness flag. Installed Git behavior is unchanged.

## Ownership and contracts

The existing `sflow-source-unit/v1` and source-snapshot v1 contracts keep their shape. An explicit
`sflow-source-content-reader/v1` capability reads bounded ranges of selected files. Its Node
filesystem host shares the original root binding, cancellation and deadline owner. Root changes,
symlinks, size/mode drift, excluded paths and genuine I/O failures remain explicit. A range read
alone does not verify a whole-file hash; the retention owner verifies the complete stream.

The kernel owns source-change comparison, configuration/test/product roles, protected-path
findings, test-only boundaries and the operation/result contracts. Inspection and retention use
the same rules. The Engine coordinates authenticated access, the exact generation and final
bindings. SGOS reads files; SDA stores chunks and conditionally accepts evidence. No shell, Git,
model or application process is launched by retention.

The new namespace source-retention v1 family has separate plan, intent, result, repository,
manifest, index and binding records. Existing lifecycle, publication, check and submission
versions do not change. Acceptance conditions bind the authority, canonical Story revision,
immutable configuration and current draft index. Acceptance never updates the canonical Story
head or grants publication or human approval.

## Actual bytes and proof

Preparation independently proves the accepted repository selection and promotes the exact
private generation-intent bytes as metadata. It records current source snapshots before copying
file contents. Only changed application paths are retained; SFlow-owned documents and uploaded
local attachments are outside that source projection. Configuration keeps its own role.

Files use chunks of at most 1 MiB, further bounded by the supplied reader and content store.
This supports a file larger than a single SDA blob. Each repository has a bounded manifest;
empty files and deletions need no invented content reader. The retained projection preserves
additions, modifications, deletions, modes, roles and observed policy findings. It does not infer
Git tracking or renames. An invalid boundary or protected-path finding remains a fact to resolve;
retention does not approve the edit.

The proof reader verifies actual preparation/result receipts, original lifecycle/configuration
and generation bindings, both source snapshots, deterministic file selection and every retained
chunk. It reconstructs each current file's hash and byte count. Valid metadata and individual
blob hashes cannot establish an incorrect full-file result. Self-hashed but unaccepted records
are insufficient. Real missing blobs and storage errors retain their diagnoses.

Final acceptance revalidates the private draft, current authenticated author and every selected
source repository, including files without changes. A qualified successor author is distinct
from the original generation creator; neither is thereby an independent reviewer.

## Retry, takeover and limits

Failed reads or revocation preserve the authored draft and prepared intent. Restoring permission
or the original selected bytes can resume the same request. A changed draft or intentionally
changed source requires a new operation for that basis; old records are not overwritten.
Concurrent requests converge on the actual accepted receipt. Lost acknowledgements retain their
real error; a retry can acknowledge an accepted result without the original checkout, private
store, content reader, phase agent or another clock call. It still authenticates the original
retaining person. Fencing prevents new acceptance and preserves historical acknowledgements.
Request identity uses the logical namespace and authority; changing a qualified client adapter's
local identifier does not invalidate the genuine shared receipt.

Frozen Story-creation v1 hashes still include their enrolling record/content store IDs. A passive
proof reader can verify those original hashes against the recorded same-epoch authority origin;
it does not gain a fresh lifecycle snapshot or writer basis through an unenrolled adapter. An
authority or epoch change still needs verified migration lineage. Actual origin-read errors and
content-client capacity failures remain their original errors, rather than becoming corruption.

The scope is explicitly `changed-application-paths`. Unchanged files and historical contents of
deleted/modified files are not archived by this operation. The result therefore reports
`baselineContentsRetained: false` and `publicationReadinessInspected: false`. A full repository
restore and independent review of removed bytes need retained baseline content or a qualified
historical source provider. That baseline owner, remaining code/claim/constitution/artifact-set
policies, full application Story execution, migration/cutover and final distribution/performance
qualification remain required. Phases 5, 7, 8 and 9 are not complete.

The optional SDK exposes both the single namespace Engine and a dedicated
`hosts/namespace-source-retention` composition. Bind explicit `sourceReaders` together with the
corresponding source units for a new retention. Shared-only hosts can acknowledge existing
receipts. No CLI or Copilot command is claimed for this SDK-only operation.

## Mac qualification

The source-retention, original Story-policy and frozen-v1 codec suite passed 59 cases. A further
87 path-policy, actual source, preparation and checked-publication cases passed. Architecture
checks passed 67 cases and the installed offline SDK tarball passed 25 checks, including reopening
retained source bytes after removing the original checkout. These batches had no failures,
cancellations or skips. Passive retained-proof inspection is qualified separately from obtaining
a fresh writer-bound snapshot; writer fencing remains enforced.

Source validation passed 3,916 checks across 191 skills. VS Code typechecking, the unchanged
2,011-site Git ownership audit and all 13 unchanged bundle budgets passed. The optional SDK build
contains 54 operations, 164 owned modules and 1,625,510 JavaScript bytes. This qualification is
local to Mac and does not establish full application delivery, existing-project migration or
installed authority cutover.
