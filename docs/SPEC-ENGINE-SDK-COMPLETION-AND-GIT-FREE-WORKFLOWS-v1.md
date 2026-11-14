# SFlow Engine SDK completion and Git-free workflows

- Specification ID: SPEC-ESK-001
- Version: 1.1 draft
- Date: 2026-11-14
- Implementation baseline: 230e2e5e48821f124db1ed9666e1a2117592385f
- Branch: codex/engine-sdk-foundation
- Status: implementation snapshot and proposed completion scope

Implementation update: the bounded sequential analytics/batch profiles, work-product contracts,
current-phase input repair and shared-only result replay are implemented on this branch. See the
[delivery record](ENGINE-SDK-GIT-FREE-DATA-WORKFLOWS.md) and [mandatory owner matrix](ENGINE-SDK-PHASE-5-7-COVERAGE.md).
That implementation does not close the original remaining Phase 5/7 owners or imply production
Git-free surface readiness.

## 1. Purpose

Define what the Engine SDK migration has delivered, what remains, and the additional acceptance
criteria needed for analytics and data-engineering workflows that do not use Git.

The product contract is:

**Requirement → acceptance criterion → work product → execution evidence → acceptance.**

A work product can be source code, a query, a dataset, a notebook, a document, a report or a
pipeline output. A project does not inherently require a repository, checkout, branch or Git identity.

This document records the baseline and the incremental implementation update above. It does not
claim that the branch is merged, installed, production-qualified or available through every
existing surface. Requirements without an explicit delivery record remain proposals, not claims
of existing functionality.

Current position: foundations and many qualified SDK profiles are delivered; Phases 5 and 7
remain partial, and Phases 8 and 9 remain pending. Git-free analytics/data-engineering reference
profiles are proposed additions. Copilot is the sole AI harness in the target product scope.
SField integration and direct model-provider execution are outside this completion scope.
Native Jenkins deployment remains a separate optional qualification workstream.

### 1.1 Status vocabulary

| Status | Meaning |
| --- | --- |
| Delivered for qualified profiles | Implemented with recorded qualification for explicitly named contracts; not universal workflow support. |
| Partial | A working subset exists; other required owners or integration paths remain open. |
| Pending | Not delivered to the stated completion criterion. |
| Proposed addition | Requirement introduced by this specification, outside the previously qualified baseline. |
| Optional extension | Separate deliverable; must not silently become another core migration blocker. |

A registered operation, an available binding, a source inventory entry and an executed
qualification are different observations. None alone proves complete product readiness.

### 1.2 Scope decision in draft 1.1

The product uses Copilot for AI-assisted authoring, analysis and review. Copilot owns the agent
loop, model selection and model invocation. SFlow owns verified workflow coordination,
requirements, evidence, phase acceptance and execution contracts.

The SDK, kernel, SGOS, SDA and Copilot integration remain separately owned components with
explicit contracts. Separation does not require deploying each component as a network service;
a host may compose them in process.

Deterministic operations, such as status, next-action computation, validation, persistence,
queries and configured test execution, do not need an AI call. A Git-free analytics workflow
can execute deterministically; any AI step uses the Copilot harness.

This revision withdraws the earlier optional SField bridge proposal from the current scope.
It changes the target design only; no current runtime integration is changed by this document.

## 2. Target architecture and ownership

| Component | Owns | Boundary |
| --- | --- | --- |
| Shared foundation | Record syntax, version dispatch, errors and outcome values | Independent of host I/O and model wording. |
| Kernel | Workflow transitions, obligations, traceability, evidence and authority rules | Evaluates explicit facts; does not invoke Git, a database, filesystem, provider or process. |
| Engine SDK | Versioned operation registry, coordination, context manifests, continuation and recovery | Public business operations enter one registry; trusted ports supply identities and effects. It does not own an agent loop. |
| SDA | Namespaced records, content, revisions, conditional transactions and receipts | Concrete backends preserve the same contract and conformance guarantees. |
| SGOS | Execution attempts, processes, ownership, cancellation, quiescence and operational recovery | Executes declared capabilities and returns actual outcomes. Copilot-backed AI execution and deterministic execution use explicit adapters. |
| Knowledge / World Model port | Knowledge, dependencies, AST and impact observations | Supplies versioned observations; a cache is not lifecycle authority. |
| Source-control adapter | Optional source commits, branches, worktrees and pushes | Git-specific identities and effects stay in this adapter. |
| Host adapters | CLI, VS Code, Copilot, MCP, workers and application presentation | Own prompts, safe command rendering, human interaction and authenticated actor bindings. The Copilot adapter owns harness integration. |

