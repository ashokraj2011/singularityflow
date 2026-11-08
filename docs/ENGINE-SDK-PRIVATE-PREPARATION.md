# Namespace preparation and private drafts

The explicit `hosts/namespace-preparation` SDK entry composes actual shared lifecycle reads with
separate device-local working stores. It implements registered `phase.prepare`, `phase.draft.read`,
`phase.draft.write` and `phase.draft.rebase` operations. CLI, Copilot and VS Code continue using
their installed Git compatibility owners; importing this host never selects another authority.

## Bind the host

```js
import { createNamespacePreparationEngine } from '@singularity-flow/engine-sdk/hosts/namespace-preparation';

const engine = createNamespacePreparationEngine({
  records, content, scope: { projectId }, workId, authority,
  localRecords, localContent,
  access: applicationPhaseAccess,
  clock: applicationClock,
  sources: explicitlyBoundSourceUnits
});
const preparation = await engine.run('phase.prepare', { workId, phaseId });
const draft = await engine.run('phase.draft.read', { workId, phaseId, maximumBytes: 65_536 });
```

`records` and `content` are the same explicitly configured shared ports used for enrollment,
configuration approval, Story creation and source binding. `localRecords` and `localContent` must
both declare `machine-local` and the same nonempty device identity. The application owns their
physical locations, lifetime and connections. There is no home-directory discovery, Git fallback,
external provider, generated file path or hidden global cache.

The access port receives the exact project, Story and operation. It returns authenticated
`projectId`, `principalId`, `actorKind`, `identity`, `agentId` and `permissions`. Each operation needs
its own permission, including reads. The phase's pinned author and read-only-agent rules still
apply. An absent author session, changed principal or changed phase agent cannot borrow an earlier
authorization. New writes check identity, permission, Story revision and authority again before
their conditional local acceptance.

## Preparation and input retention

Preparation reads the actual immutable configuration approval, selected template, Story source,
required approved inputs and active agent, skill and instruction closure. It verifies retained
bytes, keeps local supporting documents local and reports matching reupload when they are absent
on this device. The native and namespace paths use the same pure template renderer and sequence,
author, code-delivery and skill-host prerequisite rules. Upstream bodies are referenced by exact
generation and content digest rather than copied into an unbounded template input.

The first private acceptance retains the rendered artifact, original template binding, actual
input manifest, author, time, canonical Story revision and authority revision. Repeating prepare
against that same basis preserves edited bytes and the original preparation. It does not replace
them with the template or restamp the authoring record.

A code phase requires actual accepted `source.bind` observations and matching SGOS source units.
The host compares their real selected bytes before preparation and again before acceptance.
Its private source-generation record retains those observations; it does not invent a Git commit
or reinterpret an SDA revision as one. Preparation does not edit application files or install an
execution environment. Shared lifecycle generation and execution readiness are unchanged.

## Save and read actual authored bytes

```js
const savedContent = await localContent.put(
  { projectId }, 'local', new TextEncoder().encode(authoredText)
);
const saved = await engine.run('phase.draft.write', {
  operationId: stableWriteOperationId,
  workId, phaseId,
  expectedRevision: draft.manifest.draft.revision,
  content: savedContent.reference,
  reason: 'Complete the phase draft against its verified inputs.'
});
```

Inputs contain logical IDs, an exact local revision and an immutable local content reference.
Physical paths, caller-supplied identity and claimed approval are not operation inputs. The
write retains the actual content digest and previous private body. A stale editor cannot
overwrite a newer accepted head.

`sflow-phase-working-draft-manifest/v1` distinguishes `missing`, `open` and `stale`. An existing draft
reports its private revision and body digest, generation, original author and time, basis and
current Story revisions, relative artifact key and actual content reference. UTF-8 previews
preserve the BOM and complete multibyte characters within both the requested and configured
byte limits. Binary drafts return their actual size and reference; they do not manufacture a
text preview, screenshot or visual pass.

## Retry, rebind and takeover

The private head and immutable operation record are accepted in one conditional local transaction.
The immutable body lives in the local content store. Every acknowledgement and reopened record is
checked against the actual transaction receipt, revisions and content digest. Same-ID/different-
request reuse is refused. A malformed or lost acknowledgement does not erase an accepted update;
retry its exact inputs and operation ID to inspect and acknowledge the original outcome, even
after subsequent edits. Acknowledging an accepted result does not authorize another write.

A changed canonical basis returns `ENGINE_DRAFT_BASIS_CHANGED` and the registered rebind route
with the actual current private revision and body digest. Read and review it, then use:

```js
await engine.run('phase.draft.rebase', {
  operationId: stableRebindOperationId,
  workId, phaseId,
  expectedRevision: staleDraft.manifest.draft.revision,
  confirm: staleDraft.manifest.draft.bodySha256,
  reason: reviewedRebindReason
});
```

Rebinding preserves the authored artifact and previous private body, checks current inputs and
source observations and records the exact reason. It cannot silently refresh an old editor or
move canonical Story state. The shared and local stores have no implicit distributed transaction:
if shared state moves after the last check, the local draft remains bound to the captured basis
and reads as stale. Publication will need its own fresh conditional binding check.

A different laptop starts with its own private stores. Shared Story/configuration/source records
remain available through their configured authority; private authored drafts and attachments are
not uploaded or silently copied to that device. Full cross-agent resume and attachment reupload
operations remain later runtime work. Existing Git installations keep their current takeover flow.

## Effects and remaining scope

Private writes explicitly report `committed: false`, `pushed: false`, `sourceFilesChanged: false`,
`testsRun: false`, `humanReviewRecorded: false`, `approvalRecorded: false` and `storyAdvanced: false`.
Their local acceptance is not an immutable phase publication, test result or approval. Canonical
`phase.review` and `document.read` continue describing shared retained state; use `phase.draft.read`
to inspect this private working draft. The shared lifecycle committer rejects local-draft operations.

Missing bytes, genuine permission errors, changed files, deadlines, cancellation, future record
versions, fencing, conflicts and uncertain outcomes retain explicit errors. New private formats
are versioned separately from installed Git records. No automatic authority migration is enabled.

This is a Phase 7 preparation slice, not a complete portable lifecycle backend. Namespace
publication, submission, decisions, approval, full phase entry and cross-agent execution still
need their actual policy and execution ports. Native required after-step actions, MCP readiness,
impact/planned claims and full test-command policy still need extraction. Required TRP agreements
and readiness, reference repositories, deterministic/kernel producers and qualified skill hosts
remain explicit prerequisites; this host does not manufacture success for an unavailable owner.

## Mac qualification

On Node 26.12.0, 296 checks across 17 affected test files passed with no failures, cancellations
or skips. They cover actual filesystem, SQLite and application-journal working stores; preserved
authored bytes and original receipts; stale writers and explicit rebinds; concurrent heads;
revoked permission, changed actors/agents and fencing; lost/malformed acknowledgements;
source drift and descriptor mismatches; real permission errors, missing content and future
schemas; bounded UTF-8 and binary reads; native preparation/skill-host compatibility; installed
SDK declarations and empty-PATH cross-process reopening. The final schema-owner adjustment was
requalified with 88 passing checks from that same set, without adding duplicate test counts.

Source validation passed 3,804 checks. VS Code typechecking, the Git ownership audit (2,011
existing sites), whitespace validation and all 13 unchanged bundle budgets passed. The gateway
remains 851 modules and the extension 152. No budget ceiling was raised. The packed preview has
49 registered operations and no runtime npm dependency. All fixtures used isolated local stores
and machine state. No Windows, hosted CI, live provider, install, real Story migration, push
or merge ran.
