# Retained original application sources

`engine.run('source.baseline.retain', { operationId, workId, sourceBindingId })` archives the
original application files from an accepted `source.bind` selection. Invoke it before editing
those files. If edits already exist, supply a qualified source unit/content reader exposing the
original selection. A hash-only observation cannot recover historical bytes that were never
retained. Missing original files are explicit failures; no Story or draft is recreated.

## Ownership and scope

The kernel selects application inventory using the same path and role rules as source delivery.
Configuration retains a separate role. SFlow documents, uploaded local attachments and generated
test results are outside this application inventory. Their contents are not promoted to shared
source storage. Changes confined to those excluded files do not invalidate original application
bytes. The archived inventory covers its explicit application selection. It does not represent
Git history or host configuration.

SGOS supplies bounded actual file reads. Shared chunk copying and read-only reconstruction are
owned once for baseline and changed-source retention. SDA stores immutable content and accepts
versioned baseline intent/result receipts conditionally against the authority, Story head,
configuration and baseline index. Existing source-binding, lifecycle and changed-source v1
records keep their formats and meanings. Canonical Story state is not advanced by archival.

## Proof, retries and takeover

The independent proof reader verifies the original accepted source-binding operation, its
immutable snapshots, the pinned configuration, every selected application member, each retained
chunk and reconstructed whole-file size and hash. A self-hashed metadata document is insufficient.
The final writer repeats live identity/permission, source and lifecycle checks. Revocation, source
drift and genuine I/O failures preserve prepared evidence. Concurrent identical requests retain
the winning original timestamp and converge on the accepted receipt. Reusing an operation ID for
another selection is refused. Writer fencing prevents fresh acceptance.

After acceptance, a shared-only host can acknowledge the original result without the old
checkout, device-local draft, content reader, phase agent or another clock call. It still verifies
the original authenticated person and all retained proof. Its contents include files that are
later unchanged or deleted. Combined with a separately bound changed-source delivery, those
bytes support reviewing original and resulting application files. The historical
`phase.source.retain` result still reports `baselineContentsRetained: false`: that operation does
not itself accept or claim this separate baseline receipt.

## Availability and remaining integration

The optional SDK exposes the operation through `hosts/namespace-engine` and
`hosts/namespace-source-baseline`. New archival needs `source.baseline.retain` permission and
explicit source units/readers. No shell, Git, model, installer, application or test process is
launched. No CLI or Copilot route is claimed for this SDK-only operation.

Application code publication still needs to bind the baseline and current delivery to its full
code, claim, constitution and artifact-set policies. Complete application Story execution,
existing-project migration/cutover and final packaging/performance qualification remain open;
this source owner does not complete Phases 5, 7, 8 or 9.

## Mac qualification

The affected baseline/source/provenance suite passed 99 cases, including actual filesystem,
SQLite and application-backed stores; native source-path compatibility; local-upload exclusion;
multi-repository selection; old/new file reconstruction; malformed and future records; distinct
concurrent clocks; revocation/fencing; and preserved real I/O errors. An accepted non-source
lifecycle operation cannot impersonate source binding for archival or generation inspection.
All 67 architecture checks and 25 installed offline SDK-package checks passed. These suites had
no failures, cancellations or skips. The package reopens genuine original-source receipts after
removing its checkout and retains the older changed-source v1 behavior.

Source validation passed 3,924 checks across 191 skills. Typechecking, the unchanged 2,011-site
Git ownership audit and all 13 unchanged bundle budgets passed. The optional SDK contains 55
registered operations, 170 owned modules and 1,666,465 JavaScript bytes. This local Mac
qualification does not establish existing-project cutover or complete application publication.