The knowledge port does not assert that a shared authoritative World Model is already installed.
Current knowledge facilities and future integrations must identify their actual provenance.

### 2.1 Logical storage

| Namespace | Contents |
| --- | --- |
| config | Approved workflow, agent, skill, instruction, constitution and dependency versions. |
| state | Stories, phase generations, decisions, approval bindings, lifecycle events and receipts. |
| evidence | Immutable artifact content, manifests, execution evidence and references. |
| runtime | Execution history, ownership and recoverable operation checkpoints. |
| local | Device-private drafts, caches, attachment bytes and local working material. |

Selecting shared storage does not upload local attachments. Configuration stays pinned to the
Story until an explicit recorded operation changes its binding.

Git has separate source-control and metadata-storage roles. A project can retain Git for source
code while choosing a different metadata backend. A project can also have no Git dependency.

### 2.2 Copilot integration direction

Interactive operation:

**Copilot harness → SFlow extension tools / MCP facade / CLI adapter → Engine SDK → kernel,
SDA and SGOS as needed.**

Copilot owns the interactive conversation and tool loop. A normal SDK operation does not
attempt to create or take control of a native Copilot chat.

Headless AI task, when that adapter is qualified:

**Worker → Engine SDK → SGOS execution contract → Copilot SDK/CLI adapter → Copilot harness.**

Deterministic task:

**Host → Engine SDK → SGOS process/test/data adapter.**

Copilot session/run identities must be linked to the corresponding SFlow task and attempt.
SFlow lifecycle records and actual execution receipts remain distinct from the harness's
conversation state. Kernels and SDK core remain independent of Copilot-specific package imports;
concrete harness dependencies belong to the integration adapter.

## 3. What has been delivered

Rows D-01–D-16 describe the baseline branch and its qualified profiles. D-17 records this branch's
new data delivery. They are not a production release checklist.

| ID | Capability | Status and practical limit | Evidence |
| --- | --- | --- | --- |
| D-01 | Shared errors, pure rules and import boundaries | Delivered incrementally; remaining native policy extraction is open. | [Migration plan](ENGINE-SDK-MIGRATION.md), [boundary guards](../test/architecture-boundaries.test.mjs). |
| D-02 | Versioned SDK registry and installable Node package | Delivered as a locally packable preview; package version is 1.0.0-alpha.0 and private. | [SDK package](../packages/engine-sdk/package.json), [SDK guide](../packages/engine-sdk/README.md). |
| D-03 | Namespace and transaction contracts | Delivered as draft-1 with conditional acceptance, immutable records, isolation and original operation receipts. | [Storage contract](NAMESPACE-STORAGE-CONTRACT.md). |
| D-04 | Existing Git compatibility | Delivered as an explicit native bridge; installed lifecycle authority and public behavior remain unchanged. | [Migration plan](ENGINE-SDK-MIGRATION.md), [native inventory](ENGINE-SDK-NATIVE-ENTRY-INVENTORY.md). |
| D-05 | Filesystem, SQLite and application-owned metadata storage | Delivered for explicitly bound namespace stores. SQLite stores SFlow metadata; it is not an analytics connector. | [Filesystem adapter](FILESYSTEM-NAMESPACE-ADAPTER.md), [application/SQLite adapter](APPLICATION-NAMESPACE-ADAPTER.md). |
| D-06 | Explicit project enrollment, approved configuration and Story creation | Delivered through namespace operations for supported bindings; installed surfaces do not automatically select them. | [Enrollment](NAMESPACE-PROJECT-ENROLLMENT.md), [configuration approval](ENGINE-SDK-CONFIGURATION-APPROVAL.md), [Story tests](../test/namespace-story.test.mjs). |
| D-07 | Prepare, enter, draft, publish, submit, approve and reject | Delivered for supported document and Code profiles; not every configured policy combination is portable. | [SDK guide](../packages/engine-sdk/README.md), [completion ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md). |
| D-08 | Human identity independent of Git | Application-authenticated approval is delivered for namespace profiles. Identity and confirmation are trusted host facts. | [Namespace approval](ENGINE-SDK-NAMESPACE-APPROVAL.md). |
| D-09 | Requirements, source review, plan accounting and conformance | Delivered for qualified specification, planning, Code and artifact profiles; universal non-software asset semantics are not established. | [Source review](ENGINE-SDK-NAMESPACE-SOURCE-REVIEW.md), [conformance/rework](ENGINE-SDK-NAMESPACE-CONFORMANCE-REWORK.md). |
| D-10 | Decisions, witness mappings, exceptions and upstream ownership | Many exact contracts are delivered, including source-bound decisions and original-owner renewal; remaining exceptions stay in the ledger. | [Decision/recovery delivery](ENGINE-SDK-NAMESPACE-DECISIONS-AND-RECOVERY.md), [witness mappings](ENGINE-SDK-WITNESS-MAPPINGS.md). |
| D-11 | Rework, source adoption, forward amendments and multiple-Code histories | Delivered for named return/revalidation profiles, preserving earlier approvals and actual producer ownership. | [Upstream returns](ENGINE-SDK-UPSTREAM-RETURNS.md), [multiple Code phases](ENGINE-SDK-MULTIPLE-CODE-PHASES.md). |
| D-12 | Bounded test recovery, risks, cohorts and qualified reuse | Delivered for supported full, selected and combined profiles. Failed tests remain failed; permissions do not create passing evidence. | [Selective recovery](ENGINE-SDK-SELECTIVE-RECOVERY-AND-QUALIFIED-REUSE.md), [latest failure/cohort delivery](ENGINE-SDK-FAILURE-COHORT-AND-EXTERNAL-RUNNERS.md). |
| D-13 | Source-bound impact selection | Delivered for qualified source/AST observations and pinned-script selection; arbitrary data lineage is not included. | [Impact and combined reuse](ENGINE-SDK-IMPACT-AND-COMBINED-REUSE.md). |
| D-14 | External execution | Pinned complete-command test and non-test adapters are delivered. Actual Python execution is qualified; arbitrary frameworks, warehouses and notebooks are not. | [External runner contract and qualification](ENGINE-SDK-FAILURE-COHORT-AND-EXTERNAL-RUNNERS.md). |
| D-15 | Headless journeys and takeover | Qualified software/document journeys run against three stores, including retained/shared-only replay and lost-reply recovery. This is not a qualified analytics or Jenkins deployment. | [Latest qualification](ENGINE-SDK-FAILURE-COHORT-AND-EXTERNAL-RUNNERS.md), [installed consumer](../test/engine-sdk-failure-runner-package.test.mjs). |
| D-16 | Local attachments | Shared metadata and exact resource references retain local-byte boundaries; missing required originals on another device have re-upload routes. | [SDK attachment contract](../packages/engine-sdk/README.md). |
| D-17 | Bounded Git-free data workflows | Retained work products, actual SQLite analytics/batch execution, current-phase human input repair and shared-only replay are qualified on all three metadata stores. Other connectors and production surfaces remain separate. | [Data delivery and qualification](ENGINE-SDK-GIT-FREE-DATA-WORKFLOWS.md). |

