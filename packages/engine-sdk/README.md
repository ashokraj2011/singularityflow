# SFlow Engine SDK (preview)

Original application files can be archived with `source.baseline.retain`, through the single
namespace Engine or `hosts/namespace-source-baseline`. It retains real selected bytes without
advancing lifecycle state; see the repository's `docs/ENGINE-SDK-SOURCE-BASELINE.md` for proof,
local-attachment boundaries and the remaining application-publication integration.

Embed the versioned engine in a Node host such as a build runner or application. This package is
an ESM workspace preview. It has no installation hooks, global Node replacement, CLI discovery,
provider invocation or runtime npm dependencies. It is not published to a registry by this build.

The `constitution` export supplies pure standing-rule values with explicit syntax and digest
primitives. Namespace hosts retain the approved constitution and exact artifact citations in a
versioned publication report; semantic judgment remains the genuine human phase approval.
The offline package includes its locked YAML syntax implementation and ISC notice.

From the SFlow source checkout:

```sh
npm ci
npm run engine-sdk:build
npm pack --workspace @singularity-flow/engine-sdk --ignore-scripts
```

Install the resulting local archive in the host project with `npm install /path/to/archive.tgz`.
The archive contains the runtime, declarations and source inventory; it needs no SFlow checkout.
The ordinary CLI and extension installers and their existing package exports remain unchanged.

`testing/causes` and `testing/risks` provide pure classification and risk-record values. Namespace
hosts use `test-risk.context` and `decision.test-risk` for actual human decisions; the artifact-phase
`test-risk/v1` publication profile retains genuine failed execution and never claims passing tests.
Code uses `test-risk/v2` and explicit recovery-agreement risks use `test-risk/v3`; both retain
failed outcomes separately from source coverage and human visual acceptance. `test-cohort.context`
and `test-cohort.confirm` bind an actual observed suite baseline to a human-selected cohort, with
fresh receiving execution and original-owner renewal. The pure values are in `testing/recovery`.
See `docs/ENGINE-SDK-COHORT-AND-CODE-RISKS.md` for those contracts and authority. Independently
inventoried file execution and current-environment reuse are described in
`docs/ENGINE-SDK-SELECTIVE-RECOVERY-AND-QUALIFIED-REUSE.md`. Existing artifact-phase and native Git
meanings stay unchanged.

Selected failures keep separate failure, omitted-scope and observed-cohort permissions. A failed
baseline's sentinel cases must still execute. Code v43/v44 and their downstream reports preserve
actual failures; no permission turns them into a passing test. Cohort contexts may specify
`observedPhaseId` and numeric `candidateGeneration` to distinguish the original execution from
its receiving generation. Passing qualified reuse keeps its own independent permission.
See `docs/ENGINE-SDK-FAILURE-COHORT-AND-EXTERNAL-RUNNERS.md` for exact versions and renewal.

The `evidence` export also includes witness-exception renewal values with explicit prior-expiry
and time inputs. They preserve native record meanings and do not authenticate or persist a review.
Namespace exception recording remains separately gated; see `docs/ENGINE-SDK-WITNESS-RENEWAL-VALUES.md`.

Namespace `decision.risk` uses an explicit operation ID, retained clause observations and original
human authority. Read `story.evidence` first. Risk-bearing final approvals retain a separate final
evaluation; failed tests stay failed. See `docs/ENGINE-SDK-OBLIGATION-RISKS.md` for the exact profiles.

For the implemented namespace lifecycle, use one explicitly bound host:

```js
import { createNamespaceEngine } from '@singularity-flow/engine-sdk/hosts/namespace-engine';

const engine = createNamespaceEngine({
  records, content, scope: { projectId }, workId, authority,
  access: authenticatedApplicationAccess, clock: applicationClock,
  working: { records: localRecords, content: localContent }, sources: selectedSourceUnits
});
const draft = await engine.run('phase.prepare', { phaseId });
```

