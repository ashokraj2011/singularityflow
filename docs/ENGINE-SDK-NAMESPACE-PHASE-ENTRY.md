# Namespace phase entry and exact context reads

The explicit namespace Engine provides `phase.enter` and `phase.context.read` through the same
operation registry used by preparation, publication, submission and approval. This is a separately
versioned content-reference manifest. The installed Git entry keeps its existing v1 callbacks,
wire output, prompting and authority.

## Ownership and use

The kernel derives admission, clarification state, resource ordering, byte budgets and semantic
actions from observations. The SDK coordinates the stages. The namespace adapter reads original
Story/configuration receipts, accepted predecessor generations, private drafts and human answer
records. Source units provide actual current source observations. Hosts compose model wording and
perform any model invocation; no model prose or shell command is part of this protocol.

```js
const entry = await engine.run('phase.enter', { phaseId, compose: true });
const manifest = entry.manifest;
for (const resource of manifest.resources) {
  const body = await engine.run('phase.context.read', {
    workId: manifest.workId, phaseId: manifest.phase,
    contextSha256: manifest.context.sha256, resourceId: resource.id,
    maximumBytes: resource.budgetBytes, representation: 'text'
  });
  // The host interprets encoding, truncation and policy budgets before composing its prompt.
}
```

`sflow-phase-entry-manifest/v2` names exact content references and opaque resource handles rather
than laptop paths or checkout-specific document aliases. Its ordering puts constitution first,
preserves the pinned agent/skill/instruction dependency order, then includes Story source,
approved inputs, supporting documents, confirmed human replies, the artifact template, generation
intent and existing private draft as applicable. Required approved input references must match the
actual retained generation. A missing resource cannot be replaced by a supplied readiness flag.

The manifest declares per-resource preview limits and the supporting-document total budget.
The read operation accepts at most 1 MiB per request and also applies the resource's preview limit.
The host must respect the aggregate prompt budget. Text previews stop at UTF-8 code-point
boundaries and preserve a BOM. Binary reads return explicit binary encoding, with no fabricated
text. Use `representation: 'base64'` and a numeric `offset` for bounded byte chunks, or `metadata`
for identity only. Original full-body digests and lengths remain separate from returned previews.

## Authoring and human checkpoints

Entry performs no preparation, staging, check execution, model invocation, publication or phase
advancement. Before preparation it returns `preparation-required`; application editing additionally
requires an actual opened private generation intent and matching source-unit bindings. An unbound
source unit, stale draft, missing author permission or unavailable policy owner stays explicit.

Human answers use `manifest.clarification.contextSha256`, not `manifest.context.sha256`. The first
identity binds the approved clarification inputs; the second also binds resources, current draft,
answer receipt and source observations for this read plan. Editing a private artifact invalidates
the old read plan without making confirmed answers stale. Replacing an answer still requires the
existing explicit human operation and reason. Entry cannot accept answers or approve a phase.

Published generations expose `retained-generation`, their accepted answer reference and a
`phase.review` action. They do not reopen questioning or require the old private store on another
device. Historical phases use the existing review/document operations; entry remains scoped to the
current phase. A completed Story does not acquire a new authoring phase by reading context.

## Freshness, local files and errors

Each read must name the exact issued context digest and resource handle. Before returning it,
the adapter rechecks Story/authority revisions, principal/agent/permissions, private draft identity,
actual selected source snapshots and the observed clarification index, including explicit absence.
A concurrent change returns its context/source error and requires a fresh manifest. It does not
recreate a Story, rerun tests, retry a model or overwrite an edit.

Uploaded bodies remain in the explicitly supplied local content store. Before authoring, a
declared but absent input produces `documents-required` and exact reupload metadata. The body reader returns
`DOCUMENT_REUPLOAD_REQUIRED` for that resource. Shared accepted records retain references, not the
uploaded body. Retained local input references are marked `verify-on-read`; an accepted publication
does not establish that those bytes exist on another laptop. This read integration does not
implement a new upload/attachment writer.

Real permission failures, storage deadlines and cancellation preserve their original error and
recovery details. Unknown manifest versions fail explicitly instead of falling back to a different
protocol. `readsVerified: false` and `execution.inspected: false` distinguish context availability
from host consumption or actual execution evidence.

## Qualification and remaining work

Mac qualification passed 316 distinct affected cases with no failures, cancellations or skips:
201 core/namespace/architecture cases, 86 native parity/Git/wire cases and 29 installed-package
cases. A final 41-case changed-entry rerun, included in that total, passed after tightening settled
answer hints and retained local-resource availability. These checks cover existing native
entry/preparation parity, real filesystem/SQLite/application stores, ordered dependencies, accepted
predecessors, confirmed-answer takeover, actual code intents, UTF-8/binary budgets, concurrent
source/draft/answer changes, permission/cancellation errors and the installed SDK outside the source
checkout. Source validation passed 3,985 checks across 191 skills. VS Code types, the unchanged Git
ownership audit and all 13 unchanged runtime bundle ceilings passed, with gateway 852/852. The SDK
retains 60 operations across 205 owned modules and 2,081,982 JavaScript bytes. Public native record
versions remain unchanged. The installed checks also cover genuine pinned test execution and
independent human approval; the entry itself never claims those execution or approval effects.

This completes neither full application publication nor installed-project authority migration.
Remaining production policy/execution owners, complete application Story execution, existing-data
migration/cutover and final distribution/performance qualification keep Phases 5, 7, 8 and 9 open.
No Windows, hosted CI, live provider, real Story migration, product install, merge or push is part
of this delivery.
