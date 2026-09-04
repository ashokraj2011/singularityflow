# Governed Delivery and Proof — milestone delivery roadmap

**Program ID:** `GDP`

**Contract namespaces:** `GDM` (delivery) and `PFC` (proof)

**Status:** GDP-M0 through GDP-M8 implemented; M9 local observation, M10 provider-neutral
contracts, and M11 readiness reporting implemented; enforcement, provider pilots, and GA evidence
remain external readiness work

**Roadmap baseline:** `main@0dd893c5`

**Created:** 2026-09-04

**Source proposal:** `SPEC-GDP-Governed-Delivery-and-Proof (1).md`

This roadmap turns the validated GDP proposal into reversible delivery increments. It corrects the
proposal's dependency order and keeps all early work non-blocking. Existing workflows, Stories,
office installations, model-free operation, optional AST use, and ordinary repository access remain
unchanged until a repository explicitly enrolls new work in a later milestone.

Planning ranges assume one primary developer with focused review and release support. They are
relative sizing ranges, not delivery commitments. Platform evidence, security review, or office
change-control lead time is additional.

## Outcome

GDP should eventually let the same governed Candidate and proof system support two delivery modes:

- **Workflow mode** follows an approved phase graph.
- **Outcome mode** pursues a bounded completion contract without manufacturing empty phase
  artifacts.

Both modes must produce the same Change Passport and evaluate the same proof predicates over the
same immutable Candidate. A model may propose work or summarize evidence, but it can never decide a
predicate, approve a Candidate, or publish authority.

## Non-negotiable boundaries

1. **One Candidate and publisher.** GDP reuses the SGOS Candidate and the existing recoverable Git
   publication unit of work. It cannot introduce a second commit, push, approval, or recovery path.
2. **Acyclic identities.** Predicate Results and Proof Summaries bind a stable proof subject; they
   never include the hash of a Passport that embeds those same results.
3. **Observe before enforce.** New proof families start in shadow or observe mode. Enforcement is
   available only to explicitly enrolled new work after the corresponding adapter is supported.
4. **No silent migration.** Existing and in-progress Stories keep their creation-pinned workflow,
   evidence ceiling, and approval contract.
5. **World Model reuse.** The shared state-branch World Model is reused. A Story may add a bounded
   Candidate delta; GDP never rebuilds the complete World Model merely because a Story starts.
   Missing or stale World Model data degrades to declared deterministic context and never blocks
   ordinary work unless an explicitly enrolled policy requires a named view.
6. **AST stays optional.** Missing, degraded, or unsupported AST capability cannot block ordinary
   Workflow or Outcome mode. An exact adapter may be required only by an explicitly enrolled
   enforcement profile that passed readiness before work began.
7. **Unsupported is honest.** Unsupported languages, test frameworks, runners, deployment systems,
   and evidence providers report `unavailable` or `inconclusive`; they cannot invent a pass.
8. **Signals are not verdicts.** Model output, telemetry, heuristics, and observations remain
   non-authoritative signals. Deterministic policy evaluates authoritative evidence.
9. **Provider-neutral release proof.** GDP cannot require GitHub Actions. Local and enterprise CI
   providers can issue authenticated receipts through the same contract.
10. **Private by default.** Raw prompts, source content, credentials, identities, and repository
    paths do not enter product telemetry or aggregate proof metrics.

## Corrected identity graph

The source proposal's Passport/proof references form a circular hash dependency. GDP must use this
acyclic projection before durable schemas are implemented:

```text
Candidate + Completion Contract + Policies + WMM baseline/delta
                              |
                              v
                     Proof Subject hash
                              |
             +----------------+----------------+
             |                                 |
             v                                 v
     Predicate Result(s)                 Gap/Signal records
             |                                 |
             +----------------+----------------+
                              v
                       Proof Summary
                              |
                              v
                       Change Passport
                              |
                              v
                 Approval / Publication receipt
```

The Passport may reference the immutable Proof Summary. Predicate Results and the Proof Summary may
reference the Proof Subject, but never the current Passport. Later observations create a new summary
and Passport revision rather than mutating either record.