### 3.1 Current executable inventory

The operation inventory was executed for this specification without accessing a real Story,
opening a production store, starting a model or granting authority:

| Observation | Value |
| --- | ---: |
| Registered operations | 101 |
| Default native host bindings | 42 |
| Namespace bindings with private working stores, before optional execution | 94 |

The seven operations absent from that particular namespace composition are:

- plan.correction.preview
- plan.correct
- decision.visual-profile
- decision.test-narrowing
- phase.checks.run — requires explicit check execution.
- phase.repair.run — requires explicit repair execution.
- data.execute — requires explicit data execution, or a retained-only reader for existing outcomes.

The current delivery adds work-product.context, work-product.retain, work-product.amend and
data.execute. The registered vocabulary is shared; optional execution is not enabled by discovery.

Some native ceremonies have distinct portable contracts; optional executors can add bindings.
Each row needs an explicit disposition in the completion matrix. Absence here does not prove
that the underlying capability is universally missing, and binding availability does not prove
that a configured operation is ready.

The inventory explicitly reports qualificationExecuted=false, authorityGranted=false and
readinessEstablished=false. Reproduce it with:

```sh
node scripts/engine-operation-inventory.mjs --json
```

Older delivery notes contain earlier counts. Do not add historical test counts or use older
inventory totals as current status.

### 3.2 Recorded qualification at the baseline

The [latest delivery record](ENGINE-SDK-FAILURE-COHORT-AND-EXTERNAL-RUNNERS.md) reports:

- 969 distinct affected Mac checks across 118 files, with no failures, cancellations, skips or TODOs.
- 117 architecture checks, 37 native SDK/CLI parity cases and nine additional installed consumers.
- The unchanged original 34-check package qualifier passed alone in 24.5 seconds under its
  original 120-second parent / 60-second child limits.
- Source validation passed 4,448 checks; VS Code types, the 2,011-site Git audit and all 13
  unchanged bundle ceilings passed. Gateway modules remain 852/852.

These are recorded results from the implementation baseline, not a new execution of those
suites while writing this specification. They do not establish Windows, Jenkins,
analytics or data-engineering production readiness.

