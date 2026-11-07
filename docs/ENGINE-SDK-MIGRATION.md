# Engine SDK and namespaced storage migration

The target is a portable Node runtime with an embeddable engine. CLI, VS Code, MCP and Copilot
adapters consume the same versioned operation vocabulary. An application can persist SFlow's
logical data through Git, files or its own database implementation.

This migration starts from `main@229441d9b`. The first three deliveries establish a component
baseline, extract shared errors/outcomes, define the namespace-store draft, and add an internal Git
compatibility bridge. The SDK package and alternate backends follow in later deliveries. These
foundations do not expose a new public SDK or change installed storage authority.

## Ownership

| Component | Owns |
|---|---|
| Shared foundation | Error identity, serialization and existing outcome classifications |
| Kernel | Workflow transitions, requirements, evidence rules and authority evaluation |
| Engine SDK | Registered operation dispatch, coordination, context manifests and recovery planning |
| SDA | Namespaced records, revisions, transactions, receipts, integrity and storage implementations |
| SGOS | Execution attempts, processes, leases and operational recovery |
| World Model | Knowledge and AST retrieval behind an engine port |
| Source-control adapter | Source commits, branches, pushes and worktrees |
| Host adapters | UI, CLI flags, JSON compatibility projections, safe command guidance and model prompts |

The shared foundation is a dependency of both engine and SDA; SDA does not import an engine
package to acquire common errors. The foundation lives in `src/foundation/`, which already ships
with the existing Node package. Package extraction follows once the operation boundary is proven.

## Namespace contract draft

A record is identified by a stable project scope, namespace and logical key. Laptop paths, Git
branch names, SQL tables and credentials belong to adapter configuration. A project can contain
several repositories; a Story records its repository participants and their source bindings.

| Namespace | Contents and owner |
|---|---|
| `config` | Immutable approved configuration versions and the approved pointer |
| `state` | Lifecycle aggregates, human decisions, events and operation receipts |
| `evidence` | Artifact manifests, integrity metadata and retained evidence references |
| `runtime` | SGOS attempts, leases and recoverable execution checkpoints |
| `local` | Machine-private drafts, caches and uploaded input document content |

`local` has a separate machine binding. Selecting shared storage does not upload local documents.
Stories pin the configuration closure they started with. Updating approved configuration affects
future Stories; an active Story changes its binding only through an explicit recorded operation.

The initial [namespace-store draft](NAMESPACE-STORAGE-CONTRACT.md) implements `read`, bounded
snapshot `list`, `transact`, operation inspection and integrity verification contracts. Snapshot
export/restore is a subsequent extension. This draft is exercised by conformance fixtures and
remains separate from installed production authority. It preserves:

- opaque revisions and explicit absent-record preconditions;
- conditional acceptance, without overwriting a moved revision;
- same operation ID and payload returning the original outcome;
- the same ID with different bytes being refused;
- atomic records, events and receipts within an explicitly declared transaction scope;
- distinct missing, unavailable, corrupt, conflict and unknown outcomes;
- immutable configuration and evidence bindings;
- namespace and project isolation, with no implicit cross-backend transaction.

An unknown external effect is reconciled by operation identity before retrying. A database
transaction cannot also atomically push application code to Git. Engine operations retain intent,
external-effect acknowledgements and their final receipt so they can resume after interruption.

Existing SDA `v1` contracts keep their names, capabilities, outcomes and production-adapter admission
rules. New namespace contracts and compatibility adapters must not silently modify those versions.

## Delivery phases

| Phase | Delivery and gate | Current status |
|---|---|---|
| 0 | Baseline the first extraction and identify existing ownership and compatibility contracts | First component baseline captured; the operation inventory grows with each later slice |
| 1 | Pure shared errors/outcomes, compatibility exports and transitive import guards | Implemented; qualification recorded below |
| 2 | Namespace identities, record/transaction contracts and shared conformance fixtures | Implemented as draft-1; 147 focused Mac tests passed, including unchanged Git conformance |
| 3 | Git compatibility adapter over the existing lifecycle/configuration authorities | Implemented as an internal native-port bridge; 214 focused Mac tests passed |
| 4 | Publication through the registry and SDK, with explicit CLI result projection parity | Implemented; 406 focused Mac tests passed |
| 5 | Submit, decisions, approve, advance, phase manifests and queries, one operation per slice | In progress: submission, approval, decision coordination/writers, standalone scope/routing/test/evidence/witness decisions, plan amendments/corrections, upstream issues/forward amendments and their list query, phase review and document manifests, document body reads, phase entry and its authoring read plan, local generation begin/reviewed rollover, draft and prepublication inspection, convergence advancement and shared post-transition effects extracted; portable asset inventory, remaining queries and preparation admission remain |
| 6 | Filesystem adapter for new projects, including crash/retry and concurrency qualification | Planned; declared access guarantees must pass conformance |
| 7 | Database/application adapter and installable headless Node runtime | Planned; a workflow must resume on another agent |
| 8 | Verified migration of existing projects and an explicit authority cutover | Planned; export, verification, old-writer fencing and reconciliation required |
| 9 | Remove obsolete direct accesses, qualify distribution and compare performance | Planned; preserve existing skill and CLI contracts during migration |

The [upstream operation boundary](ENGINE-SDK-UPSTREAM-OPERATIONS.md) covers author-raised issues,
owner decisions, forward proposals and decisions, downstream revalidation and the read-only list.
These routes keep their existing CLI output and native Git authority.

The [phase review query](ENGINE-SDK-PHASE-REVIEW.md) adds a narrow, provider-neutral read manifest.
It captures all retained members before reading and keeps missing files and changed local bytes
distinct from matched bindings. CLI rendering and terminal confirmation remain host concerns.

The [document body query](ENGINE-SDK-DOCUMENT-READ.md) resolves those retained references and the
existing catalog lookups through one registered reader. Local attachments remain local; query
results distinguish retained, catalog, snapshot and external provenance without laptop paths.

The [phase-entry operation](ENGINE-SDK-PHASE-ENTRY.md) coordinates binding, semantic admission,
optional composition, clarification and local task progress through the registry. Its public
manifest describes what an author should read; prompt wording and native command guidance remain
private integration presentation. A manifest is not a record that its resources were consumed.

The [generation-begin operation](ENGINE-SDK-GENERATION-BEGIN.md) establishes or verifies the native
local code-generation receipt. CLI and SDK use one coordinator; neither outcome publishes a
lifecycle event, runs tests, changes authority or records approval.

The [prepublication inspection](ENGINE-SDK-PREPUBLISH.md) uses the registry for its native check
and pure readiness/finding rules. Readiness admits an attempt; final publication bindings and
required tests are still checked by publication. Advisory owner/issue links and approval deadlines
remain explicit without becoming publication blockers.