## Release trains

| Release train | Milestones | User-visible result | Default behavior |
|---|---|---|---|
| R0 — Contract freeze | GDP-M0 | Reviewed, implementable contracts and ownership | No runtime change |
| R1 — Safe shadow | GDP-M1–M2 | Compatibility projections and read-only Passport | Disabled/shadow |
| R2 — Proof observation | GDP-M3–M4 | Deterministic proof and intent/test observations | Observe only |
| R3 — Bounded delivery pilot | GDP-M5 | Opt-in Outcome mode for a narrow pilot | Existing Workflow mode |
| R4 — Convergence | GDP-M6–M8 | Workflow/Outcome parity, durable execution, promotion UI | Opt-in per new work |
| R5 — High assurance | GDP-M9 | Supported exact checks for selected repositories | Observe unless enrolled |
| R6 — Runtime proof and GA | GDP-M10–M11 | Provider-neutral provenance and controlled GA | Policy controlled |

The shortest safe demonstration path is M0 → M1 → M2 → M3 → M5. It demonstrates one bounded
Outcome-mode change with an inspectable Passport without enabling exact-test enforcement or runtime
deployment claims.

## Milestones

### [x] GDP-M0 — Contract repair and ownership freeze

- **Landing commit:** `cb46359c`
- **Completed:** 2026-09-04
- **Evidence:** 5 GDP contract tests and 28 SGOS/Smart Init compatibility tests passed; repository
  conformance passed 1,277 checks; npm dry packaging included every contract, ADR, catalog, fixture,
  and schema. No runtime source, workflow, command, gate, or default changed.

**Planning range:** 1–2 person-weeks  
**Mutation boundary:** documentation, ADRs, schemas, fixtures, and failing contract tests only

Deliver:

- publish a corrected GDP specification on the current baseline with a named validator and decision
  owner;
- name GDP as the umbrella program and retain `GDM`/`PFC` as stable record namespaces;
- replace `recommend` as a delivery mode with `selectionStrategy: recommend`; restrict
  `deliveryMode` to `workflow | outcome`;
- define migration for current Smart Init metadata, including its `defaultMode` and
  `workflowProfile` fields;
- adopt the acyclic Proof Subject graph above and canonical serialization for every identity;
- create an ownership/supersession matrix covering SGOS, WMM, TCE, WEL, CAB, MIG, telemetry,
  approvals, and publication;
- define exact CLI namespaces, confirmation grammar, error codes, storage roots, branch authority,
  CAS layout, retention, transaction ordering, and recovery semantics;
- pin every companion contract and baseline by digest rather than by an unversioned document name.

Exit evidence:

- a reviewed vNext specification and accepted authority/storage/recovery ADRs;
- static tests reject cyclic references, ambiguous ownership, mode/profile category mistakes,
  unregistered schemas, and unbounded confirmation inputs;
- every proposed durable family has one writer, storage plane, migration owner, and reader policy;
- no production command, workflow, gate, or default changes.

Rollback boundary: documentation and unused schema fixtures can be removed without migrating user
state.

### [x] GDP-M1 — Compatibility inventory and runtime projections

- **Landing commit:** `7551d94f`
- **Completed:** 2026-09-04
- **Evidence:** 6 M1 projection tests and 5 M0 contract tests passed; repository conformance passed
  1,279 checks; no-model and cross-platform suites passed 27 checks; npm and VSIX packages contain
  the dormant projection module, schema, inventory, and documentation. Production CLI, API, and VS
  Code entry points do not import it, every GDP switch remains off, and no MIG family or durable
  record was added.

**Planning range:** 1–2 person-weeks  
**Depends on:** GDP-M0

Deliver:

- inventory current workflow, Auto, Ad Hoc, SGOS, approval, proof, Candidate, and publication paths;
- add pure, read-only projections from representative legacy records into the corrected GDP types;
- create fixtures for active, completed, reopened, cancelled, interrupted, and partially published
  work;