## 4. Phase status

| Original phase | Status | Remaining exit criterion |
| --- | --- | --- |
| 0: baseline and ownership | Baseline captured | Keep the current inventory and compatibility evidence reproducible. |
| 1: shared foundation | Delivered for extraction scope | Preserve contracts as later owners move. |
| 2: namespaces and transactions | Delivered as draft-1 | Stable-contract promotion belongs to final release qualification. |
| 3: Git compatibility adapter | Delivered for bridge scope | Preserve native behavior during subsequent cutover. |
| 4: publication vertical slice | Delivered for qualified profiles | Later policy combinations remain Phase 5/7 work. |
| 5: shared operations and rules | Partial | Remaining native queries/policies, exact capability mapping and final registered-path qualification. |
| 6: filesystem storage | Delivered for explicitly created stores | Installed-project migration is not included. |
| 7: database/application stores and headless runtime | Partial | Remaining runtime/evidence owners, complete declared-profile journeys and proposed Git-free reference profiles. |
| 8: existing-project migration | Pending | Export/import verification, reconciliation, writer fencing and explicit authority cutover. |
| 9: product cutover and qualification | Pending | Surface routing, obsolete-access removal, distribution, contract promotion and performance qualification. |

Completing the original software migration alone does not qualify analytics or data engineering.
Sections 6–8 define the bounded proposed addition to Phases 5, 7 and 9.

## 5. Original migration work still pending

These groups come from the active ledger. None becomes delivered merely because this
specification gives it a name.

| ID | Required work | Owner / phase | Exit evidence |
| --- | --- | --- | --- |
| R-01 | Enumerate and finish remaining native query/rule extraction and behavior parity. Source reachability is not execution qualification. | Kernel, SDK and adapters / 5 | An operation/profile matrix identifying native behavior, portable equivalent, exact compatibility exception and executed qualifier. |
| R-02 | Finish unsupported evidence-correction and application-revalidation combinations. | Kernel and SDK / 5, 7 | Frozen required histories pass with original evidence and owner attribution preserved. |
| R-03 | Finish namespace live application review/comparison and Story-wide document/evidence risk decisions. | SDK, kernel and execution ports / 7 | Actual execution/evidence, genuine human decisions and restart/takeover qualification. |
| R-04 | Finish the required framework/runner selection and toolchain-qualified reuse rows in the agreed coverage matrix. | SGOS and adapters / 7 | Source/toolchain identity, real structured results, separate permissions and conservative fallback. |
| R-05 | Connect required grounding, external design, skill/MCP host, person-presence, architecture, assurance, signing, integration and automated-execution owners. | Respective ports with SDK coordination / 5, 7 | Real evidence for every required supported profile; declarations or success flags are insufficient. |
| R-06 | Qualify final decisions, approval, rejection, continuation, interruption and cross-agent journeys. | SDK and kernel / 5, 7 | Complete registry-based journeys across filesystem, SQLite and application stores. |
| R-07 | Implement verified migration and single-authority activation. | SDA, SDK and host adapters / 8 | Reconciled pending effects, verified export/import, fenced old writers and an activation receipt. |
| R-08 | Complete host adoption, compatibility, packaging and performance qualification. | Host adapters and package owners / 9 | Public-entry-only routing, retained CLI/skill contracts and published cold/warm measurements. |

All original remaining owners remain in scope. Explicitly deferring one changes the claimed
completion scope; it does not count as implemented. New framework combinations outside the
frozen matrix are separate extensions unless they expose a defect in a supported contract.

## 6. Proposed domain-neutral core requirements

| ID | Requirement | Owner |
| --- | --- | --- |
| CORE-01 | A project MUST be enrollable and a Story executable without a repository, checkout, branch, Git executable or Git identity. | SDK and host composition |
| CORE-02 | Requirements and criteria MUST bind generic work products and evidence. Code locations, unit tests and screenshots MUST be obligations of applicable profiles rather than universal prerequisites. | Kernel |
| CORE-03 | Existing graph, phase-role, clarification, review, repair and authority rules MUST apply to supported custom phases without hard-coded software phase names. | Kernel |
| CORE-04 | Business operations MUST use the same versioned registry from SDK, CLI, VS Code, MCP and workers. Presentation and model prose remain in adapters. | SDK and hosts |
| CORE-05 | Optional source-control capabilities MUST be invoked only by profiles that declare them. A selected Git-free profile MUST NOT discover a repository or launch Git indirectly. | SDK and adapters |
| CORE-06 | Unsupported configured capabilities MUST return the actual missing owner and an actionable configuration, adapter, repair or human-decision route. They MUST NOT become successful empty output. | SDK and hosts |
| CORE-07 | Human identity MUST originate in an authenticated host port. Model arguments, database usernames and service-job identity MUST NOT manufacture a human approval. | SDK and kernel |
| CORE-08 | Settled clarifications, exact owner decisions and accepted receipts MUST survive phase changes and worker takeover. Revalidation MUST identify the changed binding rather than repeat an unchanged question. | SDK and kernel |
| CORE-09 | The engine MUST distinguish authored content, process success, data-quality success, reviewer acceptance and final workflow completion. | Kernel and SGOS |

