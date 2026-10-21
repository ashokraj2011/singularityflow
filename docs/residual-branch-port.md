# Residual branch reconciliation

This port starts from main `9160a763`, not either older branch. Source tips reviewed:
`64ba9890` (native release-hardening follow-ups) and `4c5e29a8` (optimization).
It is a selective port, not a merge of historical configuration, generated files or release claims.

## Retained from newer main

- State-index Story discovery, scoped Git snapshots and final fresh mutation checks.
- Local-only attachments, Auto candidate isolation and exact test-execution provenance.
- Managed runtime/distribution, automatic installation-receipt upgrade and recovery storage.
- Environment-packet cleanup workers, not the older IPC worker lifecycle.
- Current CLI/VS Code bundle ceilings and strict release qualification, including skip policy.

## Ported residuals

- Admit installer recovery before pulling its source; the Windows wrapper delegates that update.
  Interrupted recovery still names its retained journal, checkout and exact command.
- Hide stale/error approval actions and repaint availability on an unchanged fresh receipt.
- Verify submitted/approved checkout representations without rewriting immutable hashes.
  LF/CRLF equivalence never permits content, whitespace, mixed-ending, encoding or symlink changes.
  Bind sidecar provenance after managed metadata reaches its final generation bytes.
- Bounded Windows sharing-error retries replace the same complete atomic temporary file.
  Never remove an existing destination or replace active recovery with a fresh installation.
- ESM-URL portability in qualification/UI fixtures, and process quiescence/scratch retention in
  release diagnostics. Diagnostic continuation remains a failing gate.
- Native installer fixtures use the MSYS interpreter, not Git's PATH/argv-rewriting launcher.
  Recovery commands remain opaque at the native helper boundary, and partial-stream failure
  injection still exercises the pinned immutable installer path.
- UI/cache qualification follows main's Windows per-user cache and native absolute-path rules.
  Private encrypted checkpoint replacement retries transient sharing failures without deleting
  the previous seal. Readers retry a raced unlinked stat but never admit it as a trusted path.
- Content-addressed syntax facts, a dependency graph, bounded discovery/task and quality-command
  pools, corner-case signals, assertion diagnostics and a consolidated remediation projection.

## Verification boundaries

Syntax caches never store test outcomes, approvals, identity or authorization. Memory and optional
common-Git storage are bounded; persistent facts are recomputed before first use. Linked Story
worktrees use common Git storage, not a directory below their `.git` pointer.
Read-only draft checks do not write disk caches.

Corner-case diagnostics are advisory by default. New approved definitions may explicitly pin
`codeDelivery.cornerCaseObligations` and/or `codeDelivery.assertionAdequacy` to
`off`, `advisory` or `enforce`; omissions leave existing pinned policy unchanged.
Explicit enforcement refuses unavailable or over-budget inspection rather than silently passing.
The static matrix requires related source imports and symbol calls; it is not runtime coverage.
Scaffolds remain skipped candidates requiring real contract-specific assertions, never generated
passing evidence. Human decisions and native structured execution remain separately governed.

The bounded quality-runner API preserves original native result objects and opaque execution
receipts. Discovery overlaps independent reads. Governed quality execution keeps main's sequencing
and isolation; the older branch's broad publication rewrite is not restored over newer Auto,
report-capture, risk and mutation-binding fixes.

The dependency graph is an advisory/helper projection, not authority to omit required tests.
Remediation summaries list locations without rendering source or scaffold bodies.

## Qualification

Qualification uses native macOS and Windows hosts on Node 22 and 26, not a simulated platform.
Selected successful cohorts cover 133 verification/cache/transport/provenance tests, 61 installer
and release-harness tests, nine cache-authority tests, 45 UI/storage tests, 36 worktree-drop tests
and three approval-host tests. Each selected cohort completes without failures or skips.
The earlier broader publication cohort also passes its 142 generation, review, lineage and
delivery-evidence tests on both operating systems.

Native records: `39606050998` (broader exploratory qualification), `39612327702` (successful
diagnostic/cache/drop/approval cohorts), and `39613590501` (corrected installer/UI qualification).
Exploratory failures were retained and the affected suites re-run after corrections; a successful
cohort in a mixed-result run is not represented as a successful whole run.
All 13 VS Code bundle ceilings remain unchanged, CLI bundle parity tests pass, typechecking
passes, and `npm run check` passes 2963 checks.

This is not a 1.0 release certificate. The broader Windows workspace cohort still contains three
existing platform-skipped POSIX-only cases; these were not waived, reclassified or reported as
passing. Strict full-release qualification, genuine human approvals and complete native Copilot
Story qualification remain separate requirements.
