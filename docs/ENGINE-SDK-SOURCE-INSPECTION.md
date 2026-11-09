# Portable generation source inspection

The explicit namespace Engine exposes `engine.run('phase.source.inspect', inputs)` for a
device-local code generation. It compares that generation's accepted source baseline with actual
SGOS observations. It does not write source, retain application file bodies, publish, run tests or
record approval. Installed Git lifecycle and authority are unchanged.

## Boundaries

- The kernel owns source-path classification, protected-path and test-only boundary rules, exact
  snapshot comparison and the versioned inspection manifest.
- The Engine owns query admission and final binding checks. Its separate read admission permits
  an authenticated reader without making that reader the phase author.
- SDA supplies accepted source-selection receipts, immutable snapshots and the private generation.
- SGOS supplies fresh source snapshots for every selected repository. Physical paths and actual
  file access stay in the explicit source unit.
- The host binds storage, identities and sources. No repository discovery, Git history scan or
  command rendering occurs in the inspection owner.

Existing source-boundary, configuration-path, supporting-change and application-path imports
remain compatibility exports of the shared native string-policy binding. Production consumers
import that binding directly. Configuration retains its build, runtime, lockfile or CI role; it
does not satisfy a product-source requirement.

## Query and recovery

Inputs are optional `workId`, `phaseId` and `maximumEntries` (default 200, range 0–1024). The
entry preview also has a 256 KiB ceiling. All selected files and all protected/source-boundary
findings are evaluated before preview truncation. The manifest reports total changes, role
counts and a digest of the full per-repository comparison.

A missing draft returns `missing-draft` and the registered preparation action. A changed canonical
basis returns `stale-draft` with the exact reviewed private revision/body digest for rebinding.
An artifact-only draft returns `not-code-generation`. A valid comparison returns `inspected`;
that status never means publication is ready. A missing working store or source unit retains its
explicit missing-port diagnosis. Real storage, permission, source I/O and timeout errors propagate.

The reader independently verifies the accepted source-selection receipt and the generation's
matching repository set. It captures each current source, compares it with the retained baseline,
captures every repository again, and finally checks the canonical head, authority, private draft
and current read permission. Drift returns an error while preserving the existing draft.

Source-unit v1 observes canonical paths, hashes, sizes and executable modes. It does not observe
Git tracking, rename provenance or filesystem case sensitivity. The query explicitly reports
additions and deletions rather than inventing renames. Role inference uses canonical case-sensitive
paths unless the immutable policy explicitly pins case-insensitive comparison; protected-path
findings conservatively include case variants. Neither projection grants
edit permission or replaces a repository's final source-write admission.

## Compatibility and remaining milestones

The compatibility oracle contains 1,563 native outcomes and 31 original rule-body fingerprints,
captured before this extraction. Focused tests exercise real source trees, three namespace record
backends, multi-repository selection, protected/test-only findings, read-only access and drift.
POSIX/Win32 string-grammar checks on this Mac are not native Windows qualification.

The registry grows from 52 to 53 operations; no previous operation, stored record or CLI result
changes version or shape. The optional installed SDK exports a dedicated source-inspection host
as well as the single namespace Engine composition.

This is a prerequisite to application-code delivery. Accepted source-content retention, complete
claim/test/constitution and artifact-set policy integration, full cross-agent application Story
execution, existing-project migration and final distribution/performance qualification remain
open. Phases 5, 7, 8 and 9 are not complete.

## Mac qualification

The final affected regression run passed all 435 tests across 21 files, including the two slower
CLI cases, with no failures, cancellations or skips. All 66 architecture checks and all 25
installed-archive checks passed. The archive exercises an actual custom code phase and reopens
its inspection in a separate process with an empty `PATH`.

Source validation passed 3,908 checks across 191 skills. VS Code typechecking and the unchanged
2,011-site process/Git ownership audit passed. All 13 bundle budgets passed without raising a
ceiling: gateway 852 modules, extension 152, Help 135, support 111 and prewarm 23. The gateway
contains 6,867,598 JavaScript bytes. The optional SDK builds 53 operations from 159 modules and
emits 1,568,443 JavaScript bytes. These are artifact measurements, not latency gains.

Qualification used isolated local stores on macOS with Node 26.12.0. No Windows, hosted CI,
provider, real Story, installed product, migration, push or merge was involved.