Existing public meanings and accepted wire records remain unchanged. New domain meanings need
new explicit profiles or schema versions; a new asset kind must not be inserted silently into
an older closed schema.

### 6.1 Work-product and input reference contract

The proposed contract must represent the following facts. This is a contract requirement, not
an already accepted SDK payload:

| Fact | Required meaning |
| --- | --- |
| Logical identity | Stable project scope, asset ID and kind; physical paths are adapter locators. |
| Revision | Opaque version and the scheme that establishes it, such as content digest or dataset snapshot ID. |
| Observation | Actual observation time and consistency: retained content, snapshot, or explicitly live observation. |
| Content / locator | An immutable content reference or an authorized adapter reference; never embedded credentials. |
| Provenance | Actual producer operation/run, transformation or query revision and upstream references. |
| Evidence binding | Exact Story, phase, generation, configuration and criterion/obligation references where applicable. |
| Validity | Freshness, expiry, availability and relevant adapter capabilities. |

Kinds must cover document, report, query, notebook, dataset-snapshot, schema, pipeline-definition,
pipeline-output and source-code through versioned profiles. Native source-control references
retain their current meanings through compatibility adapters.

Live data must not be described as reproducible snapshot data. Where a source cannot retain a
snapshot, policy must specify the observation/retention limits and the human decision route.
Hashes of a query or schema alone do not establish which rows were analyzed.

## 7. Proposed reference workflow A: Git-free analytics

### 7.1 Bounded scope

Use one local, explicitly bound SQL data adapter with immutable input snapshots. The reference
implementation may use SQLite as its data source, kept separate from the SFlow metadata store.
It does not claim support for every warehouse, SQL dialect, notebook or dashboard system.

Phases:

1. Define the question, metric, input snapshot and acceptance criteria.
2. Analyze using an approved query revision and explicit execution context.
3. Validate the results and obtain the required human acceptance.

The query and metric definition are versioned through retained workflow content; they do not
need a source repository. AI authoring is optional.

### 7.2 Requirements

| ID | Requirement |
| --- | --- |
| ANA-01 | Retain the approved metric definition, query revision, input schema and actual dataset snapshot identity. |
| ANA-02 | Execute the query through an authenticated, read-only adapter with explicit timeout and result-size limits. |
| ANA-03 | Retain actual output, execution diagnostics and reconciliation/quality observations in their appropriate stores. |
| ANA-04 | Bind each acceptance criterion to its check result or genuine reviewer decision. A successful query does not imply metric acceptance. |
| ANA-05 | Refuse stale or mismatched evidence when the query, snapshot, metric definition or required policy changes. |
| ANA-06 | Retain exact duplicates, missing records, null handling and reconciliation tolerance outcomes; failed checks remain failed. |
| ANA-07 | Permit authorized current-phase repair without editing earlier accepted generations or silently changing approved metric meaning. Intent changes use explicit amendments. |
| ANA-08 | Resume review on another worker using shared accepted records. Missing required local originals retain exact re-upload bindings. |

The reference dataset includes known duplicates, missing values and a second changed snapshot.
Checks must demonstrate both successful acceptance and truthful correction-required outcomes.

## 8. Proposed reference workflow B: Git-free data engineering

### 8.1 Bounded scope

Use an immutable batch input and an explicitly versioned transformation to produce one
transactional SQL output dataset. Retain output schema, source-to-output provenance and a
stable batch identity. No repository or distributed orchestrator is required.

Phases:

1. Approve input/output contracts, transformation intent and data-quality criteria.
2. Execute the transformation and validate the candidate output.
3. Publish the output reference and obtain required acceptance.

### 8.2 Requirements