It binds one registry and the existing operation owners, from explicit enrollment/configuration
through reviewed-document authoring, publication, submission, human approval and route choices.
The optional `working` ports hold device-bound private drafts; shared-only hosts can read/review
and acknowledge retained effects, including publication without the old private store. Read and
write authority share the same explicit binding. Construction performs no I/O or enrollment.
An initial Code publication profile also binds real source archives and pinned test occurrences to
publish/submit/approve; see `docs/ENGINE-SDK-NAMESPACE-CODE-PUBLICATION.md` in the source repository.
Artifact-only verification/review phases can carry its approved source and test evidence through
`approved-code-inputs/v1`. A pinned `testEvidenceFrom` stays a required dependency with ordinary
inputs disabled. Original runs remain attributed to their producer; a new consumer publication
compares actual source inventories before acceptance. Its report is readable through issued
authoring and review resource handles, including on another device.
It does not cover every application workflow or acceptance contract. Additional production policy
owners and installed-project migration remain required work.

Use `phase.draft-check` for authored-content health and `phase.prepublish` to inspect the actual
draft, checkpoints and source/test evidence before publication. These read operations grant no
write or approval authority and do not run tests. `story.next` observes private draft progress;
`story.status`, `story.guide` and `workflow.assets` expose the accepted Story and approved asset names.
A missing configured owner still requires its real namespace implementation.

The namespace Engine also records authenticated scope/completeness/applicability decisions and
additive plan accounting. Read `scope.context` to obtain actual statement IDs and known clauses,
including the current private specification. Mutations such as `decision.scope` and `decision.plan`
require an explicit `operationId`; an identical retry returns its original receipt, while another
request under that ID is refused. The original human authority is verified from pinned configuration.
Plan accounting retains the reviewed source hashes. Continuing an already-open Code generation
after that decision uses an explicit `phase.draft.rebase` digest confirmation; source archives,
fresh tests and publication still have their own operations and final checks.

Use `story.document.attach` and `story.document.detach` for local supporting documents and images:

```js
const uploaded = await localContent.put({ projectId }, 'local', imageBytes);
await engine.run('story.document.attach', {
  operationId: 'attach-design-image', workId, documentId: 'design-image',
  name: 'design.png', mimeType: 'image/png', encoding: 'binary',
  content: uploaded.reference, reason: 'Attach the user-provided design input to this Story.'
});
```

Only metadata and integrity references enter shared Story state. All-phase read manifests identify
missing originals on another device and provide their exact re-upload bindings. Detachment preserves
earlier receipts and the local bytes. The optional `scope` and `testing/recovery` exports provide
pure value rules; they do not execute repair loops, accept risks or record human approval.

`upstream.raise`, `upstream.list` and accept-risk/dismiss through `upstream.decide` retain their
original producer and owner. Conformance v2 associates a partial row with that exact issue; one
genuine upstream decision covers its linked rows without a duplicate conformance decision. Other
upstream outcomes and the remaining runtime recovery/policy owners remain explicit prerequisites.
See `docs/ENGINE-SDK-NAMESPACE-DECISIONS-AND-RECOVERY.md` in the source repository for the contracts.

`phase.enter` also provides a content-reference authoring manifest over actual namespace inputs,
including pinned agent/skill/instruction dependencies and accepted human clarifications. Read its
exact resources through `phase.context.read` with the returned context digest and resource handle;
bounded text, binary chunks and metadata do not expose laptop paths or launch a model. Entry does
not prepare a draft or run checks. Edits invalidate the read plan without re-asking settled human
questions; published generations remain reviewable without the old private store. Hosts own
prompt wording and must respect the manifest's per-resource and total supporting-input budgets.
See `docs/ENGINE-SDK-NAMESPACE-PHASE-ENTRY.md` in the source repository for protocol and freshness
details. The installed Git adapter retains its existing v1 entry contract.

```js
import { createEngine, ENGINE_OPERATIONS } from '@singularity-flow/engine-sdk';

// Bind the operation ports explicitly. A port is a trusted integration, not user request data.
const engine = createEngine({ ports: applicationPorts });
const result = await engine.run('phase.review', { workId, phaseId });
```

`engine.run(operation, inputs)` is the public vocabulary. Helpers such as `publishPhase` enter
the same registry. Unknown operations, undeclared inputs and unavailable ports fail explicitly.
Declarations derive operation names, input keys and helpers from that executable registry. They
describe structural inputs; runtime still enforces context, exact review binding and authority.
Construction does not give a caller permission to approve: trusted ports must bind the actor,
project and current facts and preserve the applicable human approval policy.