- record explicit `unavailable`, `legacy`, and `sunset-blocked` gaps instead of filling absent data;
- install all GDP feature switches as off, with no UI promotion or automatic enrollment.

Exit evidence:

- old work remains readable and behaves identically after upgrade, downgrade, npm installation, and
  VSIX installation;
- projections perform no Git, state-branch, filesystem, or lifecycle writes;
- no legacy evidence receives stronger assurance than it originally had;
- model-free and no-AST suites remain green on Windows, macOS, and Linux fixtures.

Rollback boundary: disable the projection reader; no durable GDP records exist yet.

### [x] GDP-M2 — Shadow Change Passport

**Landing commit:** `8d1f74fc`

**Implemented:** 2026-09-04

**Evidence:** 8 M2 shadow/CLI tests and the combined 19-test GDP M0–M2 suite passed;
cross-platform compatibility passed 319 checks; model-free boundaries passed 8 checks; repository
conformance passed 1,282 checks; VS Code typechecking and VSIX packaging passed. The packaged VSIX
contains the M2 command, schemas, documentation, and secondary diagnostic view.

**Implementation guide:** [`GDP-M2-SHADOW-PASSPORT.md`](GDP-M2-SHADOW-PASSPORT.md)

Delivered:

- registered only immutable v1 `proof-subject` and `change-passport` identities in MIG;
- added a deterministic, path-free in-memory Passport projection over verified M1 compatibility
  records and existing Candidates;
- exposed `change show [WORK-ID] --shadow` as an explicit read-only, never-model command;
- added the final, non-primary **Shadow Passport** tab to VS Code Diagnostics and `/sf-inspect`
  routing in Copilot;
- retained missing Candidate, policy, proof, AST, and World Model facts as non-authoritative gaps;
- added closed privacy-safe comparison summaries, 64 KiB output admission, 256-reference ceilings,
  schema/current-version checks, and reviewed lifecycle goldens.

No gate, approval, lifecycle writer, recovery service, or publisher consumes the M2 records.

**Planning range:** 2–3 person-weeks  
**Depends on:** GDP-M1 and the SGOS Candidate contract

Deliver:

- register only the minimum v1 families needed for Proof Subject and Change Passport identity;
- derive a read-only Passport for existing Candidates without influencing gates or publication;
- show subject, Candidate, policies, evidence availability, gaps, and provenance in diagnostics;
- expose the shadow view behind an advanced CLI flag and a non-primary VS Code diagnostic surface;
- compare shadow projections with existing lifecycle outcomes and capture privacy-safe aggregate
  mismatch categories.

Exit evidence:

- all Passport hashes reproduce across process restart, checkout path, and supported OS;
- no unexplained mismatch remains in the reviewed fixture corpus;
- no command, gate, approval, or publisher consumes the shadow Passport as authority;
- output limits and path redaction pass adversarial tests.

Rollback boundary: turn off shadow generation and delete only disposable local projections. Existing
Candidates and lifecycle state remain authoritative.

### [x] GDP-M3 — Deterministic proof kernel in observe mode

**Landing commit:** `6087ceea`

**Implemented:** 2026-09-04

**Evidence:** 11 focused M3 kernel/store/CLI tests and the combined 74-test GDP, command, help,
migration, and model-boundary suite passed; repository conformance passed 1,287 checks; the
no-model suite passed 8 checks; cross-platform compatibility passed 319 checks; VS Code
typechecking, npm dry packaging, and VSIX packaging passed.

**Implementation guide:** [`GDP-M3-DETERMINISTIC-PROOF.md`](GDP-M3-DETERMINISTIC-PROOF.md)

Delivered:

- registered nine immutable v1 proof record families with closed schemas and migration ownership;
- added a pure deterministic kernel with exact self-hashed inputs, outputs, reason codes, and
  transitive invalidation;
- implemented the accepted four-valued contract: `pass`, `fail`, `unavailable`, and
  `not-applicable` (correcting the stale `inconclusive` label previously present in this roadmap);