| ID | Requirement |
| --- | --- |
| DATA-01 | Bind each batch to actual input snapshot, transformation revision, output schema and execution identity. |
| DATA-02 | Check required keys, schema compatibility, completeness, duplication and reconciliation according to approved criteria. |
| DATA-03 | Repeating the same batch ID and payload MUST reconcile or return its original result without duplicating output. Different intent under the same ID MUST be refused. |
| DATA-04 | A crash after sink acceptance but before acknowledgement MUST trigger sink reconciliation using retained intent; it MUST NOT imply permission to repeat an uncertain write. |
| DATA-05 | Publishing lifecycle state and writing a data sink are separate effects unless one explicitly qualified transactional scope owns both. Never claim a cross-system atomic commit. |
| DATA-06 | A failed or partial output MUST remain identifiable. Promoting a valid replacement MUST preserve the previous evidence and decision history. |
| DATA-07 | A changed input or transformation MUST obtain the required fresh validation and authority. Previous passing counts alone cannot justify reuse. |
| DATA-08 | A new worker MUST inspect and continue the original batch and Story through shared records without the previous worker's filesystem or Git state. |

The reference sink needs an atomic data-write plus batch-receipt contract and a read/reconcile
operation. Qualification must inject loss of acknowledgement after the real sink commit.
Full-scale streaming, partition scheduling and arbitrary warehouse connectors remain extensions.

## 9. Execution, Copilot harness and Jenkins

### 9.1 Common execution boundary

Execution input must bind the project, Story, phase, generation, approved context references,
declared capabilities, budgets and required result contract. Trusted host ports select actor,
credentials, environment and permission. A model cannot grant itself another adapter or scope.

Execution output must distinguish:

- actual process/model/tool attempts and their original producer;
- artifacts and work-product references;
- check observations and failed/partial outcomes;
- confirmed, absent and unknown external effects;
- pending decisions and permitted continuation.

Model completion never records a phase approval. An elapsed timeout does not establish a DNS
failure or prove that a remote effect did not happen.

### 9.2 Copilot is the sole AI harness

| Mode | Agent-loop owner | Integration responsibility |
| --- | --- | --- |
| Native Copilot | Copilot | Preserve existing skills and supported extension-tool, MCP or standalone CLI entry routes; deliver exact approved context and permitted capabilities. |
| Headless Copilot SDK/CLI | Copilot runtime | Bind one declared SGOS task to an actual Copilot run, with explicit permissions, observations, cancellation, recovery and result attribution. This adapter still requires qualification. |
| Deterministic execution | No agent loop required | Use SDK operations and configured SGOS process, test or data adapters without starting an AI task. |

SFlow must not add another model gateway or model/tool agent loop in this completion scope.
The model selected within Copilot is the harness's concern. SField has no dependency or execution
role in this architecture.

| ID | Requirement | Owner |
| --- | --- | --- |
| HAR-01 | AI tasks MUST use the declared Copilot harness integration. Direct provider credentials and transports are not an alternative execution route in this scope. | Copilot integration and SGOS admission |
| HAR-02 | Kernel, SDK core and SGOS coordination MUST NOT own model selection, model invocation or another agent tool loop. | Architecture boundaries |
| HAR-03 | Deterministic operations MUST NOT start a model or harness session merely to compute status, next actions, validation results, persistence or configured checks. | SDK and SGOS |
| HAR-04 | Interactive Copilot entry and headless Copilot execution MUST be separate declared adapter modes with truthful capability/readiness reporting. | Host and execution adapters |
| HAR-05 | Native Copilot operations outside supported SFlow tools/hooks MUST NOT be reported as automatically observed or confined by SGOS. Supported enforcement paths need their own host qualification. | Copilot integration |
| HAR-06 | Link actual harness session/run identities to SFlow project, Story, phase, generation, task and attempt. Missing tokens/costs MUST remain unavailable rather than zero. | Adapter and execution records |
| HAR-07 | A lost response MUST reconcile the original harness run before launching another; cancellation acknowledgement MUST NOT substitute for evidence of quiescence. | SGOS and Copilot execution adapter |
| HAR-08 | Tool permission, harness completion and SFlow human acceptance MUST remain distinct. A harness response cannot supply a human vote or phase approval. | Kernel and SDK |
| HAR-09 | Existing supported Copilot skills and command projections MUST retain their compatibility during extraction. Structured context resources and completion checks remain shared SDK contracts. | Host adapters |
| HAR-10 | Copilot-specific packages and host APIs MUST be bound in the concrete integration, outside pure kernel and SDK core dependency closures. | Composition root and import guards |

Preserve prior accepted records and error meanings. A new active execution restriction must
use an explicit admission/profile version where it changes a previously accepted public
meaning; do not rewrite old runs or silently reinterpret their executor identity.

Both interactive and headless adapters must preserve the exact issued resources, applicable
change scope and actual completion state. Native chat qualification does not establish
headless execution readiness, or vice versa. Deterministic reference workflows remain usable
without invoking Copilot; any AI-assisted variant requires the appropriate Copilot mode.