For next-step advice, bind `storyNext.load` to an accepted Story and its current observations,
including the explicit model mode, then call `engine.run('story.next', { workId })`. The result
contains ordered semantic actions, prerequisites and registered operation references. It contains
no shell commands or model prompt. Reading the plan neither executes those actions nor records
approval. External setup and human routes remain the host's responsibility. The namespace read
host below implements phase/document and pending-question reads; it does not provide this port.

The core and `errors` exports are pure. Import storage explicitly when it is needed:

```js
import { createFilesystemNamespaceStore } from '@singularity-flow/engine-sdk/storage/filesystem';
const store = await createFilesystemNamespaceStore({
  root: absoluteApplicationDataDirectory, create: true, binding: { kind: 'shared' }
});
const result = await store.read({ projectId: 'payments' }, 'state', 'stories/example');
```

- `namespace`: draft record/transaction contracts and validation, with no selected backend.
- `storage/filesystem`: opt-in durable local filesystem namespace store.
- `storage/sqlite`: opt-in native SQLite namespace store; close it when the host is done.
- `storage/application`: bind an application's qualified atomic journal port.
- `storage/journal`: versioned journal-port constant and shared pure transaction reducer.
- `errors`: the same error constructor used by the engine and every bundled storage entry.
- `content`: draft immutable byte/reference contract, separate from metadata transaction limits.
- `artifacts`: pure artifact token validation, template rendering, UTF-8/binary classification
  and required-content observations with explicit host-computed fingerprints.
- `specifications`: pure clause/index value rules, verification intent/contracts and bounded draft
  diagnostics. Path/hash primitives are explicit; `specifications/node` supplies the optional Node
  value binding. Planned/observed native-v2 claim replays request the original timestamp explicitly,
  after validation, preserving serialized byte limits and record identity. Candidate values do not
  authenticate source bytes, retain evidence or admit publication. Deterministic quality, marker,
  scenario and human-checklist value rules use explicitly declared review content; their findings
  never claim semantic completeness, passing tests or human approval. Shared source-comment,
  clause-tag and JavaScript test-declaration values preserve native logical IDs, declaration
  hashes, limits and association gaps; they require no checkout or execution provider.
  The claim factory also combines observed delivery, evaluates coverage and legacy acceptance,
  and replays candidate completeness over explicit original record, timestamp and optional
  source/commit observations. Native public outcomes remain unchanged. These predicates never
  select a checkout, certify per-test execution, retain evidence or grant publication authority.
  See `docs/ENGINE-SDK-SPECIFICATION-COVERAGE.md` in the source repository.
  Implementation-binding replays request exact source/region observations and preserve native
  explanation/digest rules. Documentation/polyglot observations remain heuristic; reviewer-choice
  values do not authenticate a person or record approval. See `docs/ENGINE-SDK-IMPLEMENTATION-BINDINGS.md`.
- `storage/sqlite-content`: bind an application-owned SQLite content connection; the host closes it.
- `hosts/namespace-reader`: bind stored phase/document read projections to the existing registry.
- `hosts/namespace-engine`: one explicit composition of the implemented namespace operations,
  sharing captured storage, access, clock, source and read ports. Individual hosts remain available.
- `hosts/namespace-checks`: run pinned phase checks through `phase.checks.run`, retaining real raw
  reports and source/task bindings. The main composition accepts the same explicit `checks` ports.
  Retry acknowledges accepted evidence without the old private draft or executor. The supported
  primary-document profile binds those results into checked publication and submission records;
  human approval and other phase policy owners remain separate requirements.
- `hosts/namespace-project`: explicitly enroll a new namespace project through `project.enroll`.
- `hosts/namespace-configuration`: approve an exact workflow package under an enrolled authority.
- `hosts/namespace-story`: create work from an approved configuration through `story.create` and
  read its canonical lifecycle state and exact source through the same registry.
- `source`: pure source-unit and snapshot contracts, with logical identities and bounded metadata.
- `changes`: shared change-record ordering, entry identities and digest/integrity checks through
  explicitly bound SHA-256 and UTF-8 primitives. It preserves supplied logical data; source-control
  execution, wire decoding and accepted provenance remain adapter/lifecycle responsibilities.
  `sourceTextHunks(before, after)` compares explicit text under fixed work, text and trace bounds.
  It returns exact zero-context line coordinates; exceeding a bound raises an explicit error.
  It never discovers a checkout or substitutes a whole-file diff.