- separated semantic results from operational evaluation clocks and cache observations;
- added bounded append/retry/recovery storage on the existing subject transaction and private
  sidecar writers;
- exposed model-free `proof status`, `proof explain`, `proof gaps`, and `proof signals` diagnostics
  through the CLI, `/sf-inspect`, help, and the secondary VS Code Shadow Passport view;
- kept Signals, gaps, World Model absence, and all M3 observations outside lifecycle, approval,
  gate, recovery, and publication authority.

**Planning range:** 3–5 person-weeks  
**Depends on:** GDP-M2 and MIG schema registration

Deliver:

- add Predicate Specification, Predicate Result, Evaluation Receipt, Gap, Signal, Invalidation, and
  Proof Summary families using the Proof Subject identity;
- implement the four-valued result lattice: `pass`, `fail`, `unavailable`, and `not-applicable`;
- separate semantic identity from timestamps, latency, storage handles, and other operational data;
- enforce finite predicate count, input bytes, recursion, fan-out, fuel, deadline, and output limits;
- implement transitive invalidation and append-safe recovery through the existing durable writer
  and migration registry;
- present explanations and gaps, but make no lifecycle decision.

Exit evidence:

- repeated evaluation of identical inputs is byte-stable;
- stale, missing, contradictory, malformed, timed-out, and oversized evidence cannot become pass;
- Signals cannot satisfy predicates or gate work;
- concurrent writers, crash boundaries, migrations, retention, and recovery pass on the supported
  filesystem matrix;
- no Story duration or publication outcome changes when observe mode is enabled.

Rollback boundary: stop producing new observations; immutable records remain readable but
non-authoritative.

### [x] GDP-M4 — Intent, testability, and impact observations

**Planning range:** 4–8 person-weeks  
**Depends on:** GDP-M3, WEL-P0-001 alignment, and CAB-R0 ownership decisions

Delivered in `GDP-M4-INTENT-TESTABILITY-IMPACT.md`:

- registered five closed, immutable observation families and added bounded, deterministic builders;
- exposed clause/checklist/impact/environment/Surefire observations under the existing read-only
  `proof status` surface;
- added a narrow JUnit 5 binder that requires one unique source declaration, body digest,
  recognized oracle, and matching Surefire occurrence before reporting an exact witness;
- preserved skip, retry, lifecycle-hook, oracle, collision, unsupported-source, and rerun gaps;
- kept World Model, AST, unsupported frameworks, and missing evidence explicitly unavailable and
  non-blocking.

Original delivery contract:

- bind clause provenance, ambiguity, consistency, testability, boundary conditions, and declared
  non-functional intent to the Proof Subject;
- reuse WEL for witnessed clause observations and CAB for exact checker identity; do not create a
  parallel test authority;
- pilot one exact local adapter only—JUnit 5/Surefire for the reviewed supported subset—in observe
  mode;
- preserve suite, skip, abort, retry, teardown, collision, oracle, and nondeterminism gaps;
- allowlist environment facts and separate exact observations from estimates;
- reference one shared WMM baseline plus a deterministic Candidate delta and observed should-set;
- return `unavailable` for unsupported languages and frameworks without blocking work.

Exit evidence:

- zero false exact-test matches in the reviewed corpus;
- no suite failure, missing occurrence, retry ambiguity, malformed report, or changed Candidate can
  produce an exact pass;
- World Model and AST unavailability do not block existing workflows;
- office Java/Maven fixtures run on Windows, macOS, and Linux with approved proxy/offline settings;
- observation cost, false-inconclusive rate, and evidence growth are measured and accepted.

Rollback boundary: switch the pilot to disabled; ordinary module-level Code Delivery evidence
continues unchanged.

### [x] GDP-M5 — Bounded Outcome-mode pilot

**Implemented:** 2026-09-04

**Implementation guide:** [`GDP-M5-OUTCOME-MODE.md`](GDP-M5-OUTCOME-MODE.md)

Delivered:

- added deterministic recommendation, explicit digest-confirmed selection, Completion Contract,
  Effect Policy/compilation, risk, and autonomy records;