### 9.3 Jenkins: optional deployment qualification

The headless SDK is a building block, not a completed production Jenkins integration. A first
pilot can bind one Story and source/input revision, run existing checks, retain exact results
and produce an acceptance-readiness report. An AI task in that pilot uses the qualified headless
Copilot adapter; an existing native VS Code chat is not a headless worker endpoint.

Before claiming Jenkins support, qualify:

- credentials and authenticated actor mapping;
- exact execution/source or dataset bindings and fresh report admission;
- retained state/content outside disposable workspaces;
- pipeline status mapping for ready, correction, human decision and unknown effect;
- interruption, duplicate build delivery and worker takeover;
- genuine human confirmation and current authority for acceptance.

A service account or a generic pipeline Proceed action cannot silently become a SFlow human
approval. Build success and requirement acceptance stay separately observable.

## 10. Migration and surface requirements

| ID | Requirement |
| --- | --- |
| MIG-01 | Existing Git projects keep their current authority until an explicit verified migration activates another authority. |
| MIG-02 | Export/import must preserve configuration closures, accepted records, content, hashes, lineage, human decisions and operation receipts. |
| MIG-03 | Reconcile pending external effects, fence old writers and activate one authority generation. No silent fallback or simultaneous competing write authorities. |
| MIG-04 | Recovery after new writes must use verified reconciliation or reverse migration; changing a connection string is not rollback. |
| HOST-01 | CLI, VS Code, Copilot and worker adapters must use the same project/Story binding and registered operation meanings. |
| HOST-02 | Project creation and intake must support non-repository projects without a mandatory clone, base-branch picker or Git identity lookup. |
| HOST-03 | UI wording must reflect the declared profile: dataset/query/output references for data workflows and source versions for software workflows. |
| HOST-04 | Context reads must use exact issued resource handles or paths, preserve budgets and provide specific missing/permission recovery. |
| HOST-05 | Next-action guidance must be structured and rendered consistently by each host. Unsupported host routes remain explicit rather than invented. |

Legacy command projections, record versions, authority rules, local attachment boundaries and
existing accepted hashes remain compatible unless an explicit new contract says otherwise.

## 11. Finite delivery packages and closure control

| Package | Scope | Completion evidence |
| --- | --- | --- |
| W0: freeze coverage | Enumerate operation/profile rows for R-01–R-06, exact native exceptions and required owners. Add CORE, ANA, DATA and HAR requirements to the proposed scope. | Every mandatory row has an owner, qualifier and status; no vague remaining-variants bucket. |
| W1: finish shared owners | Complete Phase 5 native queries/rules and domain-neutral requirements. | Registry parity, pure import guards and explicit capability mapping. |
| W2: finish existing portable profiles | Complete original Phase 7 evidence, review, execution and rework owners in the frozen matrix. | Actual supported-profile journeys and shared-only replay across three stores. |
| W3: Git-free reference profiles | Implement and qualify the two bounded reference workflows in Sections 7 and 8. | Real SQL/query and sink execution, quality failures, human acceptance and takeover with Git unavailable. |
| W4: verified authority migration | Complete Phase 8. | Export/import verification, interruption/reconciliation, old-writer fencing and activation evidence. |
| W5: host and distribution completion | Complete Phase 9, preserve Copilot as the sole AI harness and expose declared Git-free profiles. | Surface parity, Copilot dependency boundaries, package consumers, contract promotion, recovery and performance reports. |
| X2: Jenkins | Optional native deployment pilot. | Separate Jenkins execution, identity, retention and restart qualification. |

The phase ledger must reference exact W0 rows. Report progress as mandatory rows passed/open,
not as counts of commits, modules or historical test cases. Publish the same fixed denominator
until an explicit scope revision explains a change.

Additional warehouses, notebook systems, orchestration products and framework selection
strategies become named adapter extensions. They do not reopen core migration closure unless
they expose a defect in an already supported contract. Other AI harnesses, direct model-provider
integration and SField remain outside the current scope rather than unfinished core work.

Passing the analytics reference workflow alone permits an analytics-reference support claim.
Passing both references permits the stated bounded analytics/data-engineering support claim.
Neither permits a universal connector or distributed-platform readiness claim.

## 12. Acceptance and qualification