- `sources/filesystem`: read-only observations of explicitly selected physical checkouts.
- `source-control`: pure, versioned candidate-observation contracts, separate from source content
  and evidence acceptance. `sources/git` binds actual local Git observations to an explicit checkout,
  baseline, pinned executable, environment and authorization callback; it does not publish or approve.
  The separate `createFilesystemSourceContentReader` capability reads bounded byte ranges;
  the original observation unit does not gain file-content access implicitly.
- `execution`: provider-neutral execution-unit method binding and operational TypeScript contracts.
- `execution/node`: explicitly selected deterministic or fixed-command Node execution units.
- `execution/runtime`: decorate an explicit unit with durable attempts, live ownership, exact
  event/candidate retention and cross-process collection. Unknown effects never launch again
  automatically. Runtime results do not certify phase tests or grant lifecycle authority.
- `execution/storage`: pure SGOS Operational Store v1 protocol and TypeScript contracts.
- `execution/storage/namespace`: durable execution history over explicit shared SDA record/content
  ports, with conditional heads, retained lineage and confirmed backup/restore/rollback. It does
  not select native runtime authority, certify test evidence or replace the execution coordinator.
- `testing/reports`: pure structured test-report interpretation with explicit byte/hash capabilities.
- `testing/node`: the same report rules with Node bytes and hashing. Supply actual report contents;
  it reads no files and launches no command. Parsed counts do not certify phase acceptance.
- `testing/node-test-reporter`: the native Node event reporter as a standalone export. A host
  explicitly selects its resolved URL and root in the pinned test environment. Plain TAP counts
  cannot substitute for exact passing file, line, suite and test identities.
- `testing/execution`: explicitly authorized fixed-command local checks with actual process output,
  raw reports and source observations retained in shared runtime content. Compose it with durable
  execution for at-most-once attempts and takeover. It does not accept phase evidence or approvals.
  `createExternalCheckExecutionUnit` and `createExternalCommandExecutionUnit` accept pinned external
  runtimes for complete test and non-test commands. Supply an absolute executable and digest,
  literal arguments, exact environment, source root, report selection and authorization callback.
  These adapters do not discover a runtime, narrow a suite or claim qualified toolchain reuse.
- `hosts/namespace-source`: record actual repository observations through `source.bind`, retaining
  canonical lifecycle reads, original receipts and first source observations across takeover.
- `hosts/namespace-source-inspection`: compare a private code generation's accepted baseline with
  fresh source snapshots through `phase.source.inspect`. All selected repositories are checked
  before truncating the preview. Configuration, protected paths and test-only boundaries retain
  their shared classification rules. The query saves no data and establishes no test, publication
  or approval readiness; the main namespace Engine exposes the same registered operation.
- `hosts/namespace-source-retention`: retain exact current changed-file bytes through
  `phase.source.retain`. Supply explicit `sourceReaders` for a new collection. Chunked immutable
  evidence and verified receipts remain readable without the original checkout; baseline file
  contents, publication readiness and human approval remain separate requirements.
- `phase.output.retain` on `hosts/namespace-engine`: retain one explicitly supplied output content
  reference at its exact logical Story evidence path. Code outputs bind actual retained source.
  Evidence/runtime acceptance leaves the lifecycle revision and unchanged tests intact; publication,
  downstream reads and human witnesses use the exact retained generation. Local input attachments
  stay local unless explicitly supplied as output. The native Git host does not bind this operation.
  See `docs/ENGINE-SDK-FRESH-OUTPUTS.md` for bounds, recovery and compatibility profiles.
- `hosts/namespace-test-witnesses`: join accepted source declarations to their own retained test
  occurrences through `phase.test-witnesses.inspect`. The main Engine binds the same read operation.
  It preserves original approved plan, repository and shared-line provenance. Rows show individual
  test evidence; they do not combine full verification contracts or grant publication or human
  acceptance. See `docs/ENGINE-SDK-TEST-WITNESSES.md` in the source repository.