- constrained Outcome mode to one repository, medium-or-lower risk, no protected paths, external
  effects, or credentials, and the existing assisted Ad Hoc execution path;
- reused the existing Ad Hoc landing preview and recoverable lifecycle publisher as the sole
  preflight, commit, push, pending-publication, and recovery unit;
- writes all seven exact GDP records inside that one publication transaction, with exact readback
  validation before commit;
- preserved Workflow mode as the default and directed policy-forced work to the existing Story
  workflow without changing old or in-flight work.

**Planning range:** 3–5 person-weeks  
**Depends on:** GDP-M3, SGOS Candidate publication, Action Authorization, and current recovery UoW

Deliver:

- add Completion Contract, Delivery Selection, Effect Policy, Risk/Autonomy decision, and Promotion
  Preview records;
- reuse Smart Init to recommend a mode while requiring an explicit reviewed selection;
- run Outcome mode through existing Ad Hoc/Change Flight Plan and SGOS Candidate primitives;
- limit the first pilot to one repository, medium-or-lower risk, one retained Candidate, no
  protected-path changes, no external side effects, no credential use, and assisted/manual
  publication;
- require one exact preflight and confirmation before the existing publisher advances authority;
- show why completion is or is not proven in CLI and VS Code.

Exit evidence:

- one representative source-and-test change completes end to end with an inspectable Passport;
- cancellation, interruption, push rejection, ref race, changed bytes, and stale confirmation return
  to a stable recoverable state;
- the pilot never edits governance configuration on a work branch;
- disabling Outcome mode immediately returns new work to current Workflow mode;
- existing and in-flight work is unaffected.

Rollback boundary: prevent new Outcome selections and let retained pilots finish or explicitly land
through the existing Ad Hoc recovery path.

### [x] GDP-M6 — Workflow Passport and checkpoint compression

**Implemented:** 2026-09-04

**Implementation guide:** [`GDP-M6-WORKFLOW-PASSPORT.md`](GDP-M6-WORKFLOW-PASSPORT.md)

Delivered:

- added an opt-in, read-only `delivery workflow-status <WORK-ID>` projection for creation-pinned
  Feature and Bugfix workflows;
- derives the same Completion Contract, Effect Policy, Risk record, Proof Subject, and Change
  Passport shapes used by Outcome mode when exact inputs are identical;
- registers immutable Workflow Checkpoint Satisfaction receipts containing only bounded semantic
  hashes—never artifact content or repository paths;
- leaves custom, Chore, POC, benchmarking, and Initiative workflows unmapped and creation-pinned;
- keeps lifecycle, gates, approvals, publisher, World Model, and AST behavior unchanged.

**Planning range:** 3–5 person-weeks  
**Depends on:** GDP-M5

Deliver:

- map Feature and Bugfix workflows to the same Completion Contract, Proof Subject, and Passport used
  by Outcome mode;
- add deterministic workflow satisfaction receipts without creating empty phase artifacts;
- replace repeated large context with exact, bounded checkpoint references and compatible WMM views;
- prove Workflow and Outcome mode evaluate the same Candidate and predicate inputs;
- leave Chore, POC, benchmarking, Initiative, and custom workflows creation-pinned until separately
  mapped and validated.

Exit evidence:

- existing Feature/Bugfix fixtures remain byte-compatible and lifecycle-compatible;
- newly enrolled fixtures produce identical proof results for identical subjects in either mode;
- phase rewind, roll-forward, cancellation, and recovery preserve exact input identity;
- context compression never hides a gap, contradiction, approval, or changed source hash.

Rollback boundary: disable Passport consumption for new workflows; existing workflow state remains
the source of lifecycle authority.

### [x] GDP-M7 — Durable GEU v2 and Auto convergence

**Implemented:** 2026-09-04

**Implementation guide:** [`GDP-M7-SGOS-EXECUTION-BRIDGE.md`](GDP-M7-SGOS-EXECUTION-BRIDGE.md)

Delivered:

- bound GDP Delivery Selection and Completion Contract identities to the existing durable SGOS
  process, checkpoint, lease, stop/quiescence, retry, and recovery runtime;
- registered immutable Agent Execution Binding, Execution Checkpoint, and Steering Decision records;
- exposed `delivery execution-status <PROCESS-ID> --work-id <WORK-ID>` as a model-free view with
  the exact existing SGOS pause, stop, and recovery commands;
- permits steering records only as wrappers over an already-recorded SGOS control event—GDP cannot
  issue pause, halt, narrow, or success decisions by itself;
- kept old Auto sessions and non-enrolled work on their creation-pinned protocols.

**Planning range:** 4–8 person-weeks  
**Depends on:** GDP-M5, SGOS portable authority, and SGOS durable execution decisions

Deliver:

- add durable GEU events, checkpoints, steering, bounded stop/quiescence, and mandatory recovery for
  every state-writing execution unit;
- retain isolated Candidate worktrees and exact attempt/effect identities across process restart;
- route newly enrolled Auto work through GEU v2 while keeping old Auto work creation-pinned;
- make Workflow+Auto and Outcome+Auto share Candidate, budget, evidence, approval, and publication
  services;
- preserve the human's authority to pause, halt, reject, or narrow work before consequential effects.

Exit evidence:

- repeated pause/halt races, process death, stale executor writes, duplicate starts, and restart pass
  on Windows, macOS, and Linux;
- no late generation, submission, or success event occurs after quiescence;
- budget usage is durable and no model output becomes an execution verdict;
- old Auto sessions resume using their original protocol.

Rollback boundary: stop enrolling new GEU v2 processes; retain readers and recovery for already
created processes.

### [x] GDP-M8 — Promotion, migration, and primary product UX

**Implemented:** 2026-09-04

**Implementation guide:** [`GDP-M8-PROMOTION-AND-UX.md`](GDP-M8-PROMOTION-AND-UX.md)

Delivered:

- added read-only promotion preview, exact digest-confirmed handoff, and recovery/status commands;
- binds session, branch, HEAD, baseline, effect set, Delivery Selection, Completion Contract,
  destination Work ID, and Feature/Bugfix profile into an immutable transition record;
- reuses the existing Ad Hoc promotion checkpoint and preserves all application bytes; apply does
  not start a Story, commit, push, or weaken obligations;
- added a Delivery & Proof diagnostics tab showing delivery mode, profile, Contract, Proof Subject,
  Passport, checkpoint states, identities, and non-blocking gaps;
- retains an exact argv array for the reviewed Story start, avoiding shell-string execution and
  making interrupted handoff locally recoverable.

**Planning range:** 3–5 person-weeks  
**Depends on:** GDP-M6 and GDP-M7

Deliver:

- add preview/confirm/apply/recover flows for Outcome-to-Workflow promotion and explicit runtime
  migration;
- preserve Candidate, evidence, approvals, attempts, and proof subject across promotion;
- add Developer Home and VS Code views for mode, completion contract, Passport, predicates, gaps,
  stale inputs, effects, and safe next actions;
- add new CLI nouns without colliding with existing `start`, `run`, and `review` behavior; retain
  compatibility aliases where needed;
- make long operations background/resumable and always expose an exact terminal recovery command;
- require existing authority for push or consequential external effects.

Exit evidence:

- promotion and migration are plan-bound, digest-confirmed, idempotent, and recoverable;
- proof strengthening never silently weakens old obligations or upgrades old evidence;
- UI, CLI, skills, packaged VSIX, and npm runtime render the same state and next action;
- minimum/current VS Code and office-network exercises meet accepted responsiveness budgets.

Rollback boundary: hide new promotion entry points and retain exact recovery/read support for prior
records.

### [~] GDP-M9 — Opt-in high-assurance profiles

**Local observe profile implemented:** 2026-09-04

**Implementation guide:** [`GDP-M9-LOCAL-HERMETIC-OBSERVE.md`](GDP-M9-LOCAL-HERMETIC-OBSERVE.md)