| ID | Required acceptance check |
| --- | --- |
| AC-01 | Install the packed SDK in an independent Node host; enroll a project, approve configuration and create a Story without Git or repository discovery. |
| AC-02 | Run custom phases and generic requirement/work-product mappings without imposing code paths, Git branches, screenshots or unit-test obligations that the profile did not declare. |
| AC-03 | Complete the analytics reference against filesystem, SQLite and application metadata stores, keeping its dataset binding independent of metadata storage. |
| AC-04 | Complete the data-engineering reference against the same metadata stores, including actual output and batch reconciliation. |
| AC-05 | Change query/transformation/input versions and demonstrate that mismatched or stale evidence cannot satisfy current obligations. |
| AC-06 | Inject interruption before execution, after execution, after sink commit and after lifecycle acceptance; retain original receipts and truthful unknown outcomes. |
| AC-07 | Exercise concurrent workers, duplicate operation IDs, changed payloads, lost permissions, fenced writers and changed human principals. |
| AC-08 | Perform human review/acceptance with application identity; service accounts and model outputs cannot fabricate a human vote. |
| AC-09 | Continue from a fresh worker using shared records; exact missing local attachments request matching re-upload, and retained decisions remain retained. |
| AC-10 | Preserve existing native Git outcomes, record/hash meanings, source/test attribution and CLI/skill compatibility for the frozen matrix. |
| AC-11 | Complete verified migration of a disposable existing project, including pending-operation reconciliation and rejection of old-authority writes. |
| AC-12 | Exercise supported CLI, VS Code and worker operations for a Git-free project without mandatory repository UI or Git subprocesses. |
| AC-13 | Assert exact resource handling, explicit errors and actionable recovery for missing input, permission refusal, timeout, corrupt state and unavailable adapter. |
| AC-14 | Retain original package deadlines and all existing bundle ceilings. Run the original package qualifier alone and report any failure rather than raising its limit. |
| AC-15 | Measure defined cold/warm scenarios with network, model, file, validation, process and storage timings separated. A synthetic test duration is not a product latency benchmark. |
| AC-16 | Verify the declared Copilot mode's task/context bindings, supported tool enforcement, interruption/reconciliation and actual result attribution. Qualify interactive and headless modes separately before claiming each supported. |
| AC-17 | Use rejecting harness/provider ports to prove deterministic status, next-action, validation, storage and configured-check operations make no model call. Dependency guards keep concrete Copilot APIs outside kernel and SDK core. |

The qualification report must name executed cases, host/runtime, backend, profile and source
revision. Inventory is not qualification. Fixture decisions use distinct authenticated test
principals and must not be described as a real customer approval.

Current execution authorization is Mac-only. Do not start Windows CI, hosted model runs or
production installation changes without a later explicit request. Mac results do not certify
Windows; cross-platform product claims require separately authorized native qualification.
Use existing skip policy, error handling and unchanged test/resource limits.

This specification is a scope and acceptance record. The separate
[data-workflow delivery](ENGINE-SDK-GIT-FREE-DATA-WORKFLOWS.md) identifies the implementation added
against it. Documentation validation must verify local references, inventory facts and patch
formatting; baseline suites must not be reported as freshly executed merely because they are
cited here.

## 13. Definition of done

The migration plus proposed domain scope is complete when:

1. Every mandatory frozen W0 row is implemented and qualified or an explicit scope revision
   changes the completion claim.
2. Existing software workflows preserve their accepted contracts and authority.
3. Both bounded Git-free reference workflows pass AC-01–AC-17 for their applicable profiles.
4. Existing-project migration and declared host cutover are qualified.
5. Package/storage contracts are promoted through an explicit compatibility decision rather than
   merely removing alpha/private labels.
6. Copilot is the sole AI harness, deterministic operations need no model call, and excluded
   SField/direct-provider integrations are not represented as pending core deliverables.
7. Optional native Jenkins and additional connector work is reported separately with truthful
   support claims.

Until those conditions hold, the accurate status is: **portable SDK preview with qualified
profiles; full migration and Git-free analytics/data-engineering product readiness remain open.**

## 14. Source records

- [Original engine migration plan](ENGINE-SDK-MIGRATION.md)
- [Active Phase 5/7 completion ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md)
- [Latest failed-risk/cohort and external execution delivery](ENGINE-SDK-FAILURE-COHORT-AND-EXTERNAL-RUNNERS.md)
- [SDK guide](../packages/engine-sdk/README.md)
- [Registry inventory and its limits](ENGINE-SDK-OPERATION-INVENTORY.md)
- [Native source entry inventory and its limits](ENGINE-SDK-NATIVE-ENTRY-INVENTORY.md)
- [Application/SQLite persistence](APPLICATION-NAMESPACE-ADAPTER.md)
- [Application-authenticated approval](ENGINE-SDK-NAMESPACE-APPROVAL.md)

These records are cumulative. Earlier delivery sections retain their historical scope and
measurements. The baseline and explicit evidence limits in this specification govern its status
snapshot; proposed future requirements are not implementation evidence.