- `hosts/namespace-source-control`: accept actual source-control observations for the exact
  retained generation through `phase.source-control.retain`. Supply explicit `sourceControlReaders`
  for new collection. Conditional receipts and source/generation proofs support checkout-free
  acknowledgement; publication readiness and human acceptance remain separate requirements.
  The `specifications` value entry exposes `sourceTagOriginPolicies`, and `specifications/node`
  binds its exact carried-identifier and Story-added-line generators. Supply real source/line
  observations through their explicit requests; these values do not authenticate source proofs,
  retain evidence or grant publication. Supplying explicit `originCommit` alongside `baselineCommit`
  to the Node Git reader selects v2 line-origin evidence. Acceptance binds actual original and
  generation archives; shared-tag inspection uses verified positions and bytes. The v1 metadata
  path retains its original meaning. See `docs/ENGINE-SDK-PORTABLE-SOURCE-ORIGINS.md` in the repository.
- `hosts/namespace-delivery-inspection`: inspect accepted original/current source archives and
  real phase-check receipts through `phase.delivery.inspect`, with bounded affected-path previews.
  Its v3 manifest adds independently approved plan references and source-clause bindings from
  original retained bytes. It keeps v2 source tags, declaration identities and syntax gaps;
  existing v1/v2 port results remain readable. Pending origin or repository-ownership evaluation
  has explicit required owners and null counts. Source/execution observations remain separate
  from requirement acceptance. See `docs/ENGINE-SDK-SOURCE-CLAUSES.md` in the source repository.
  It checks current file matches, reports missing or stale evidence and gives registered recovery
  actions. Reading starts no test or application process and records no approval. Native code,
  claims, constitution and artifact-set publication policies retain their separate owners.
  Passing `includeImplementation: true` explicitly requests the v5 manifest, which reconstructs
  implementation regions from accepted original/current source archives and the approved plan.
  A host without that reader refuses the request. Default v1–v4 profiles are unchanged. Bounded
  previews retain full counts and a binding digest; missing archives and unsupported comparisons
  retain explicit recovery owners. See `docs/ENGINE-SDK-ARCHIVED-REGIONS.md` in the source repository.
- `hosts/namespace-preparation`: prepare actual pinned templates and read/save/rebind private phase
  drafts using separately device-bound local ports, without changing canonical phase state.
- `hosts/namespace-publication`: publish primary authored documents using the conditional namespace
  writer, preserve exact bytes and acknowledge original receipts across retry or device takeover.
  `NAMESPACE_SPECIFICATION_PUBLICATION_PROFILE` identifies the specification/plan profile: actual
  clause indexes and planned claims are retained with their original artifact/configuration and
  approved predecessor proof. It uses the same registered publish/submit/approve operations;
  command declarations are not passing tests. See `docs/ENGINE-SDK-SPECIFICATION-PUBLICATION.md`
  in the source repository for its versioned records and supported policy boundary.
  `NAMESPACE_POLICY_PUBLICATION_PROFILE` identifies retained specification analysis, including its
  original artifact/policy/basis proof. Human checklist answers remain a separate approval action;
  exact analysis report references are issued by `phase.review.resources`. See
  `docs/ENGINE-SDK-SPECIFICATION-ANALYSIS.md` in the source repository. Additional policy/execution
  owners and the complete portable lifecycle remain unfinished.
  The main namespace Engine also binds `clarification.status` and `clarification.record` to real
  authenticated human replies. Their read manifests contain exact resource references; uploaded
  bodies stay local. Publication conditionally binds accepted answers or legitimate optional
  absence, and review resources expose the original checkpoint document. Identical retries retain
  the original receipt; changed bindings and blocking deferrals offer reviewed repair routes.
  These checkpoints do not record phase approval or replace the remaining code-delivery owners.
  See `docs/ENGINE-SDK-CLARIFICATIONS.md` in the source repository.
  Code publication retains actual source archives and exact executed acceptance tests. The v1
  Code profile stays generation-1-only. The separate v2 profile authenticates the configured-loop human
  return and predecessor before a separately tested successor. Conformance publication records
  qualified rows against approved definitions and Code evidence, keeps partial verdicts honest
  and attributes carried tests to their original producer. Final partial gaps need a supported
  human disposition or configured return; they are never silently accepted. See
  `docs/ENGINE-SDK-NAMESPACE-CONFORMANCE-REWORK.md` for supported profiles and remaining owners.