Delivered without claiming enforcement readiness:

- a path-free, digest-only evaluator for executable change maps, changed-region coverage, witness
  independence, and mutation observations;
- five immutable v1 families registered with MIG, including explicit expiring human gap decisions;
- read-only `delivery assurance-evaluate`, which executes no product code, model, network, writer,
  lifecycle action, gate, or publisher;
- permanent `authority: none`, `mode: observe`, and `RUNNER_AUTHENTICATION_UNAVAILABLE` results
  until an authenticated runner provider is configured and separately approved.

Still required before M9 can be marked complete: authenticated runner isolation, signer/trust-root
validation, controlled reruns and N-version adapters, enforce-mode enrollment, multi-platform
security exercises, and accepted performance/false-result budgets.

**Planning range:** 6–12+ person-weeks  
**Depends on:** CAB-R1–R3, WEL-P0/P1, GDP-M8, and an authenticated hermetic runner

Deliver:

- add changed-region coverage, contract witnesses, witness independence, controlled reruns, and
  selected N-version checks only where their trust contract is approved;
- enroll only new work in a repository/profile whose readiness check proves adapter, runner, signer,
  trust root, policy, storage, and recovery availability;
- distinguish `verified-with-exceptions` from pass and require explicit, expiring gap disposition;
- keep unsupported repositories in disabled or observe mode.

Exit evidence:

- stale, self-authored, unauthenticated, uncovered, contradictory, or undispositioned mandatory
  evidence blocks only explicitly enrolled work;
- malicious code cannot access host credentials, unrelated workspaces, Git/container sockets, or
  undeclared networks;
- rollback to observe mode is proven for future work without reclassifying historical evidence;
- performance, storage, false-pass, false-inconclusive, and recovery budgets are accepted.

Rollback boundary: prevent new enforce enrollment and retain the authenticated record readers.

### [~] GDP-M10 — Build, deploy, and runtime provenance pilots

**Provider-neutral contract surface implemented:** 2026-09-04

**Implementation guide:** [`GDP-M10-PROVENANCE-CONTRACTS.md`](GDP-M10-PROVENANCE-CONTRACTS.md)

Delivered without claiming a provider pilot:

- immutable signed envelopes for build, provider environment, deployment, runtime identity, and
  production observations;
- exact issuer, audience, Proof Subject, Candidate, nonce, expiry, policy epoch, signer, signature,
  artifact, target, deployment, and runtime bindings;
- deterministic replay, revocation, expiry, issuer, audience, signature-digest, and provider checks;
- read-only `delivery provenance-status`, which reports unavailable until configured and continues
  to report no authority until an approved verifier implementation is injected;
- no built-in CI provider, no GitHub Actions dependency, no credentials, and no lifecycle consumer.

Still required before M10 can be marked complete: approved provider integrations and Secret Broker
bindings, cryptographic verifier deployment, outage/revocation/rollback exercises, privacy and
retention approvals, and reviewed signed production release receipts.

**Planning range:** 8–16+ person-weeks  
**Depends on:** GDP-M9 and approved enterprise identity/provenance providers

Deliver:

- add provider-neutral Build, Deployment, Environment, Runtime Identity, and Production Observation
  attestations;
- authenticate issuer, audience, subject, nonce, expiry, policy epoch, toolchain, artifact, target,
  and deployment identity;
- isolate credentials through the Secret Broker and keep sensitive payloads out of prompts and
  ordinary evidence;
- support expiring signed gap decisions and post-publication invalidation without rewriting history;
- pilot through approved local or enterprise CI; do not require repository-hosted GitHub workflows.

Exit evidence:

- source → Candidate → build artifact → deployment → runtime joins are cryptographically exact;
- replay, revocation, rollback, partial upload, provider outage, stale environment, and compromised
  issuer exercises fail safely;
- privacy, residency, retention, legal-hold, and deletion controls are approved;
- controlled production pilots produce reviewed signed release receipts.

Rollback boundary: stop accepting new provider attestations; historical records remain readable and
their expiry/revocation state remains enforceable.

