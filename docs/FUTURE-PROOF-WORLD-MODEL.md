# Future-proof world-model read contracts

This document records the validated first delivery of
`SPEC-future-proof-worldmodel_astra_final.md`. It is deliberately narrower than
the complete roadmap: it establishes the common identity, provenance, registry,
activation, coverage, and bounded-result contracts, then exposes only the
structural reads that the current runtime can implement truthfully.

## Validation and amendments

The specification's architecture is compatible with the existing product when
its stages are treated as release gates rather than as one large replacement.
Singularity Flow already has two relevant owners:

- WMB v4 owns governed, reusable, evidence-bound repository view composition and
  state-branch publication.
- AST Intelligence owns bounded, model-free structural extraction, project
  bindings, cache warming, query cursors, and ordinary-file fallback.

FWM therefore does **not** introduce another repository graph, fact store, or
world-model publication path. The initial delivery is an additive read-contract
layer over AST Intelligence. Existing WMB view names, manifests, cache keys,
publication rules, and lifecycle behavior remain unchanged.

The reviewed specification is amended as follows for this release:

1. F0 and the honest part of F1 ship first. F2 joins, federation, external
   extractor/runtime facts, and knowledge enrichment stay deferred until their
   producers and coverage contracts exist.
2. `ncg.skeleton`, `ncg.callers`, and `ncg.map` are active. The proposed
   `ncg.grep`, `ncg.find`, and `ncg.blast` descriptors are visible as `draft` and
   refuse execution. A name in a roadmap is not treated as an implementation.
3. FWM semantic identities use a strict, compact canonical-JSON subset with
   namespace-separated SHA-256. This is separate from WMB v4's established
   pretty canonical form, avoiding a breaking migration of existing WMB IDs.
4. Structural views remain optional. Disabled, missing, degraded, or unsupported
   AST returns explicit unavailable/partial coverage; it never blocks normal
   lifecycle work and the registered consumer falls back to ordinary files.
5. Reads bind the current captured working-tree cone. They do not claim that an
   uncommitted capture is a governed snapshot or reusable state-branch model.

## Public commands

List every reviewed descriptor and see which revisions are active:

```sh
singularity-flow wm read-views
singularity-flow wm read-views --json
```

Inspect a descriptor, including a draft descriptor, without executing it:

```sh
singularity-flow wm read-contract ncg.skeleton@1 --json
singularity-flow wm read-contract ncg.grep@1 --json
```

Run a bounded structural read:

```sh
singularity-flow wm read ncg.skeleton --paths src --max-facts 50 --json
singularity-flow wm read ncg.map --paths src,test --max-facts 50 --json
singularity-flow wm read ncg.callers --symbol exact-symbol-id --paths src --json
```

Use the returned opaque continuation with the same repository, access view, and
view descriptor:

```sh
singularity-flow wm read ncg.skeleton --cursor '<opaque-continuation>' --json
```

Continuations expire after 15 minutes. A changed access identity, descriptor,
view, or malformed cursor is refused instead of silently broadening the query.

## Registered views

| View | State | Output use | Current meaning |
|---|---|---|---|
| `ncg.skeleton@1` | active | advisory | Bounded declarations, modules, imports, and relationships from the current AST cone |
| `ncg.callers@1` | active | advisory | Known structural reference/caller edges for one exact symbol |
| `ncg.map@1` | active | advisory | Bounded file and module inventory from the current AST cone |
| `ncg.grep@1` | draft | advisory | Reserved until captured-text membership can be proven independently of AST language support |
| `ncg.find@1` | draft | advisory | Reserved until deterministic excerpt and ranking contracts exist |
| `ncg.blast@1` | draft | advisory | Reserved until base and target snapshots can be traversed independently |

Unversioned aliases resolve only to active revisions. Exact draft references may
be inspected, but execution fails with `FWM_VIEW_NOT_ACTIVE`.

## Result and trust semantics

Every result binds:

- the exact view descriptor, installed registry, and activation digests;
- normalized parameters, consumer, access view, ordering, rendering, freshness,
  admission, and budget profiles;
- a captured repository revision, AST policy definition, path cone, and
  working-tree fingerprint;
- each returned fact to a typed origin with producer identity and limitations;
- analysis, scan, traversal, and delivery coverage separately;
- semantic-query, semantic-result, delivered-slice, and complete result digests.

The result status is intentionally three-state plus availability:

- `found`: one or more admissible records were delivered;
- `absent-in-complete-scope`: no record was found and all relevant coverage is
  complete;
- `unknown`: no record was found but some relevant coverage is partial;
- `unavailable`: the structural source could not be used.

`unknown` is never promoted to absence. Pagination makes delivery partial even
when the captured scan is otherwise complete.

All active handlers declare `model: never`, `network: none`, no source writes,
no domain writes, and derived-cache writes only. Registry activation accepts the
exact reviewed package; descriptor substitution, alias rebinding, dependency
cycles, unsupported schema versions, and digest mismatches fail closed.

## Delivery status

| Specification increment | Status | Notes |
|---|---|---|
| F0 common contracts and inventory | implemented | Versioned contracts, schemas, migrations, hashes, provenance, activation, consumers, coverage, and results |
| F1 structural view registration | partial by design | Three existing AST-backed reads active; three unimplemented proposals remain draft |
| F2 governed joins | deferred | Requires candidate/base snapshot separation and join evidence |
| Federation and external extractors | deferred | Requires issuer trust, revocation, namespace, compatibility, and redaction contracts |
| Runtime/operational facts | deferred | Requires reviewed external authorities and freshness behavior |
| Knowledge enrichment | deferred | Must remain an evidence overlay, never a substitute for captured code facts |

Future increments should activate one exact descriptor revision at a time, add a
real handler and adversarial fixture, and prove complete cache identity and
coverage before changing the activation record.