- `hosts/namespace-submission`: submit a published primary document using shared records only,
  retain its exact review packet and acknowledge its receipt on another host without private drafts.
  This requests required human approval; it does not record it.
- `hosts/namespace-approval`: record an explicitly confirmed human vote over that exact shared
  submission, enforce pinned authority and quorum, and advance a reviewed-document workflow.
  Acknowledgement on another host preserves the original receipt and creates no new vote.
  The main namespace Engine additionally exposes `conformance.context` and `conformance.decide`: the original
  upstream owner's authenticated human may accept a dated risk or dismiss that exact gap. Verdicts
  and retained execution evidence stay unchanged. `phase.reject` supports a reviewed return to an
  allowed target, using a separate Code v3 successor proof. Original Code v1 and loop v2 replay
  retain their meanings. Use `hosts/namespace-engine` for these actions; the focused approval host
  only consumes their verified receipts. These are opt-in namespace operations; native CLI/installed authority
  cutover is still pending.
  Versioned routed votes apply pinned branches and rework, preserve receipts through successor
  generations, and pause unanswered human choices. Actual code/test execution still needs its
  separate runtime owners.
- `hosts/namespace-routing-choice`: read the exact question through `decision.context` and record
  an authorized human's `decision.choose`, retaining original receipts through later phases and
  generation-bound question identities. Application delivery policies remain a separate gate.

The Story host binds the same stores, scope and authority as project setup, plus an explicit
`workId`, creator access port and clock. `story.create` takes `operationId`, `workId`, `title`,
`workTypeId`, the approved `configurationId` and an immutable shared text `source` reference.
The creator port supplies authenticated identity and fresh `story.create` permission. Creation
retains generation zero and unbound execution; it does not record tests or human approval.
The returned `source` reference can be read with `document.read`. Reuse the same inputs and
operation ID after a lost acknowledgement. Production portable phase execution is still pending.

The source host adds explicit source units and fresh `source.bind` permission to those bindings.
Its operation takes `operationId`, `workId`, `expectedRevision`, logical `repositories` and `reason`.
The filesystem unit hashes real files and emits bounded relative metadata; neither source bodies
nor physical roots enter retained manifests. It excludes `.git` and `.singularity-flow` by default;
dependency/build exclusions are explicit. Source drift, permission errors and timeouts remain real
errors. Binding does not open a generation, execute tests or replace human review. See
`docs/ENGINE-SDK-SOURCE-BINDING.md` in the source distribution for retry and takeover semantics.

The preparation host adds explicit `localRecords` and `localContent` ports with the same
machine-local device binding. Its access port supplies the pinned `agentId` and fresh permission
for `phase.prepare`, `phase.draft.read`, `phase.draft.write` or `phase.draft.rebase`. Draft writes
take a stable operation ID, exact private revision and actual local content reference. Repeated
preparation preserves authored bytes; accepted retries acknowledge their original write. Shared
basis changes require an explicit digest-confirmed rebind. Binary bodies remain bytes, while text
previews obey the requested budget. No source files, shared generation, tests or approval are
changed. See `docs/ENGINE-SDK-PRIVATE-PREPARATION.md` for binding, recovery and remaining policy scope.

The artifact observations check authored bytes, metadata, headings, placeholders, template
baselines and binary bounds under a pinned phase contract. They preserve native findings while
keeping byte reads and SHA-256 computation in the host. Their results establish content findings;
the registered operations separately enforce lifecycle, source, tests and human authority. See
`docs/ENGINE-SDK-ARTIFACT-INSPECTION.md` for the exact boundary and host example.

The read host needs one explicit Story scope, a metadata store, a content store and a previously
saved read head. It implements `phase.review`, `phase.review.resources`, `document.read` and
`decision.context`; its
other operation ports remain unavailable. A saved projection cannot establish an approval
binding. A canonical lifecycle head supplies the shared submission proof before returning one;
the final observed head and authority are checked after those reads. It has no Git or provider fallback. The
repository guide `docs/NAMESPACE-CONTENT-AND-READ-HOST.md` describes host binding and qualification.