The [draft inspection](ENGINE-SDK-DRAFT-CHECK.md) shares that inspection boundary and pure finding
rules. Its ready result describes authored-draft health, not publication admission; final worktree,
test and transaction checks stay with prepublish and publication.

The [reviewed rollover operation](ENGINE-SDK-GENERATION-ROLLOVER.md) previews exact changed bytes
and opens a local successor only for the matching current digest. Submitted generations retain
their authorized-rejection requirement; the installed publication remains immutable.

The test/evidence decision extension adds `decision.evidence-reuse`, `decision.visual-profile`,
`decision.test-narrowing`, `decision.test-risk`, `test-command.request` and `test-command.decide`.
The first four use the installed phase approvers; command requests remain distinct from human
acceptance or revocation. See [the decision boundary](ENGINE-SDK-DECISION-RECORDS.md#test-and-evidence-decisions)
for its request fields, target/current-phase binding and retained-request effect semantics.

Mac qualification for that extension on Node 26.12.0 passed 50 SDK/protocol/boundary checks,
9 native test/evidence journey checks, the Story-only command and configuration test-setup flows,
and 78 broader regression checks. All passed without skips or cancellations. The broader run
includes shared boundary rechecks, real source/bundled CLI parity, original standalone decisions,
combined decisions and a complete specification-through-release Story (111.7 seconds for that
journey). Test repositories and remotes are isolated; no real Story was changed.

`npm run check` passed 3,581 checks; VS Code typechecking, all 13 unchanged runtime bundle budgets,
Git ownership audit, npm dry-run packaging and whitespace checks passed. Five CLI rendering tails
are token-identical to the preceding commit and the five native record-writer files are unchanged.
The pure SDK closure is 11 modules / 118,681 input bytes with zero external imports. The gateway
remains at 852 modules within its existing limit. No Windows, hosted CI or provider runs were used.
This completes the test/evidence decision slice, not the remaining Phase 5 operations or storage
and embedding phases.

Each extraction includes relevant regression tests, typed results, error preservation and a smaller
legacy dependency boundary. Static and literal dynamic imports, re-exports, computed imports and
ambient host access are checked for components admitted as pure. Guard tests include a local
`require` binding because that spelling is a data parameter in the frozen SDA contract.

For the future public API, `engine.run(operation, inputs)` is the canonical entry. Typed helpers
derive from the same registry. MCP/model exposure is explicitly declared, and human authorization
remains enforced inside the operation. SDK actions are semantic data; host adapters render Shell,
Copilot and model-free guidance through the shared safe renderer.

## Existing authority and migration

[ADR 0018](adr/0018-sda-lifecycle-authority-options.md) keeps the Story branch as lifecycle authority,
the state branch as proof/projection and `sflow/config` as configuration authority. The Git
compatibility adapter preserves that layout. An alternate backend for an existing project requires
a superseding authority decision and a controlled migration:

1. Reconcile pending operations and establish a stable source boundary.
2. Fence old-authority writes and export records, configuration closures and evidence bindings.
3. Import and verify hashes, lineage, decisions, operation receipts and dependency closure.
4. Activate the new authority generation and prevent older clients from writing to the old one.
5. Retain the old authority as a read-only snapshot. After new writes, rollback needs verified
   reconciliation or reverse migration, rather than merely changing a connection setting.

No dual-write authority or silent fallback is introduced. SGOS operational state remains separate
from lifecycle authority even if both use one physical database.

## Foundation baseline and measurements

Before extraction, 28 focused tests passed on the unmodified implementation, including the newly
captured error serialization contract and existing utility/SDA-v1/architecture tests. Fresh imports
of the SDA contracts loaded utility infrastructure solely to acquire an error constructor.

Reproduce the component measurement with:

```sh
node scripts/engine-foundation-benchmark.mjs --samples=11
```

The first measurement used macOS and Node 26.12.0, with 11 fresh processes per entry and the Node
compile cache disabled. The OS file cache was not cleared. Module and byte counts are the static
bundle input closure; timings measure component imports, excluding process startup.

| Contract | Modules before / after | Input bytes before / after | Fresh-process median before / after |
|---|---|---|---|
| Shared state | 13 / 2 | 193,534 / 8,114 | 6.115 ms / 0.545 ms |
| Lifecycle authority | 14 / 3 | 197,440 / 12,020 | 6.276 ms / 0.664 ms |

Both contract closures now have zero Node builtin dependencies, previously eleven each. Existing
`util.mjs` and `outcome-classes.mjs` imports expose the same constructor, classifier and frozen
mapping objects as the foundation. The SGOS contract's direct error dependency also uses the
foundation; other SGOS transitive dependencies are intentionally not claimed as isolated yet.

These measurements do not establish Windows, cold-machine or complete-command latency gains.
Windows CI and live model qualification run only when requested. All lifecycle tests use isolated
machine state and fixture repositories; no real Story or installation is migrated by this phase.

The failure constructor and outcome vocabulary share one small module. Keeping them together
preserves the existing runtime module ceilings; no bundle limit is raised. The benchmark's one
bounded Node probe uses the existing central process boundary and has an explicit reviewed site
in `scripts/git-bypass-baseline.json`.

The first delivery's local qualification passed:

- 107 focused tests, with zero failures or skips, covering the shared contract, compatibility,
  dependency guards, SDA Git/memory conformance, cancellation and lost-response recovery, name
  ownership, SGOS records/public admission, utility behavior and startup closure parity;
- `npm run check`: 3,510 checks across the current 191 skills;
- `npm run vscode:typecheck`;
- all 13 VS Code runtime bundle budgets, without changing their limits;
- `npm pack --dry-run --ignore-scripts --json`: the extracted foundation and compatibility paths
  are included in the distributable package.

This is component qualification rather than the full product suite or an alternate-backend rollout.

## Phase 2 qualification

The namespace contract is implemented independently in `src/sda/namespace/`. Its reference adapter
is test-only, lives under `test/helpers/`, and is excluded from the npm distribution. It has no
production registration, no CLI entry and no installed authority selection path. Existing
production modules, SDA v1 contracts, Git/configuration stores and dependency locks are unchanged.

Mac qualification on Node 26.12.0 passed 147 focused tests with zero failures or skips. This includes
39 namespace contract/conformance tests, the existing Git ledger and lifecycle conformance cases,
and the Phase 1 regression set. Architecture guards now check the namespace contracts' complete
dependency closure and prevent production consumers from wiring this draft in prematurely.

Additional checks passed: `npm run check` (3,518 checks), `npm run vscode:typecheck`, all 13 unchanged
VS Code bundle budgets, and npm dry-run package inclusion/exclusion. The runtime bundles have the
same bytes and module counts as Phase 1. No Windows, hosted CI or live model runs were started.

Fast contract-only reproduction from the repository root:

```sh
node --test test/sda-namespace-contract.test.mjs test/sda-namespace-conformance.test.mjs
```

Production admission and any future authority cutover remain explicitly separate from this draft
and its in-process reference tests.

## Phase 3 compatibility boundary

The [Git compatibility adapter](GIT-COMPATIBILITY-ADAPTER.md) binds an explicit checkout and stable
project scope to the installed lifecycle, proof and configuration owners. Its pure descriptor names
those roles; the concrete adapter loads only the requested owner. Existing production routing stays
unchanged until the publication vertical slice in Phase 4.

This compatibility profile delegates native protocols, rather than claiming generic record-store
transactions over incompatible current authorities. Raw writes and cross-namespace atomicity are
not advertised. Existing SDA v1 descriptors, bytes, approval/identity checks, leases, journals and
recovery outcomes remain the owners' responsibility. The original Git conformance fixtures are
shared with the new adapter tests so that both paths exercise the same concurrent-writer,
lost-response, cancellation, pagination and integrity cases.

Phase 3 qualification passed on macOS 26.7.2 with Node 26.12.0:

- 214 focused tests, with zero failures, cancellations or skips (152.2 seconds). These cover the
  compatibility ports and unchanged namespace, foundation, SDA v1, lifecycle/proof, configuration
  proposal/service/activation, SGOS, dependency, name-ownership and startup regression suites.
- `npm run check`: 3,525 checks across 191 skills.
- `npm run vscode:typecheck` and all 13 existing VS Code runtime bundle budgets.
- npm dry-run packaging: both compatibility modules and their documentation are included; test
  adapters and fixtures are excluded.
- Staged diff whitespace validation.

Reviewed configuration activation preserved dirty application bytes and the index, required exact
review confirmation and protection acknowledgement, and retained the original Story configuration
commit. The native lifecycle/proof descriptors and refusal/recovery meanings are unchanged. The
compatibility descriptor consumes their protocol constants; native adapter IDs remain owned by
their original modules, with no additional name-ownership exception.

This is component qualification, rather than a full product or alternate-backend release. All Git
integration runs used isolated machine state and local fixture remotes. No Windows, hosted CI or
live provider qualification ran. Phase 4 is the publication SDK/registry vertical slice with explicit
CLI result parity.

## Phase 4 publication boundary

The [publication slice](ENGINE-SDK-PUBLICATION.md) adds `engine.run('phase.publish', inputs)` and a
typed helper over one versioned registry entry. The CLI uses that operation and owns its legacy
JSON/text projection. Kernel phase/generation/producer rules now have one pure implementation;
compatibility exports remain available, and publication command rendering stays in the host.
The existing generation transition has moved out of the aggregate into an explicit native
compatibility adapter, with the remaining aggregate dependencies named as collaborators.

The pure SDK has four static source modules, 33,510 bytes and no Node builtin dependency. Native
publication retains the installed Git authorities, receipts, actor checks, exact source/test/REV
bindings and recovery. SDK calls isolate inherited advisory read scopes so a long-lived host cannot
publish from its caller's stale preview. Alternate backends and standalone packaging remain later
milestones; no existing project is migrated by this slice.

Phase 4 qualification on macOS 26.7.2 with Node 26.12.0 passed 406 tests with no failures,
cancellations or skips (167.5 seconds). The slow publication journeys were explicitly enabled.
Coverage includes packaged/copied phases, source/CLI parity, fresh SDK mutation contexts, manual
imports, hidden test runners, code evidence, monotonic generations, REV, failed publication and
recovery, fault API compatibility, and source ownership/startup guards.

`npm run check` passed 3,533 checks across 191 skills. VS Code typechecking, all 13 freshly rebuilt
runtime bundle budgets, npm dry-run packaging and staged whitespace checks passed. Existing byte
and module ceilings are unchanged. The gateway has 846 bundled source modules, as before. The new
SDK/kernel/native compatibility modules and documentation ship in the Node package; tests do not.
Windows, hosted CI and live provider runs were not started.

The final build-identity check also covers the extracted intent rules and host renderer, so a
development receipt cannot survive a change to either owner. Its 25 focused SDK/startup/build
checks passed after that adjustment; the unchanged startup ceilings still pass.

Remaining milestones retain their original scope: the other registered operations and manifests,
filesystem storage, database/application embedding and standalone packaging, verified existing-
project migration, then removal/qualification of obsolete paths. Publication's 26 named legacy
collaborators remain explicit compatibility work rather than a claim that all engine rules have
already left the aggregate.

## Phase 5 submission delivery

The [submission slice](ENGINE-SDK-SUBMISSION.md) registers `phase.submit` and the distinct,
digest-confirmed `convergence.submit`. CLI submission and the private confirmed-advancement
callback enter those operations, as do the existing Node API's typed helpers. Decision-input
validation now has a pure kernel owner; its old exports remain compatible. The 788-line native
submission transition has left the aggregate with 43 named legacy collaborators. Its 111-statement
body was compared with Phase 4 and is unchanged except for import rebasing and collaborator binding.

Mac qualification on Node 26.12.0 passed a 159-test regression run and a separate 56-test journey
run, both with zero failures, cancellations or skips. The latter includes the complete fresh-clone
specification-to-release journey (94.7 seconds), with real local Git, executed tests, rework,
confirmed convergence and human-approval fixtures. Other coverage includes exact SDK/CLI retry
projection, stale-preview isolation, explicitly approval-free successor activation, source-review
refusals, branching/loops, native recovery, retention and test-command epochs. Fixture identities
are isolated from the developer; no live provider or remote CI is used.

`npm run check` passed 3,539 checks across 191 skills. VS Code typechecking, all 13 rebuilt bundle
budgets and npm dry-run package inclusion/exclusion passed. The gateway's module allowance admits
exactly the two extracted owners (846 to 848); all byte and other runtime ceilings are unchanged.
The Git audit moves one existing observation from the aggregate to the extracted transition,
without adding a Git call or a privileged owner. The pure SDK remains free of Node builtins.

Final receipt hardening also refuses a submission port that claims human approval was completed
under a required-approval policy. Its 21 SDK/startup cases, four real SDK parity journeys and ten
architecture/export/binding guards passed after the final edits, with zero failures or skips.

Phase 5 remains in progress. Its remaining deliveries are the complete decision/approval and
advancement operations, context manifests and queries, and the shared post-transition helper
ownership. Phases 6–9 retain their filesystem/database, standalone packaging, explicit migration
and obsolete-path/performance qualification requirements. No existing project or installed storage
authority has been migrated, and no branch has been merged or pushed for this refactoring.

## Phase 5 approval delivery

The [approval slice](ENGINE-SDK-APPROVAL.md) routes CLI and Node approval through `phase.approve`.
Registry definitions now own validation and execution as well as their public metadata. The pure
kernel owns authority/threshold rules and exact consent bindings; old authority imports remain
compatible aliases. The native evaluator and transition leave the aggregate with 33 named
collaborators, preserving the single preview/recording gate and its unchanged transition bodies.

Human interaction belongs to the host adapter. The SDK accepts neither caller-selected authority
nor executable decision data, requires the exact reviewed packet, and distinguishes a recorded
partial vote from a completed approval threshold. Native actor, presence, source/evidence, history
and final Story gates stay in force. Error identity and accepted/pending publication effects are
preserved; a headless invocation cannot silently confirm an unreviewed packet.

The 176-test Mac regression run passed with no failures or skips, including the complete fresh-
clone Story journey. The shared Git/namespace compatibility recheck also passed 102 tests. The
approval source guards now follow the real native owner and keep the same preview/recording and
hold-ownership obligations. The five real SDK approval integration cases passed after the final
edits, including partial thresholds, duplicate votes and unauthorized identities. The source gate
passed 3,547 checks; typechecking, rebuilt runtime budgets and package admission also passed.
The gateway allowance admits exactly its one extracted native transition owner (848 to 849),
with all byte and other module ceilings unchanged. Phase 5's remaining operations and helper ownership, followed by all
of phases 6–9, remain part of the migration objective.

## Phase 5 shared post-transition delivery

The [post-transition slice](ENGINE-SDK-POST-TRANSITION.md) separates native effect reports from CLI
warnings and recovery rendering. Approval and submission no longer import their command-layer
receipt, specification-usage or post-publication helpers. The existing helper paths remain aliases
for CLI compatibility. Headless Git hosts can observe and inspect bounded native diagnostics.

The 92-test Mac regression run passed with no failures or skips, including required receipt retry,
lost-outbox recovery, specification usage and an approval whose session refresh and notice observer
both fail after the exact approval commit. The source gate passed 3,550 checks; typechecking and
all rebuilt runtime budgets passed without raising a ceiling. This completes the shared effect
helper ownership, while decision admission, remaining operations/manifests and phases 6–9 remain.

## Phase 5 decision recording delivery

The [decision slice](ENGINE-SDK-DECISIONS.md) registers `decisions.record` for CLI and Node hosts.
Choice validation and batching have pure kernel owners; the SDK coordinates native effects and
preserves partial outcomes. The CLI keeps its answers-file, interactive confirmation, errors and
wire projection. Exact consent, per-effect identity and group checks remain mandatory. The native
writer functions still under command modules are explicit compatibility debt for the next slice.

The 68-test focused run and 33-test native journey run pass on Mac with no failures or skips,
including real SDK writes, CLI receipt parity, multi-phase decisions, plan amendment and the
existing approval/submission/publication integrations. The source gate passes 3,556 checks;
typechecking, all 13 rebuilt runtime budgets and packaging pass. The SDK's 11-module closure has
no external imports. Gateway source-map inspection
identifies exactly the three extracted pure owners (849 to 852 modules); byte and other runtime
ceilings are unchanged. Native writer ownership, remaining Phase 5 operations and all of phases
6–9 remain required; this delivery neither migrates storage authority nor completes the objective.

The next decision slice moves scope, completeness, applicability, routing, plan amendment, Node-pin
and obligation-risk writes out of command modules. Existing command paths remain aliases; native
and CLI hosts share the same record functions. Routing returns a structured local-effect report,
while its legacy adapter retains existing warnings and result fields. Real fault-injected SDK and
legacy routing both preserve their committed route when session activation fails. Its 34 focused,
54 regression and three selected fixture Node-pin tests pass on Mac with no failures or skips.
The four source/bundle parity tests also pass after making execution-mode selection independent of
inherited test settings. Source checks pass 3,560 checks; typechecking, packaging and all 13 runtime
budgets pass with no ceiling increases in this writer slice.
The remaining mixed decision handlers, advancement, manifests/queries and phases 6–9 are still open.

The registered decision port and combined-approval recorder now use native owners for their
remaining evidence-reuse, visual-profile, test-command, narrowing, test-risk and upstream-issue
effects. Seventeen writer/helper bodies and four now-pure approval selectors remain unchanged.
CLI handlers retain parsing/output and compatible helper exports. The own-or-next-step authority
rule and test-command self-approval policy remain distinct from general prior-step fallback.

The 38 focused, 95 native regression and 14 bundle/approval-gate cases pass on Mac without failures
or skips. A final four-case writer run also passes, including actual bundled test-command acceptance
without execution or phase advancement. Source checks pass 3,567 checks; typechecking and all 13
rebuilt runtime budgets pass without ceiling changes. Individual command routes, amendment
orchestration, advancement, manifests/queries, admission helpers and all of phases 6–9 remain open.

## Phase 5 advancement delivery

The [advancement slice](ENGINE-SDK-ADVANCEMENT.md) registers `convergence.advance` for CLI and Node
hosts. A read-only preview returns semantic review facts; exact consent coordinates the existing
`convergence.submit` operation under the same native Story lease. The source/fact/presence and
terminal gates, immutable submission binding and separate required human approval remain intact.
The CLI retains its text, preview JSON, malformed-flag error order and shared submission presenter.
The pure blocker rule and installed-layout readers retain their original function bodies.

Mac qualification passes 49 focused SDK/source/startup checks and 27 additional native CLI,
approval, decision and submission checks. The final 13-case run passes the complete fresh-clone
specification-to-release journey (98.9 seconds), including actual SDK/CLI preview parity, the
CLI's observed submission envelope, exact consent, rework, intent amendment, retained retry and
the native lease boundary. All these runs have zero skipped or cancelled tests. The two source
guards that still inspected pre-extraction owners now follow the actual publication/advancement
owners without weakening their obligations.

The full source gate, typechecking, all 13 rebuilt runtime budgets and package admission pass.
Gateway modules remain 852, the SDK remains 11 pure modules (100,909 source bytes, zero external
imports), and no startup or bundle ceiling increased. Keeping the blocker rule in the existing
pure phase-policy owner avoids adding a module to the common session read path. Test capture
only observes actual SDK and host results; it does not replace a domain outcome or change output.
No Windows, hosted CI, live provider, merge, push or real-project migration ran.

Individual command routes, amendment orchestration, manifests/queries and admission helpers are
still required for Phase 5. Filesystem storage, application/database embedding and packaging,
verified authority migration, obsolete-path removal and distribution/performance qualification
remain required in phases 6–9; advancement alone does not complete the objective.

## Phase 5 standalone decision delivery

The [standalone decision slice](ENGINE-SDK-DECISION-RECORDS.md) registers scope, completeness,
applicability, obligation risk and routing as five individual SDK operations. Their shared Story
admission and request normalization have a pure kernel owner. CLI functions forward to host
adapters for flag/file handling and output, and use actual SDK records and publication facts.
The original native writers still own their unchanged authority, presence, transaction, history,
binding and recovery behavior. The combined pending-list protocol continues to use those writers.

All 54 focused Mac checks pass, including five real default-SDK integration cases, CLI receipt
parity, unauthorized identities, another seeded workflow and committed routing despite failed
local session activation and observer callbacks. All 33 broader checks also pass, including
scope/checklist revisions, risk acceptance and headless SDK revocation, branching, bounded loops,
early completion, reopening, cancellation, bundled CLI parity and the complete fresh-clone Story
journey (98.5 seconds). Both runs have zero failures, cancellations or skips.

The source gate passes 3,574 checks; typechecking, all 13 freshly rebuilt runtime budgets and
package admission pass. The SDK remains 11 pure modules (109,063 source bytes, zero external
imports). No ceiling increased, and the gateway remains at 852 modules. Qualification used only
Mac and local fixture remotes; no Windows, hosted CI, live provider, merge or push was started.

Plan corrections, upstream issue and amendment orchestration, manifests/queries and admission
helpers remain Phase 5 work. Test/evidence and witness extensions are qualified separately. Phases 6–9 remain
required, including real alternate backends, headless packaging/resume, verified authority
migration and obsolete-access removal; these five operations do not complete the objective.

## Phase 5 witness delivery

The [witness extension](ENGINE-SDK-DECISION-RECORDS.md#witnesses-and-exception-renewals) registers
`decision.witness` and `decision.witness-exception`. They use the existing four-stage record
coordinator. The first binds the recording phase without changing the witness record format; the
second binds the requested approved phase and exact mapping, independently of the current phase.
Both keep the current phase unchanged. Their native writer owns the original evidence graph,
authority, file/context rechecks, approval/expiry checks and transaction bodies. The monolithic
witness command is now a forwarding adapter; native writers cannot be imported by host surfaces.

Mac qualification on Node 26.12.0 passed 51 focused SDK and boundary checks, 26 native witness,
verification and renewal checks, and 20 packaged/startup checks. The runs contain shared rechecks
and have zero failures, cancellations or skips. Native checks cover a failed witness, actual
packaged-CLI recording, actual CLI/SDK receipt parity, a stale file/context, duplicate prevention,
inspection before submission, unchanged observed test outcomes, and real SDK/CLI renewal of an
approved exception after the Story advanced. The original approval records and target generation
remain unchanged. A final import-guard recheck verifies the new native ownership boundary.

`npm run check` passed 3,585 checks. VS Code typechecking, all 13 existing runtime budgets, Git
ownership audit, npm dry-run packaging and whitespace validation pass. Both CLI output tails are
token-identical to their predecessors. The SDK closure remains 11 pure modules (120,298 input
bytes, zero external imports); the gateway remains 852 modules with no increased ceiling. All
Git remotes and Stories used for qualification are local fixtures. No Windows, hosted CI, live
provider, merge, push or real-project migration ran.

Phase 5's plan extension follows below; upstream issues and forward amendments, manifests/queries
and admission helpers remain. Phases 6–9 retain the full backend, embedding, authority migration and
distribution scope; this extension does not complete those milestones.

## Phase 5 plan amendment and correction delivery

The [plan boundary](ENGINE-SDK-DECISION-RECORDS.md#plan-amendments-and-reviewed-corrections) registers
`decision.plan`, `plan.correction.preview` and `plan.correct`. Narrow amendments still use the
unchanged native amendment writer. Approved-owner selection moves to the pure kernel; correction
coordination moves to the SDK's six-stage port. The native compatibility port retains approved-map
reads, row/verification validation, fresh-preview comparison and the existing conditional write.
The CLI owns the exact terminal presentation and its three existing result envelopes. Ordinary
headless calls can preview, but cannot fabricate the required live review or feed a grant/actor
through operation inputs. The existing authorization owner still consumes the one-time grant
inside the transaction after the fresh preview matches.

Mac qualification on Node 26.12.0 passes 63 protocol/boundary checks, 18 existing plan/terminal
checks and 13 initial native/startup/bundle checks. A final five-case native run covers all three
new SDK/CLI cases, a truly bundled correction preview, the undefined optional-row flag regression,
and both real wrong-path/test-only correction journeys. All pass with zero failures, cancellations
or skips. The concurrent-session case verifies that a newer correction survives and a stale
review never consumes consent. Capturing a detached review card cannot mutate the internal card;
plan approvals, generations, current phase and application drafts remain unchanged by a correction.

All three correction result envelopes and the amendment result envelope are token-identical to
their predecessors. The native amendment/Node-pin writer file is unchanged. Source checks pass
3,589 checks. VS Code typechecking, all 13 unchanged runtime budgets, Git ownership audit, dry-run
package inclusion/exclusion and whitespace checks pass. The SDK remains 11 pure modules / 129,334
input bytes with zero external imports; the gateway remains 852 modules. No ceiling is raised.
Qualification uses local fixture remotes on Mac; no Windows, hosted CI, live provider, merge,
push or real-project migration ran.

Upstream-issue and forward-amendment operations, phase manifests/queries and remaining admission
helpers still belong to Phase 5. Alternate backends, headless packaging/resume, verified existing-
project authority migration and removal/distribution/performance qualification remain in Phases
6–9. These plan operations do not complete the full migration objective.

## Phase 5 upstream issue and forward amendment delivery

Six [registered upstream operations](ENGINE-SDK-UPSTREAM-OPERATIONS.md) replace the remaining
upstream CLI coordination. Authors may raise issues and propose document amendments without
approval-group membership. Decisions retain the earlier phase's approvers; amendment decisions
require the exact confirmed amendment ID, and downstream revalidation uses that downstream phase's
approvers. The pure SDK captures the owner and generation binding before asynchronous resolution.
It retains a multi-issue batch's accepted prefix and remaining suffix on an error, without retrying
an unknown native publication or treating cancellation as undo.

The existing upstream writer remains shared with combined decisions. Its compatibility exports
keep their original return shapes; transaction helpers additionally expose native publication
acknowledgements to the registry. Forward amendment transactions, rollback paths and generation
publication finalization move from the CLI into an explicit native owner. The host retains all
seven original result envelopes, token-identical to their predecessors, and owns unowned-item
explanations and rendered recovery commands. No authority, record/hash version or Git layout
changes. Underlying legacy transitions still require later kernel/backend extraction.

Mac qualification on Node 26.12.0 passes 147 focused tests with zero failures, cancellations or
skips: 110 SDK/policy/boundary cases, 30 native/protocol cases and seven startup/import checks.
The native run includes existing upstream return, between-submission-and-approval, wrong-owner,
deduplication, supersession, completion and complete document-chain journeys. Three refreshed
native SDK/CLI parity cases also pass after adding independent author permission and a second
approved amendment: native SDK approval reaches generation 3, and the actually bundled CLI
revalidates the downstream phase against that generation. Source and bundled routes both write
through the registry; prior approvals and current draft bytes retain their native semantics.

`npm run check` passes 3,595 checks; VS Code typechecking, all 13 unchanged runtime bundle budgets,
Git ownership audit (2,010 existing sites), npm dry-run package inclusion/exclusion and whitespace
validation pass. The SDK closure remains 11 pure modules / 141,279 input bytes, with zero external
imports; the gateway stays at 852 modules. No budget was raised. All fixtures and bare remotes are
local and isolated; no Windows, hosted CI, provider, merge, push or real-project migration ran.

Phase manifests/queries and remaining admission helpers still belong to Phase 5. Phases 6–9
remain the filesystem/database adapters, portable package and cross-agent resume, verified
authority migration, and final removal/distribution/performance qualification. This delivery
does not complete or narrow those remaining milestones.

## Phase 5 phase-review query and document manifest delivery

`phase.review` is a registered read operation with a versioned, provider-neutral reference
manifest. Kernel selection captures the phase and all retained artifact/brief identities before
native reads. The final plan must include every captured member and keep its expected hash and
length. It cannot promote a dirty primary document or omit a missing retained file to claim an
exact submitted binding. Only observed byte integrity is reported; no prompt, artifact body,
human consent or approval is returned. Submitted brief-list selection has one pure kernel owner,
shared with the existing native document registry, with its strict generation semantics intact.

The Node API and `phase show` use a narrow query composition; its first read does not import the
publication composition or legacy dispatcher. The full native composition provides the same
registered port and semantic result. The CLI projects its private legacy review, with its rendering
tail token-identical to the preceding commit. Its interactive terminal-review record stays in the
host after display; SDK and JSON reads never create one. Overall native errors keep their original
identity; per-file native details/causes remain visible, including real ENOENT and injected EACCES
stat failures. Existing legacy error messages and serialized formats are unchanged.

Mac qualification on Node 26.12.0 passes 102 focused checks with zero failures, cancellations or
skips: 47 protocol/display/architecture/startup cases and 55 native/integration cases. The latter
cover source and actually bundled CLI queries, missing/tampered retained files, scoped references,
draft/preview limits, input and brief integrity, the document lifecycle, SDK submission/approval,
partial approval thresholds, stale choices, one human ceremony and terminal-specific confirmation.
The final protocol run also verifies that inherited object keys are not phases, while an explicitly
declared phase named `constructor` remains valid. No real Story or installed workspace was changed.

`npm run check` passes 3,600 checks. VS Code typechecking, all 13 unchanged runtime bundle budgets,
Git ownership audit, npm dry-run package inclusion/exclusion and whitespace checks pass. The SDK
closure remains 11 pure modules / 150,009 input bytes with zero external imports. The gateway stays
at 852 modules; no ceiling is raised. All repositories/remotes are isolated local fixtures. No
Windows, hosted CI, provider, merge, push or real-project authority migration ran.

This query does not complete Phase 5. Phase entry and its authoring-context manifest, document-body
queries and remaining admission helpers still require extraction. Phases 6–9 retain their full
alternate-backend, portable runtime/resume, authority migration and final qualification scope.

## Phase 5 document-body query delivery

The registered [document reader](ENGINE-SDK-DOCUMENT-READ.md) resolves both the phase manifest's
scoped references and existing catalog ID/name/path lookups. SDK coordination captures Story,
phase, generation and retained hashes before asynchronous resolution. Pure kernel rules validate
the resolved binding and UTF-8 body budget, then distinguish retained/catalog bindings from current
snapshots and external links. The native port shares the phase-review reference inventory and
uses the installed canonical scope/hash/local-storage readers. Its request-local catalog cannot
change mid-read. Final text/Office bytes must still match their observed hash and length; a read
race cannot return a body with an earlier snapshot's verified identity.

`documents view` now parses and renders in a narrow host over that registry operation. The legacy
view entry forwards to the same handler; non-view document operations retain their existing route.
Its rendering tokens match the predecessor, and actual source/bundled CLI JSON retains its native
shape, paths, full configured previews and Office extraction display. The public SDK has bounded
domain content and opaque reference metadata, without physical paths or any terminal consent.
Local text/images/Office originals stay local. A second clone receives the original upload/restore
request and can continue the existing Story after exact local restore, with no lifecycle commit.
Existing Git authorities, human approval rules, records, hashes and normal CLI outcomes are unchanged.

Mac qualification on Node 26.12.0 passes 150 focused checks with zero failures, cancellations or
skips: 69 protocol/kernel/architecture/startup checks and 81 native, document and input regression
checks. They cover actual SDK/CLI receipt parity, source and genuinely bundled routes, reference
and generation binding, dirty/missing files, text changing between snapshot and read, local image
and Office handling, URL non-fetching, detached inputs, clone takeover/restore, submission, approval
thresholds and human confirmation. The three native reader journeys also pass a final rerun with
an added mid-read catalog-change refusal, without retry or publication. No real Story was changed.

`npm run check` passes 3,609 checks. VS Code typechecking, all 13 unchanged runtime bundle budgets,
Git ownership audit (2,010 existing sites), dry-run package inclusion/exclusion and whitespace checks
pass. The SDK closure is 12 pure modules / 159,851 input bytes with zero external imports. The
gateway remains 852 modules / 6,738,990 bytes; no ceiling is raised. The dry-run package contains
9,470 files, including the new owners and contract document and excluding tests. All repositories
and remotes are isolated local fixtures; no Windows, hosted CI, live provider, merge, push or
real-project authority migration ran.

Phase 5 still requires phase entry, its authoring-context manifest and remaining admission
coordination. Phases 6–9 retain their complete filesystem/database adapter, portable runtime and
cross-agent resume, explicit verified authority migration, and final removal/distribution/
performance scope. This delivery does not complete or narrow those remaining milestones.

## Phase 5 phase-entry and context-admission delivery

The registered [phase-entry operation](ENGINE-SDK-PHASE-ENTRY.md) owns the ordered binding,
inspection, optional composition, clarification and local-checkpoint stages. Kernel policy owns
composition admission and the entry/clarification outcome. The private native port retains
observation, prompt delivery, exact issued staging paths, task records and the original CLI
presentation. Public results contain semantic admission facts and a versioned read plan, with
captured upstream generations/hashes, local-document availability and clarification answer
bindings. They contain no prompt bodies, laptop paths or shell-command wording. Explicit SDK
roots cannot be redirected by the machine's selected workspace.

The original entry and authoring-entry exports forward through this operation. Paused and
unbound requests stay lightweight. Complete clarification records are reused; missing answers,
stale bindings, interrupted tasks, exhausted budgets and missing local documents retain their
existing repair/human routes. Native errors preserve identity, cause and recovery, with optional
stage/effect diagnostics for interrupted entry. No stage is automatically retried or treated as
rolled back. Entry does not execute tests, publish, approve or advance a Story.

Pure input policy also owns clarification normalization and checkpoint classification.
Configuration and SKP validation no longer import native clarification-record I/O to normalize
that policy. Compatibility aliases retain the same constructor, defaults, values and messages.
The installed Git authorities, native records/hashes and public CLI meanings remain unchanged.

Mac qualification on Node 26.12.0 passes 330 checks with zero failures, cancellations or skips:
223 native/integration checks and 107 SDK/policy/boundary/startup and Git-compatibility checks.
The native run covers source and genuinely bundled CLI parity, explicit-root isolation,
required/stale/malformed clarification records, retained generations, task progress/interruption,
budget recovery, local-document takeover and configuration/SKP/input validation. The existing
Git-compatibility suites also pass their concurrent-write, cancellation, lost-response, integrity,
review-confirmation and dirty-application preservation cases.

`npm run check` passes 3,617 checks; VS Code typechecking, all 13 unchanged bundle budgets,
Git ownership audit (2,010 existing sites), dry-run packaging and whitespace checks pass. The
pure SDK closure is 15 modules / 187,008 input bytes with zero external imports. The gateway
remains 852 modules / 6,739,652 bytes; no ceiling is raised. The dry-run package contains 9,476
files, including the new owners and documentation and excluding tests. All repositories and
remotes are isolated local fixtures. No Windows, hosted CI, live provider, merge, push or
real-project authority migration ran.

This delivery does not finish Phase 5. The portable prompt/asset inventory, preparation/code-
generation/prepublish admission, remaining queries and native-rule extraction remain. Phases
6–9 retain their full filesystem/database adapter, installable headless runtime and cross-agent
resume, verified authority migration, and final removal/distribution/performance scope.

## Phase 5 local generation-begin delivery

The [generation-begin operation](ENGINE-SDK-GENERATION-BEGIN.md) places local begin/retry
coordination behind the registry, shared by CLI and SDK. It captures the Story, phase, exact next
generation and any open intent before awaiting native verification or a write. An idempotent
retry verifies and retains its original receipt. Local adoption remains subject to the existing
explicit digest, source-boundary and protected-path checks; a begin result does not establish
approval, test evidence or permission to bypass the edit guard.

The fifteen installed admission statements move from `state.mjs` to the existing native generation-
boundary owner, with twelve named legacy collaborators. Their tokens are unchanged. The native
draft transaction moves from a command helper into one compatibility owner, with a compatible
alias and token-identical body. Locks, preimages, rollback, journals, cursor capture and native
errors retain their meanings. CLI creation/retry output remains unchanged. Optional entry/begin
diagnostics cannot mask an original error with a frozen or read-only property.

Mac qualification on Node 26.12.0 passes 320 distinct focused checks without failures,
cancellations or skips, including 150 native publication/recovery fault checks and four complete
dirty-review repair journeys. The final 112-check rerun covers the narrowed native dependency,
source/bundled CLI parity, retained receipts, policy/feature-readiness checks, work intervals and
the error-diagnostic guarantees. The final import guard also restricts the extracted native
admission to its compatibility aggregate.

`npm run check` passes 3,620 checks. VS Code typechecking, the Git ownership audit (2,010 existing
sites), all 13 unchanged bundle budgets, npm dry-run packaging and whitespace checks pass. The
SDK remains 15 pure modules / 191,747 input bytes with zero external imports. The gateway remains
852 modules / 6,742,146 bytes; no budget was raised or runtime behavior externalized. The package
contains 9,478 files, includes the native owner/compatibility alias/documentation and excludes
tests. All machine state and local remotes are isolated fixtures. No Windows, hosted CI, live
provider, merge, push or real-project migration ran.

Preparation, rollover, draft/prepublish admission, the remaining queries and native policy helpers
still belong to Phase 5. Phases 6–9 retain their full alternate-backend, headless package/resume,
verified authority-cutover and removal/distribution/performance scope. The completed local begin
operation does not complete or narrow those remaining milestones.

## Phase 5 prepublication inspection delivery

`phase.prepublish` coordinates one accepted Story load and native inspection for CLI and SDK.
The kernel captures the inspection generation and decides the existing three readiness conditions.
Its provider-neutral manifest separates findings from advisories and local progress, and never
claims fresh tests, final transaction bindings, edit authority, human review or approval. Advisory
gaps retain their native approval deadline, upstream owner and issue references. An unknown
upstream owner is not reassigned to the detecting phase.

Finding identity/classification, source-review author conflicts, generation-needed and inspection-
generation rules have pure owners. Existing imports remain aliases; nine moved predicate/identity
bodies keep their predecessor tokens. The finding classifier retains its installed integrity,
scope/evidence, upstream and human-review priorities. The native checker and SDK share the exact
readiness rule. CLI display tokens are unchanged, and agent hook recording remains in the host.
The combined `--publish-if-ready` route still enters ordinary registered prepublish and publication
operations; publication performs its own final fresh checks.

Mac qualification on Node 26.12.0 passes 428 distinct focused checks across 26 files, with zero
failures, cancellations or skips. Coverage includes the 403-check broader run, final source/bundled
parity and combined-publication checks, all-phase draft/repair/guard tests, source-review lifecycle,
retained generations, submitted conformance and real upstream-owner/issue propagation. The final
57-check obligation run includes a complete honest-partial-verdict Story: SDK inspection preserves
the submitted bytes, reports the original implementation owner and UPI reference, and records no
approval. A binding test also proves that prepublish selection does not enumerate unrelated
retained artifacts or submission history.

`npm run check` passes 3,624 checks. VS Code typechecking, all 13 unchanged bundle budgets, the Git
ownership audit (2,010 existing sites), npm dry-run packaging and whitespace checks pass. The SDK
closure is 17 pure modules / 209,814 input bytes with zero external imports. The gateway decreases
from 852 to 851 modules / 6,742,656 bytes, without raising a limit or externalizing behavior. The
dry-run package has 9,481 files, including both new kernel owners, compatibility exports and this
contract documentation and excluding tests. All machine state and local Git remotes are isolated
fixtures. No Windows, hosted CI, live provider, merge, push or real-project migration ran.

Phase 5 still includes registered draft-check, preparation/rollover, the remaining queries and the
portable asset inventory/native policy extraction. Phases 6–9 retain their full filesystem/database
adapter, headless package/resume, verified authority-cutover and final removal/distribution/
performance scope. This inspection does not complete or narrow those remaining milestones.

## Phase 5 draft inspection delivery

`phase.draft-check` now uses one registered coordinator and the native Git inspection port for
CLI and SDK. It shares finding policy and observation projection with prepublish, while retaining
a distinct draft-health manifest. Ready draft health does not claim publication admission, fresh
tests, a verified transaction, human review or edit authority. Retained/submitted generations and
unknown upstream owners keep their original bindings; advisories and spent task budgets remain
observations. Prepublish keeps its existing check and task-observation sequence.

Mac qualification on Node 26.12.0 passes 336 focused checks across 23 files with no failures,
cancellations or skips. Real source and bundled CLI receipts agree with SDK execution. A native
fixture proves that a healthy draft stays distinct from a publication hold on staged files.
Existing Git compatibility tests retain concurrent-writer, lost-response, cancellation, integrity,
configuration review and dirty-worktree preservation coverage. Broader tests cover all-phase
draft/prepublish checks, repair loops, mutation guards, source review and a complete honest-
partial-verdict Story. The CLI renderer's 483 syntax tokens are unchanged.

`npm run check` passes 3,626 checks. VS Code typechecking, all 13 unchanged bundle budgets, the
Git ownership audit (2,010 existing sites), dry-run packaging and whitespace checks pass. The
pure SDK remains 17 modules / 211,450 input bytes with zero external imports. The gateway remains
851 modules / 6,742,680 bytes, without a ceiling increase. The package contains 9,482 files and
excludes tests. All machine state and Git repositories/remotes are isolated fixtures; no Windows,
hosted CI, live provider, merge, push or real-project migration ran.

Preparation/rollover, remaining queries and portable asset/native-policy extraction remain in
Phase 5. Phases 6–9 retain their full filesystem/database adapter, headless package/resume,
verified authority cutover and final removal/distribution/performance scope. This draft-check
delivery does not complete or narrow those remaining milestones.

## Phase 5 native convergence preparation boundary

The deterministic convergence service and its draft, projection, candidate-reuse and legacy-
migration helpers now have one native owner in `engine-compatibility/native-convergence.mjs`.
Both configured preparation paths reach it without importing the Story command module. The
Story service retains the same exported function identity and delegates its shared adjudication
helpers to that owner. All twelve moved function parameter/body streams retain their original
2,596 syntax tokens. Existing projection bytes, source seals, locked-state authority checks,
exact legacy confirmation, candidate selection and rollback remain unchanged.

This is a prerequisite boundary for registered preparation, not a new public operation or an
alternate storage authority. Provider execution and native persistence stay outside the pure
SDK; model wording, CLI rendering and human approval semantics do not move into it. Direct
native-owner imports are guarded, and build identity includes the new runtime source.

Mac qualification on Node 26.12.0 passes 158 distinct checks across 17 files with no failures,
cancellations or skips. Coverage includes a complete convergence Story, locked adjudication
authority, legacy source/archive seals, bounded assisted requests, candidate replacement,
plan-settled findings, repair routing, a full honest-partial-verdict Story and combined publication.
Structural guards now inspect the native function's actual syntax body rather than a stale
slice in the command module; their authority, locking and provider-budget assertions are kept.

Source validation passes 3,630 checks; VS Code typechecking, all 13 unchanged bundle budgets,
Git ownership audit (2,010 existing sites), dry-run packaging and whitespace checks pass. The
pure SDK remains 17 modules / 215,956 input bytes with zero external imports. The gateway stays
851 modules / 6,744,147 bytes, without a ceiling increase. Packaging includes the native owner
and excludes test helpers. All repositories, local remotes and machine state are isolated.
No Windows, hosted CI, live provider, merge, push or real-project migration ran.

Registered preparation, its portable result/asset inventory, remaining queries and native policy
extraction still belong to Phase 5. Phases 6–9 retain their complete alternate-backend, headless
runtime/resume, verified authority cutover and final removal/distribution/performance milestones.

## Phase 5 reviewed generation-rollover delivery

`phase.rollover` coordinates a native preview and confirmed local successor through the registry.
The kernel captures the selected Story/generations, validates the stripped digest plan and refuses
a stale confirmation before any authoring write. Native recovery planning still authenticates
the previous publication and routes submitted generations to authorized rejection. Previewing
does not grant edit authority, record human evidence or approve a phase. Confirmed begin retains
the installed draft transaction, source/protected-path checks, receipts and immutable publication.

The phase CLI no longer imports accepted-Story loading or generation/draft writers. It renders
the native preview and creation response and retains the existing filtered refusal envelope.
The SDK returns semantic identities/digests and local-effect facts without command strings or
model prose. Native errors keep identity, code, cause and recovery; interruption diagnostics
never mask frozen errors, retry an unknown effect or assert rollback. Existing local begin,
draft inspection and prepublish still agree across their source, bundled and SDK paths.

Mac qualification on Node 26.12.0 passes 271 focused checks across 13 files with no failures,
cancellations or skips. It covers genuine SDK/CLI rollover parity, changed current digests,
native publication/recovery faults, submitted-generation refusal, test-command successors,
mutation guards and unchanged published generation/index. Refusal checks preserve the existing
presenter's public contract. Production refusal and rendering meanings are preserved; creation
rendering retains its 57 syntax tokens.

`npm run check` passes 3,628 checks. VS Code typechecking, all 13 unchanged bundle budgets,
Git ownership audit (2,010 existing sites), npm dry-run packaging and whitespace checks pass.
The pure SDK remains 17 modules / 215,956 input bytes with zero external imports. The gateway
remains 851 modules / 6,744,101 bytes; no ceiling is raised. Packaging contains 9,483 files and
excludes tests. All machine state and Git repositories/remotes are isolated fixtures. No Windows,
hosted CI, live provider, merge, push or real-project authority migration ran.

Phase 5 still includes preparation, remaining queries, portable asset inventory and native policy
extraction. Phases 6–9 retain their full filesystem/database adapter, headless package/resume,
verified authority cutover and final removal/distribution/performance scope. This local rollover
delivery does not complete or narrow those remaining milestones.