### [~] GDP-M11 — General availability and duplicate-path sunset

**Readiness reporting implemented:** 2026-09-04

**Operator guide:** [`GDP-M11-READINESS.md`](GDP-M11-READINESS.md)

Delivered without claiming GA:

- read-only `delivery readiness` with a closed support matrix and per-milestone implementation
  state;
- explicit non-GA blockers for runner evidence, provider pilots, platform/package receipts,
  migration exercises, the observation window, and duplicate-path dependency proof;
- current runtime labels marked as labels rather than platform release receipts;
- hard `status: not-ready`, `gaReady: false`, `authority: report-only`, plus explicit prohibitions
  against enabling enforcement, accepting unverifiable attestations, sunsetting compatibility
  paths, or claiming GA from local tests;
- no legacy reader or writer removal.

Still required before M11 can be marked complete: every external blocker in the readiness report,
the agreed support-window evidence, reviewed release receipts, and an explicit GA decision by the
named authorities.

**Planning range:** 4–8 person-weeks after the support window  
**Depends on:** all milestones selected for the GA profile

Deliver:

- publish a support matrix for modes, languages, adapters, runners, CI providers, and assurance
  ceilings;
- bind clean-checkout macOS/Linux/Windows and supported Node/VS Code receipts to the npm and VSIX
  artifacts;
- make migrations resumable, auditable, reversible where promised, and no-op safe;
- sunset duplicate readers/writers only after dependency scans prove no supported runtime uses them;
- retain long-term readers and explicit `legacy`/`unavailable` states for historical records;
- publish operator, recovery, security, privacy, and office-installation guides.

Exit evidence:

- end-to-end Workflow, Outcome, Auto, promotion, recovery, and provider-outage journeys pass on the
  supported matrix;
- upgrade, downgrade, fresh-clone, old-state-branch, and interrupted-migration exercises pass;
- release receipts bind exact source, schemas, tests, packages, platform cells, and decisions;
- telemetry shows no unresolved critical mismatch during the agreed observation window.

Rollback boundary: the prior supported release remains installable and can read every durable GDP
record created by the GA candidate.

## Dependency and parallel-work map

```text
Contract/foundation: M0 -> M1 -> M2 -> M3
Proof lane:                       M3 -> M4 ----------------> M9 -> M10
Delivery lane:                   M3 -> M5 -> M6 ----+----> M8 -> M11
Execution lane:                       M5 -> M7 ------+
Release evidence:       captured at every milestone ----------------> M11
```

M4 and M5 may proceed in parallel after M3. M6 and M7 may proceed in parallel after the bounded M5
pilot. M8 requires both because migration and product UX must understand workflow state and durable
execution state. M9 and M10 are not prerequisites for a bounded non-enforcing Outcome-mode release.

## Milestone evidence packet

Every milestone review must include:

1. exact source commit and dirty-tree status;
2. changed schemas, migrations, writers, readers, commands, and configuration defaults;
3. compatibility fixtures and a downgrade/readability statement;
4. security, privacy, authority, and failure-mode deltas;
5. deterministic, no-model, no-AST, unsupported-language, cancellation, and recovery results;
6. npm and VSIX package verification when product code changes;
7. the supported platform cells actually executed—simulated cells must be labelled as such;
8. latency, memory, disk, evidence-growth, and remote-operation measurements appropriate to the
   changed path;
9. rollback command or feature-policy change and proof that it does not strand active work;
10. unresolved gaps, named owners, and the next milestone decision.

No milestone becomes `[x]` from a local happy path, self-review, model-generated assessment, or a
passing suite on one unsupported development runtime.

## Immediate next decision

GDP-M0 through M8 are implemented. The M9 local observation profile is available for contract and
integration exercises but cannot authorize a gate. M10 provider-neutral contracts are fail-closed
until an external approved verifier is configured. M11 readiness reporting is implemented and
continues to report not-ready. The next work is external evidence collection and explicit review;
authenticated provider pilots, M9 enforcement, and GA evidence must not be inferred from local
tests.
