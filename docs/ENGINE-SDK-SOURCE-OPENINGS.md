# Reviewed source adoption and rollover

The namespace host implements `phase.begin` source adoption and `phase.rollover` through the
existing operation registry and private preparation owner. Native Git commands, output profiles,
authority and records keep their original meanings. Confirming a source opening is an authoring
action. It is neither independent review nor approval, and runs no model, test, publish or push.

## First generation

An ordinary clean first generation retains its existing opening. Changes made before that
boundary require the pinned `codeDelivery.generationBoundary.dirtyStart` policy to be
`allow-explicit-adoption`. With the default `block` policy, the changes stay preserved and the
author must restore the bound source, begin, and then apply them inside the generation.

When adoption is permitted, `phase.begin` returns `GENERATION_DIRTY_START` with an exact digest
and a bounded review summary. The host displays the comparison. After reviewing it, the author
can pass `adoptExisting: true` and that digest as `confirm`. Source boundary and protected-path
rules still apply. A confirmation cannot expand the approved repository or repair scope.

Drift confined to SFlow-owned report metadata is kept separate from application changes. It can
open a clean application generation under the default policy without requesting source adoption.
The retained v4 context still binds that full snapshot comparison; repository summaries distinguish
application totals from complete snapshot totals. No report file is removed to obtain a clean start.

## Published successors

```js
const preview = await engine.run('phase.rollover', {phaseId});
// Display preview.plan.review and obtain the author's exact confirmed digest.
const result = await engine.run('phase.rollover', {
  phaseId, confirm: confirmedDigest
});
```

The namespace preview uses `sflow-generation-rollover-plan/v2`. Its source comparison starts
from the actual previous Code publication, while cumulative delivery accounting retains the
original Story source binding. The digest includes every selected repository, source delta,
configuration and lifecycle basis, artifact reference, private draft revision and predecessor
proof. Only the first 200 changed paths and violations are displayed; counts and truncation are
explicit and the digest still covers the complete comparison. No source file bodies appear in
the preview. The retained opening has a separate bounded context record.

An accepted retry retains the original intent and reports no new generation or draft effect.
A lost save acknowledgement can therefore be retried without recapturing source, restamping the
opening or duplicating it. A clean successor uses `phase.begin`; an already open generation is
continued rather than rolled over a second time. A changed shared basis requires the exact
`phase.draft.rebase` route, preserving the original opening through its continuation chain.

A submitted packet must first use its authorized review/rejection route. Targeted and
document-only returns retain their original restrictions. A published repair with a pending
reviewer return must be reviewed before another author-only successor is opened; that condition
is reported before a new private generation is saved. No copied change-request flag grants
permission.

## Ownership and records

- The pure kernel owns source-delta reconstruction, confirmation and bounded preview values.
- The read owner authenticates the original accepted Story/configuration/source binding and
  published Code proof. It uses actual source ports for a new opening and archived comparisons
  for shared-only replay. It performs no writes, execution or checkout discovery.
- The existing preparation owner checks current author permissions and source revisions and
  conditionally saves the device-local draft. SDA retains its original transaction receipt.
- Generation v4 carries the exact reviewed opening. Original generation v1–v3 and v2 continuation
  meanings remain readable. Code v34/v35 carry author-confirmed successors, with a separate
  history v13; v35 retains mixed human acceptance. Code v36/v37 explicitly wrap environment or
  known-failure permission around v34/v35. Original Code v1–v33 meanings remain unchanged.

Unchanged tests are carried only from the authenticated predecessor's exact delivered paths and
matching current bytes. The receiving generation still needs its own SGOS execution. Known-failure
permission requires its fresh exact generation decision. Failed checks remain failed; a visual
slot still needs a new candidate-bound human witness. Previous artifact-set members are not
silently relabelled as new-generation outputs.

On a second laptop, the host binds the same logical source identities to its actual checkout and
provides a separate private store and executor. With no old draft, the opening preserves the
published primary artifact rather than producing an empty template. Local attachments still
follow their existing re-upload contract. Published replay needs shared records, not the previous
laptop's private files or checkout. Permission, missing-content, stale-source and timeout errors
retain their real identity and explicit recovery routes.

## Qualification and remaining work

This slice passes 289 distinct Mac checks across 37 test files, with no failures, cancellations
or skips; repeated runs are counted once. The unchanged original 34-check installed-package
qualifier passes alone in 50.5 seconds within its original 120-second parent and 60-second child
limits. Native source/bundled CLI rollover parity also passes without changing Git output.
Source validation passes 4,408 checks; VS Code types, the unchanged 2,011-site Git audit and all
13 original bundle ceilings pass. The gateway remains 852/852 modules (6,941,897 bytes).

Mac tests cover filesystem, SQLite and application stores; explicit adoption; stale confirmations;
protected and test-only boundaries; submitted packets; changed authors; lost acknowledgements;
same-generation continuation; exact risk and human-witness combinations; targeted repair; and
takeover. The offline installed consumer uses an empty `PATH`, rejects native Git/CLI/state imports,
and performs actual two-repository Code execution through independently approved Verification and
Release. NodeNext checks cover the public operation and value contracts.

The known-failure successor journey also reaches independently approved Verification and Release
with its actual failed legacy execution, fresh passing acceptance and generation-specific human
permission. Those receiving phases neither rerun nor relabel the Code execution.

The [completion ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md) retains the remaining native policy/query,
selective recovery, live application-review and external execution/evidence owners. Source
adoption and rollover do not stand in for those owners. Phases 8/9 and production authority
cutover remain separate. This work is tested on Mac only and is not merged to main.