```js
import { createNamespaceReadEngine } from '@singularity-flow/engine-sdk/hosts/namespace-reader';

// These stores and the saved read head are explicitly supplied by the application.
const reader = createNamespaceReadEngine({ records, content, scope: { projectId }, workId });
const review = await reader.run('phase.review', { phaseId });
const document = await reader.run('document.read', { reference: review.manifest.items[0].reference });

// A submitted canonical lifecycle also issues the exact packet/artifact references.
const context = await reader.run('phase.review.resources', { phaseId });
for (const resource of context.manifest.resources) {
  const retained = await reader.run('document.read', { reference: resource.reference });
  // Present verified bytes; reading does not record a human decision.
}

// A canonical lifecycle can expose an exact unanswered human question without choosing a route.
const decision = await reader.run('decision.context', { workId });
```

The separate routing-choice host adds authenticated human access and an application clock. Read
`decision.context`, present its exact question/options, then call `decision.choose` with `expected`
set to the returned question key, either `option` or a permitted `to`, and the human's `reason`.
The host requires fresh permission and pinned group membership for a new choice. Exact original
receipt acknowledgement needs the original authenticated person, without a new vote or timestamp.
New nested v2 routing records bind questions to generations under equal clocks; old v1 bytes and
keys remain unchanged. See `docs/ENGINE-SDK-NAMESPACE-ROUTING-CHOICES.md` for the profile and scope.

The content connection needs durable SQLite journaling and FULL/EXTRA synchronous writes. The
application chooses its bounded lock-wait policy and closes the connection. Content tables need
a separate database from the exclusive SQLite namespace journal. Missing local attachments ask
for matching reupload on that device; they are never read from shared content instead.

New projects can establish their lifecycle authority through the same SDK registry:

```js
import { createNamespaceProjectEngine } from '@singularity-flow/engine-sdk/hosts/namespace-project';

const project = createNamespaceProjectEngine({
  records, content, scope: { projectId }, authority: { id: authorityId, epoch: 1 },
  access: applicationProjectAccess, clock: applicationClock
});
const enrollment = await project.run('project.enroll', { operationId: stableEnrollmentId });
```

The application supplies `access.current({ projectId, operation, signal })`, returning its current
`projectId`, `principalId` and `permissions`, and `clock.now()`, returning a canonical UTC timestamp.
Fresh `project.enroll` permission is required before preparing and committing. A pending operation
keeps its original principal and timestamp; retry with the same operation ID to reconcile it.
An accepted retry returns the original receipt without activating another authority. Enrollment
never replaces or reactivates an existing authority, approves configuration, creates a Story or
migrates a Git project. The other lifecycle ports in this host remain unavailable. See the source
guide `docs/NAMESPACE-PROJECT-ENROLLMENT.md` for persistence and qualification details.

An enrolled namespace project can approve a canonical configuration through
`createNamespaceConfigurationEngine` from `@singularity-flow/engine-sdk/hosts/namespace-configuration`.
The registered operation is `configuration.approve`; it requires an operation ID, immutable
`source` content reference, exact `confirm` SHA-256, `expectedRevision` and review `reason`.
Use explicit `null` for the first absent head and the last result's `revision` for an update.
The separate `transactionRevision` identifies the accepted transaction. The source package retains
the definition, agents, skills, instructions, templates and additional configuration resources.
All declared bodies are verified, and the existing workflow compiler validates every work type.
The compiled package retains the effective workflow contracts for later Story creation.

The configuration host takes the same explicit stores, scope, authority and clock as enrollment.
Its `access.current` additionally returns `actorKind: 'human'` and fresh `configuration.approve`
permission. A service identity cannot claim human review. Reuse the original operation ID to
reconcile an interrupted approval; accepted replay preserves its original reviewer and timestamp.
No Story is created by approval. Source format and ownership details are in
`docs/ENGINE-SDK-CONFIGURATION-APPROVAL.md` in the source distribution.

The execution backend can also be used by a Node application or build runner:

```js
import { captureExecutionUnit } from '@singularity-flow/engine-sdk/execution';
import {
  createGenericProcessExecutionUnit, createAgentTaskContract
} from '@singularity-flow/engine-sdk/execution/node';

const unit = captureExecutionUnit(createGenericProcessExecutionUnit(reviewedManifest, {
  root: absoluteExecutionDirectory, authorizeManifest: authorizeExactReviewedManifest
}));
const handle = await unit.start(createAgentTaskContract(confirmedTaskInputs));
for await (const event of unit.observe(handle)) consumeExecutionEvent(event);
const quiescence = await unit.quiesce(handle);
const candidate = await unit.collect(handle);
```

