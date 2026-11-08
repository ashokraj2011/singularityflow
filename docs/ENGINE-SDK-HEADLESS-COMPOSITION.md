# One headless Engine over explicit namespace ports

`hosts/namespace-engine` composes the implemented namespace operations into one public Engine.
It constructs the SDK registry once and binds each operation's existing owner. It does not
dispatch another Engine, invoke the CLI or introduce an alternate lifecycle implementation.
Existing individual host constructors retain their public contracts and remain available.

```js
import { createNamespaceEngine } from '@singularity-flow/engine-sdk/hosts/namespace-engine';

const engine = createNamespaceEngine({
  records, content, scope: { projectId }, workId, authority,
  access: authenticatedApplicationAccess,
  clock: applicationClock,
  working: { records: localRecords, content: localContent },
  sources: selectedSourceUnits
});

await engine.run('project.enroll', { operationId: enrollmentId });
await engine.run('configuration.approve', reviewedConfigurationInput);
await engine.run('story.create', storyInput);
await engine.run('phase.prepare', { phaseId });
const draft = await engine.run('phase.draft.read', { phaseId });
// The author reads the issued context and stores actual authored bytes in localContent.
await engine.run('phase.draft.write', authoredDraftInput);
await engine.run('phase.publish', { phaseId, authored: 'governed-agent', channel: 'copilot-host' });
await engine.run('phase.submit', { phaseId });
// The application presents the exact retained resources to a separately authenticated human.
const review = await engine.run('phase.review.resources', { phaseId });
await engine.run('phase.approve', { phaseId, confirmation: humanReviewedBinding });
```

This is the current reviewed-document profile, including branches, bounded automatic rework,
human route choices and original-receipt recovery. Actual application delivery, test execution,
other production policies and the remaining namespace operation owners still have their own
required gates. The registry exposes the full operation vocabulary; an unbound port remains an
explicit `ENGINE_PORT_UNAVAILABLE`, and a configured policy can require additional owners.

## One bound context

The constructor requires one explicit project scope, Story ID and authority ID/epoch. Reads use
that same authority as writes. A conflicting canonical locator is fenced; an old read projection
cannot stand in for the Engine's canonical lifecycle. The separate read-only projection host
continues supporting its original projection contract.

Metadata/content, access, clock and source methods are captured once before the first operation.
Changing a supplied object's methods or scope later cannot redirect one operation to another
backend. The captured access method still returns fresh authenticated facts for each operation.
Constructor option values are sampled once. The combined host rejects unknown option names
without evaluating their accessors; existing individual hosts continue ignoring unknown options.
The application owns its stores and connections; the Engine neither opens nor closes them.
Construction performs no enrollment, source capture, metadata transaction or content read/write.

All writers retain their original policy, conditional state/configuration/authority basis and
receipt semantics. There is one common phase/document/question read composition. Internal port
factories own their existing feature coordination; no caller-supplied readiness or authority
flags are introduced. Architecture guards permit only this explicit composition to connect the
new factories and prevent installed surfaces from selecting it implicitly.

## Explicit capabilities

`working` is optional. When present, its metadata and content ports must have matching
machine-local device bindings. It holds private drafts and their context, separately from shared
Story state and evidence. New preparation, draft writes/rebinds and publication need these real
ports. A host without `working` cannot manufacture a draft or new publication.

Shared-only hosts can still read retained resources, submit actual publications, record authorized
human approval/choices and acknowledge a committed publication. Publication acknowledgement
verifies its original immutable intent/record/receipt using shared stores; it does not synthesize
a missing draft or need the old laptop. Actual read/permission/deadline errors stay intact.

`localContent` optionally supplies local attachment bytes. If omitted, the working content store
serves those reads when available. A separate attachment store may be supplied explicitly.
Missing local attachments retain their matching-reupload route; the composition copies no local
files into shared storage.

`sources` contains explicit SGOS source units. The application selects the real checkouts and
constructs those units. Capturing their methods does not inspect source files. `source.bind`
records the actual requested observations; source/application execution still belongs to SGOS.
Source code remains in its selected checkout rather than the namespace draft/evidence store.

An epoch-one host can enroll a genuinely new project or acknowledge its original enrollment.
Later-epoch compositions do not bind the new-project enrollment operation. No constructor or
enrollment retry replaces an existing authority. Verified migration and archival receipt handling
across epoch changes remain separate Phase 8 work.

## Human and author identity

`access.current({ projectId, workId?, operation, signal })` supplies authenticated principal,
actor kind, identity, agent ID and current permissions. Project operations omit the Story field.
The application authenticates a different reviewer before calling human approval or route choice;
an operation name or model-selected agent cannot grant that identity. Clock access is explicit.

The original owners keep independent-review/self-approval rules, exact packet/question
confirmation, pinned memberships, quorum and fresh precommit checks. Changing identity during a
prepared effect is still refused. Genuine accepted receipt acknowledgement retains its original
actor and audit agent without another mutation or timestamp.

## Qualification

Mac qualification on Node 26.12.0 passed 393 checks across 19 test files, with no failures,
cancellations or skips: 24 composition and constructor-binding checks, 295 existing namespace
host regressions, 55 architecture checks and 19 installed-package checks. Real filesystem,
SQLite and application-journal stores complete the reviewed-document lifecycle through one
Engine. The installed archive also authors, publishes, approves, records a human route choice
and acknowledges original receipts in another shared-only, empty-PATH process.

Source validation passed 3,847 checks across 191 skills; VS Code typechecking and the unchanged
2,011-site Git ownership audit passed. All 13 existing production bundle budgets passed without
raising a ceiling: the gateway remains 851 modules and 6,860,814 bytes, and the extension remains
152 modules and 1,291,045 bytes. The SDK preview builds 51 registered operations over 121 modules
and 1,262,706 bytes. No Windows, hosted CI, live provider, real Story, installed authority, merge
or push was involved.

## Remaining milestones

This supplies one public composition for the implemented ports. It does not finish Phase 7's
production policy/execution scope or the complete cross-agent application Story. The
[original-policy proof](ENGINE-SDK-STORY-POLICY-PROOF.md) now verifies copied policy against actual
creation receipts. Remaining native policy/query extraction retains its scope. Verified
existing-project migration, authority cutover, obsolete-access removal, final surface/distribution
qualification and performance comparison remain Phases 8 and 9. No installed Git project is
migrated or reconfigured by importing this host.