The fixed-command manifest pins the executable bytes, argv, environment allowlist, registry
authorization and externally attested sandbox. The existing profile requires denied network and
empty repository/Device scopes. Its result is candidate output. Lifecycle admission, retained
test evidence and human approval remain with their own engine operations. The optional backend
loads no installed provider, repository configuration or CLI, and performs no Git selection. Handles are local to
the adapter process; a restarted process returns `SGOS_GEU_HANDLE_STALE`. Durable SGOS attempt,
lease and phase-check coordination still need their portable owner before full Story execution.

Node 22 or later is required for the core and filesystem/application backends. SQLite is loaded
only when the namespace factory is called and requires the native capabilities qualified on managed Node
26.12.0. An incompatible SQLite runtime fails explicitly; there is no hidden package download.
The content entry imports no SQLite runtime: the application supplies its connection explicitly.

Storage uses `sda-namespace-store/draft-1`; the engine vocabulary is `sflow-engine/v1`. The package
is `1.0.0-alpha.0`, not a product 1.0 release or a stable storage-contract announcement. Its
`private` flag prevents accidental registry publication while local packing/installing remains
supported. A versioned engine name, shape or outcome change needs an explicit contract version.

This delivery makes the existing explicit-port engine and namespace stores installable. It provides
portable lifecycle ports for the explicitly qualified profiles; additional configured policy and
execution owners remain required. Existing Git lifecycle/configuration
authority is unchanged; this package neither migrates an installed project nor automatically
selects a namespace store. Full cross-agent Story execution, verified authority cutover and final
distribution/performance qualification remain migration gates.

The namespace host also provides `test-command.context`, `test-command.request` and
`test-command.decide`. [Story-command contracts](../../docs/ENGINE-SDK-NAMESPACE-TEST-COMMANDS.md)
describe exact command hashes, the namespace request wrapper, original human authority and
execution through explicitly bound SGOS checks. Accepted commands do not establish passing tests.

The namespace host provides `convergence.context` and `convergence.adjudicate`, deterministic
`phase.prepare`/`phase.publish`, and digest-confirmed `convergence.advance`. They use actual Code
publications, original tests and human approvals. Rework retains the old answer and requires a new
judgment after the producer's replacement execution. Submitted convergence uses packet v5; original
packets v1–v4 keep their meanings. The optional `convergence` export provides pure value factories
and types, without source access, evidence acceptance or approval authority. The
[convergence contracts](../../docs/ENGINE-SDK-NAMESPACE-CONVERGENCE.md) describe these boundaries
and the remaining Phase 5/7 owners.


The namespace host provides `evidence-reuse.context` and `decision.evidence-reuse` for exact
artifact-phase reuse of an earlier approved execution. It verifies real source, task, command,
repository, submission and human decision proofs. The receiving phase has no execution of its
own; publication reports preserve the producer and explicitly disclose that distinction.
Configured Code checks and recovery agreements that prohibit reuse retain their own contracts.
The `testing/reuse` export exposes pure bounded helpers, not evidence acceptance or authority.
See [the reuse profile and qualification](../../docs/ENGINE-SDK-EVIDENCE-REUSE.md).

Hosts may opt into `checks.environmentSensitiveReuse` and provide actual environment-qualified
Node check bindings. Reuse v2 rechecks the real runtime, environment and retained runner-source
inputs before publication, submission and approval, while still claiming no receiving execution.
`test-recovery.select-context` and `test-recovery.select-confirm` supply a separate human-reviewed
whole-file selection over an independent native Node JUnit inventory. The one `phase.checks.run`
operation retains actual selected executions and explicitly unexecuted case IDs. See the
[new profiles, boundaries and takeover contracts](../../docs/ENGINE-SDK-SELECTIVE-RECOVERY-AND-QUALIFIED-REUSE.md).


`testing/causes` exposes cause classification and bounded case/suite messages through an explicit
memory-byte normalization capability. It shares the native rules, preserves code failure priority
and refuses to turn an unknown or timed-out run into an environment exception. These are value
observations; human risk acceptance and execution evidence remain separate registered owners.
See [the ownership and compatibility record](../../docs/ENGINE-SDK-TEST-CAUSES.md).
