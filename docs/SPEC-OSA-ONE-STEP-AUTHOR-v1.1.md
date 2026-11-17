# SPEC-OSA v1.1 — One step author (revised)

| Field | Value |
| - | - |
| Product | Singularity Flow |
| Specification | SPEC-OSA |
| Version | 1.1, revised specification. Supersedes [v1](SPEC-OSA-ONE-STEP-AUTHOR-v1.md). |
| Date | 16 November 2026 |
| Status | Approved by the owner on 16 November 2026 ("yes and implement"), with three corrections applied in this text: the Node 22 landing rule (section 14), restored requirement and acceptance numbers (sections 11 and 12), and the incident-fix baseline counting the stop-the-loops work (section 13, Stage 0). **Stages 0 to 5 are built** ([docs/osa/README.md](osa/README.md)). **Still unqualified:** the heavy Node 22 run of the whole suite and the weekly Node 26 run after it; the live Copilot rows (the owner's daily paid Story run); a reversal to a pre-OSA build run for real; and the Stage 5 rows built beside it on `osa-v11-s5b` (VS Code's decisions card, the hook's alias lists, the remaining AC-019 cases). Limitations per row: [coverage-matrix.md](osa/coverage-matrix.md). |
| Approval history | v1 was approved on 16 November 2026. That approval does not stand in for implementation qualification. |
| Source baseline | Stage 0 resolves and records the actual starting commit on main. |
| Implementation plan | Included later in this document. |
| Companion contracts | SPEC-PHR (repair within the current step), SPEC-PSS (person-only steps), SPEC-SCF (shared context and authority). |

**Goal.** SFlow must give one consistent answer about three things:
- the current step;
- the work that is permitted;
- the next action.

This revision keeps the one-command authoring experience. It makes explicit:
- historical publication;
- local changes;
- shared authority;
- human consent;
- reviewer independence.

**Engine SDK.** The Engine SDK foundation work stays set aside. OSA is a separate change against the selected main baseline, and it does not require merging or continuing `codex/engine-sdk-foundation`.

**Normative language.** MUST, MUST NOT, SHOULD and MAY express requirements.

Names and schemas below describe target contracts. They do not claim that new operations or host capabilities already exist.

## 1 Problem and outcome

v1 describes repeated loops among:
- authoring;
- recovery;
- review;
- document display;
- session selection.

The cause is that several modules each decide on their own whether a version is open, whether edits are allowed, and which command runs next. The same Story can therefore receive incompatible instructions.

OSA replaces those separate interpretations with one pure decision owner that works from explicit, verified facts.
- The edit guard, phase entry, task completion and every surface consume that decision.
- A command adapter renders it for its host.
- An operation coordinator carries it out through the existing lifecycle gates.

**Outcome.**
- A person enters `/sf-code` or `/sf-phase`, completes the current step's agent work, and reaches a clearly named review, decision or approval boundary.
- Healthy authoring never takes a detour through recovery.
- Actual damage keeps its evidence and its recovery route.

## 2 Product decisions retained from v1

| ID | Decision | v1.1 implementation detail |
| - | - | - |
| D1 | `/sf-code` and `/sf-phase` are equivalent ways to work on any supported step. Existing writing names remain available. | Their phase-authoring entry uses the same coordinator. Parameterized or standalone commands retain their targets, arguments, scope and errors through compatibility adapters. |
| D2 | `/sf-next` performs the current step's agent work in the same turn and stops at a person's action. | It executes an authorized structured action for its exact target. It does not cross a phase, version or role boundary silently. |
| D3 | Starting a successor version always requires the person's yes. | The answer produces an authenticated, scoped receipt. Reconciling the same accepted opening reuses its receipt; it does not create another successor. |
| D4 | `/sf-recover` is for real damage, or an interrupted operation that needs reconciliation. | Failed checks, missing inputs, healthy published steps and normal running tasks receive their own actions. |
| D5 | The work command builds steps owned by SFlow automatically. | The configured deterministic operation runs with its actual checks and produces truthful retained results. |
| D6 | Local changes and accepted lifecycle facts have explicit sources of truth. Opening a version is shared immediately. | Working files describe local observations. An accepted shared record authorizes the opening. The Git adapter persists and publishes that record without committing unfinished application files. |
| D7 | A lifecycle action that moves work to another step ends the current turn's work. VS Code offers the next command for a new turn. | The rule applies to any change of bound phase, version, authoring session or actor role, including advancement after approval. |
| D8 | Work starts after the incident-fix baseline is ready. | Stage 0 verifies the named prerequisites. The original calendar statement is not evidence that they have landed. |

Copilot remains the only AI harness. OSA adds no direct provider integration, no SField dependency and no second agent loop.

## 3 Component ownership

| Owner | Responsibility |
| - | - |
| Fact adapters | Capture accepted lifecycle records, publication and review bindings, current authority and bounded local observations. Preserve original read errors. |
| Kernel decision owner | Pure evaluation of step state, publication predicates, authoring eligibility, next action and prerequisites. |
| Operation coordinator | Load a coherent basis, invoke the registered operation, recheck mutation conditions and return its actual outcome. |
| Storage adapter | Conditional records, operation receipts, immutable history and reconciliation. Git commit and push behaviour belongs here. |
| Execution owner | Actual builds, tests, app processes, reviewer tasks, cancellation and execution observations. |
| Copilot and host adapters | Command aliases, prompt wording, question tools, command rendering, UI, prefill and host capability reporting. |

**Where the decision owner lives.** The intended pure module is `src/kernel/step-state.mjs`, or the equivalent kernel location established in Stage 0. Main has no `src/kernel/` today; Stage 0 chooses the location. A lightweight compatibility re-export may preserve another import path.

The module's dependency closure MUST NOT contain any implementation of:
- filesystem access;
- Git;
- processes;
- network;
- a model provider;
- host commands.

OSA uses the existing registered operation path wherever its contract fits. Any additional logical operation is registered once and versioned explicitly. This separation does not depend on completing the paused SDK migration.

## 4 Fact and decision contracts

### 4.1 Step snapshot

`StepSnapshot/v1` is a bounded value assembled by trusted adapters. It contains:
- the project, Story and requested phase identity, plus the authoritative current phase;
- the accepted lifecycle revision, authority epoch, configuration revision and relevant source revisions;
- the last published version, publication digest, high-watermark, and an accepted open-version receipt when present;
- the exact review identity, version, artifact and source bindings, findings, dispositions and retained status;
- the actor, principal kind, role, applicable permissions, and independently obtained presence evidence when required;
- amendment, rework and hold facts, with their actual owner and permitted operations;
- the local checkout identity and relevant file observations, including drift from published bytes;
- the execution and task identity, progress, actual outcome, and supported host capabilities;
- a per-source observation status, with its diagnostic. Each source is one of: verified, not-created, missing, unavailable, stale or corrupt.

**Rules for facts.**
- An unavailable source MUST NOT be converted into an empty record, a permission grant or a successful readiness flag.
- `not-created` is valid only when the relevant authority establishes that the record is legitimately absent.
- Inputs from different Stories, phases, versions or revisions MUST NOT be combined silently.

**Rules for decisions.**
- Every decision carries its basis.
- A cached advisory decision can be displayed with its observed revision. Authorization and conditional acceptance are still checked fresh at a mutation boundary.
- A refresh reads the required authority refs or records, not every application branch or the Git history.

### 4.2 Pure projection

```typescript
stepState(snapshot: StepSnapshotV1): StepDecisionV1
```

The result contains:

```typescript
{
  schemaVersion: 1,
  subject: { projectId, workId, requestedPhaseId, currentPhaseId },
  basis: {
    lifecycleRevision, authorityEpoch, configurationRevision,
    publicationDigest, reviewDigest, openVersionReceiptId,
    workingObservationId, principalBinding, capabilityRevision,
    executionRevision, decisionSnapshotId, freshness, differences
  },
  kind: { executionOwner, changeCapabilities },
  state,
  version: { published, writing, highWatermark, proposedNext },
  publication: { hasPublishedVersion, hasOpenVersion, currentVersionPublished },
  edit: { eligible, scopeReference, permittedCategories, reasons },
  next: { actionId, kind, operation, inputs, target, principalKind, role, prerequisites, reasonCodes },
  task: { id, status, stage, progressReference, continuation },
  turn: { boundScope, permittedEffects, endOnScopeChange }
}
```

- **Schema.** The implementation MUST define exact types, bounds, supported versions and nullable fields.
- **Target.** `next.target` includes the logical project, Story, phase and relevant version. A route to the current phase from an inspected future phase must name the actual target.
- **What the kernel returns.** Operation identifiers, arguments, prerequisites and reason codes. It does not return:
  - shell strings;
  - Copilot skill names;
  - question wording for a person;
  - model prompts.
- **Rendering.** A host renders the decision using the central command map.
- **Principals and roles.** Human principals and agent principals are kept separate from roles such as author, reviewer and approver.

### 4.3 Publication and version predicates

| Predicate | Meaning |
| - | - |
| `hasPublishedVersion` | Accepted history contains at least one published version. |
| `hasOpenVersion` | An accepted, applicable opening receipt authorizes a current version that is not yet published or explicitly closed. |
| `currentVersionPublished` | The current candidate is the last accepted publication, and no applicable successor is open. This alone does not establish readiness for submission. |

**Example.** While version 2 is open and version 1 is published:
- the first two predicates are true and the third is false;
- historical version 1, its tests, reviews and approvals remain accessible;
- version 1 must not be offered as the current submission or review target.

**Version numbers.**
- `published` is the last accepted published number, or zero.
- `writing` is the number in the accepted applicable opening, or null.
- Before a new reservation, `proposedNext = max(published, highWatermark) + 1`. When an opening already exists, actions use its reserved number.
- Numbers are not reused after supersession or cancellation.
- All numbers must be bounded safe integers. Exhausted or inconsistent numbering gets an explicit diagnostic.

**The initial version.** An initial version needs no successor confirmation. It still needs either an accepted opening, or an existing verified initial-version record that a compatibility adapter normalizes to the same meaning. A local status field written by an agent cannot establish either.

**Existing helpers.** Each becomes a wrapper over the exact predicate its callers need. Replacing a historical-publication query with a current-publication query is a behaviour change, and is forbidden as a mechanical refactor.

## 5 State precedence and primary actions

**One primary action.** The decision exposes one primary action and its ordered prerequisites. Independent obligations remain visible; a primary action does not erase the others.

**Agreement.** Agreement compares the complete decision basis, including the principal and the applicable capabilities, not just the lifecycle revision.

**Rendering.** Host-specific renderings keep the same logical objective, and explicitly report execution modes they don't support.

**Prerequisites.** Prerequisites must be actionable for the actual principal and host. Unavailable authority cannot be solved by repeatedly offering the operation it refuses.

The evaluator applies this precedence, with focused tests for overlapping facts:

1. Validate scope, record families and required facts.
   - Mixed bindings or impossible accepted records are explicit errors.
   - Unavailable or stale facts produce a refresh or wait action.
   - Confirmed corruption produces a damage route.
2. Honour a valid cancelled or completed Story. Permit historical inspection without continuing authoring.
3. Preserve confirmed damage or an uncertain interrupted operation. Reconcile the original operation before any replacement action that could repeat an effect.
4. Honour current authorization, authority fencing, ownership and required presence. A hold names its real owner and its supported resolution. A hold on opening or publishing a version leads the action it blocks; one on submission is the submission's prerequisite (owner, 2026-11-17: an approved amendment's acknowledgement comes before the version question, section 7.1).
5. Honour an undecided amendment or any other required human decision that pauses authoring.
6. Honour a submitted version awaiting approval. It cannot be rolled over through the authoring command.
7. For an initial current step with no accepted opening or publication, open version 1 through the conditional opening operation, without successor consent. A nonzero high-watermark uses the actual proposed number and the successor-consent rule.
8. Continue an accepted open version, subject to required inputs, current execution state and scope.
9. Resolve required review-report repairs and dispositions. Product-content corrections then lead to successor confirmation.
10. For a current publication with no open successor, perform the remaining checks or review, or offer submission when ready.
11. For a future or approved step, target the actual current step or report completion, respecting the turn boundary.

| State | Primary behaviour |
| - | - |
| `not-started` | Name the actual current step and its next action. |
| `writing` | Continue the open version's authoring, checks or publication stage. |
| `kernel-build` | Run the declared deterministic build and its checks, then publish when ready. |
| `waiting` | Observe an active task, refresh required facts, obtain missing inputs or name the required environment action. |
| `published` | Run remaining required checks, or submit when its prerequisites are satisfied. |
| `in-review` | Start or continue the independent reviewer; repair its own staged report when necessary. |
| `review-ready` | Submit the exact reviewed version when all remaining submission gates pass. |
| `review-corrections` | Obtain successor consent for product-content corrections. |
| `reopened` | Obtain successor consent for rework or an adopted amendment. |
| `submitted` | Name the required human approval or rejection action. |
| `approved` | Name the actual current step's action, or completion. |
| `paused` | Name the required human decision. |
| `held` | Name the specific authority, ownership, policy or capability resolution. |
| `damaged` | Preserve affected work and reconcile or recover the exact damaged operation. |
| `complete` or `cancelled` | No authoring action; historical inspection remains available. |

**What does not count as damage.**
- An active execution is normally observed, not called damaged.
- A failed test is a repair outcome, not proof of damaged state.
- A malformed staged review report is repaired within the review task. On its own it does not require another authored product version.

**Stages within `writing`:** authoring, checking and ready-to-publish. The work command may advance through these stages in one turn, but it re-evaluates the basis at each consequential boundary.

## 6 Permission and guard consistency

**One basis for eligibility.** The entry, the edit permission and the real pre-tool guard MUST derive authoring eligibility and scope from the same decision basis.
- For an actor with the same verified basis, an otherwise valid authoring write inside the admitted scope is allowed exactly when the decision grants that write category.
- Negative cases stay explicit, and must be denied:
  - another phase's artifact;
  - an excluded capability;
  - a foreign repository;
  - a revoked permission.

**What the guard checks on every write.** The actual operation, target, checkout, path containment and current permissions. A decision explains eligibility; it is not a reusable authorization token. A revoked permission or a moved lifecycle revision invalidates an earlier grant, even if a screen still displays it.

**Application edits** remain limited to code-producing capabilities and their approved paths.
- A generic authoring command does not grant application edits in a document step.
- Existing monorepo, repository-participant and configuration-file classifications remain in force.

**Other writers.**
- An independent reviewer may write only explicitly issued review staging resources, and perform permitted review-record operations.
- Tests, app processes and evidence capture may write their declared execution outputs through their execution owner.
- Neither capability implies permission to edit the phase artifact or application source.
- Read-only review must not accidentally block its own exact staging or report route.

**Hand-edited published files** are preserved as local observations.
- Recovery first protects those bytes and identifies the accepted publication.
- Keeping the changes as a successor requires the normal consent and opening operation.
- Restoring the published bytes requires its own authorized recovery choice.
- Neither route may silently discard work or rewrite historical publication bytes.

## 7 Consent and opening a version

### 7.1 Proposal and human response

**The proposal.** A successor proposal binds:
- project, Story and phase;
- the actual last publication and its digest;
- the proposed number and the high-watermark;
- the reason;
- the configuration revision and the expected lifecycle revision.

**Who may confirm.** The confirming person must satisfy the existing version-opening permissions. This adds no approval group and no phase-approval vote. A question tool's presence, or a selected default, is not consent.

**Acknowledgement first (owner, 2026-11-17).** While an approved intent amendment waits for a person's acknowledgement, the person acknowledges it first, on the decisions card, and only then is asked "Start version N of <step>?". Until then the version's preview and its confirmation refuse with `INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED`, whose route is the acknowledgement, and the card does not ask the version question. The kernel's hold blocks what the engine refuses: opening a version, publishing one and submitting (section 5, precedence 4).

**The question.** The host asks in plain language, using the actual numbers:

> Start version 4 of Planning? Published version 1 and its recorded evidence will stay unchanged.

- The wording must not promise that tests exist when none were recorded.
- If no version was published and an earlier reservation was abandoned, say so explicitly, rather than referring to a "published version zero".
- A terminal or other supported confirmation surface uses the same proposal and confirmation contract.
- No host may invent an executable confirmation command when a mapping is unavailable.

**The receipt.** The response creates an authenticated `VersionOpeningConsent/v1` receipt, bound to the proposal, the principal, the confirmation time and the applicable expiry.
- The host obtains identity through its trusted mechanism, not from model-provided JSON.
- A response in the current turn may authorize the initial opening. Later reconciliation refers to that accepted receipt.

### 7.2 Conditional shared opening

**The operation.** The opening operation uses a stable operation ID, expected revisions and the applicable consent receipt. With them it conditionally:
- reserves the number;
- advances the high-watermark;
- appends an opening record.

**Rules.**
- Only the first reservation of version 1 may omit successor consent.
- Only one concurrent opening for the same basis may succeed.
- Another payload with the same operation ID is refused. The same payload returns its original accepted outcome.

**What Git stores.** The Git adapter commits only the required lifecycle metadata and receipt, then publishes the required Story or state ref. It must not stage or commit unfinished application files, unrelated changes or local attachments. Another storage adapter provides the corresponding conditional shared acceptance, without bringing Git requirements into the kernel.

**Outcomes.** The operation distinguishes these checkpoints. They are checkpoints of one operation, not competing lifecycle authorities.
- prepared;
- locally persisted;
- shared acceptance pending;
- shared acceptance confirmed;
- unknown;
- refused.

Local persistence alone does not grant cross-device successor authoring. A lost push response is reconciled against the original operation and the remote record before another version is proposed.

### 7.3 Other chats and laptops

**Visibility.** Another host sees the opening after reading the relevant shared authority. A local cache must not claim that a remote write is instantly visible.

**When the basis is checked.** At authoring entry, and at consequential publication, review-retention or submission boundaries, the host must establish the applicable current basis and ownership.
- Individual file edits use the verified session, bounded observations and the applicable writer lease, without a Git round trip per tool call.
- An expired or unverified lease requires explicit renewal before writes.
- Stale views show their observation and a specific refresh action.

**Writers.** An accepted open version identifies its authoring session and writer fence.
- A second host may inspect it.
- A writable takeover uses the existing verified ownership protocol and fences the old writer.
- An opening receipt does not grant unrestricted simultaneous authorship.

**Failures.**
- A failed acknowledgement resumes the same opening.
- A changed phase, publication, proposal, actor or policy invalidates its applicability and requires an explicit current decision.
- There is no generic repeated-question fallback.

## 8 Authoring task and turn lifecycle

**The task.** An accepted opening has a durable task identity, bound to project, Story, phase, version, role and opening receipt.
- Its states: ready, running, waiting-input, waiting-environment, waiting-person, repair-required, publication-pending, complete and cancelled.
- A persisted continuation and diagnostics let another authorized turn resume the same work.

**Completion.** The task must not be reported complete merely because the agent read its inputs or prepared a template. Completion requires the actual authoring, check and publication obligations for its declared boundary. Review completion and phase approval remain distinct outcomes.

**Repair.** Repair within an open version follows SPEC-PHR and the existing scope and authority rules.
- A configured repair budget bounds automatic attempts.
- When the budget runs out, the result is a named repair or human decision, with the evidence preserved. It does not restart the same work command indefinitely.
- Actual missing-file, permission and human-approval requirements keep their specific routes.

**Recorded stops (2026-11-17, CVL gap report piece 1).** The task keeps every stop the kernel names, not only a failed
required test, through the one recorder (`src/workflow-task-outcome.mjs` `recordRefusalOutcome`):
- A machine-local document missing here records `waiting-input` with that document's ID, where the step really stops:
  preparation, publication and the authoring entry, never a read. Restoring it names the next one missing, or ends the wait.
- An environment stop records `waiting-environment` with its own error: the environment cause a test-run risk names
  (a launcher, a dependency, a browser, a service that is not reachable), or what blocked the run before it started
  (`ENV_FILE_MISSING`, `ENV_FILE_IN_USE`, `ENVIRONMENT_BINDING_UNAVAILABLE`).
- A code cause, or one nothing names (a timeout among them), is the step's own `repair-required`. Before, any classified
  cause that was not the environment's was kept as `waiting-environment`, which sent a failed assertion to the decisions card.
- A gate run held back because the last run of its command may still be going records no new stop; the next run
  reconciles it (TCE:REQ-034).
- *Review of 2026-11-17.* Every recorded wait leads with a route that works. An environment not set up here (also
  `ENVIRONMENT_ISOLATED_RUNNER_REQUIRED` and `ENVIRONMENT_ARGV_REQUIRED`, which no code edit passes) keeps its
  environment's name and leads with its own fix (`env files <ENV>`, `env bind <ENV> --stdin`, `capability show`, the
  test-command amendment); the refusal itself leads with the fix commands its details carry. A test-run risk stays on the
  decisions card. Every environment wait names the step's checks again (prepublish) beside it, which end the wait once it
  is fixed. A spent repair goes to the appeal (`appeal preflight`), never to an empty card. Entering the step again keeps
  a wait it does not settle (an input it finds present is settled), so the same failing run is not repeated; restoring a
  document settles its wait by any route, `backup restore` among them.

**Windows and leases.** The interaction window and an execution lease are separate.
- An actual human reply may renew the interaction window.
- Actual execution heartbeats and progress may keep a running task alive under its execution contract.
- Neither one renews a human approval, expands scope or overrides revoked permissions.
- Quiet long-running processes must be observed truthfully, without fabricated progress.

**Turn boundaries.**
- If a lifecycle result changes the phase, version, authoring session or role bound to the current turn, that turn returns a handoff and performs no next-scope authoring.
- Starting an isolated reviewer creates a distinct reviewer scope, even when it is displayed within the same chat.

**Prefill.**
- VS Code may prefill the next command after the boundary. It must not send it automatically, or overwrite unsent user text.
- Without prefill support, show the same copyable next action.
- A new turn and a new conversation are different. Any configured conversation-isolation requirement must be fulfilled explicitly.

## 9 Reviewer independence

**When the reviewer starts.** After publication, the work command starts a Copilot reviewer subagent only when that mode has been qualified for independent review.

**What the reviewer gets.**
- A packet with the exact published artifact, source, clarification and applicable instruction bindings.
- Fresh reviewer context, not the author's reasoning transcript.
- Separate role permissions.
- Only its issued report staging resources.

**What the retained report records:** the reviewer's identity and role, the reviewed version, the packet digest and the result. A stale result for another version cannot satisfy the current review.

**What a reviewer cannot do:**
- edit product content;
- approve a phase;
- answer a human disposition;
- obtain new author permissions by returning a route.

**When delegation is unavailable.**
- The work command names the supported `/sf-review-source` route and stops at that boundary.
- That route also needs independent reviewer context. When the host cannot isolate context inside a chat, the handoff explicitly requires a fresh reviewer conversation.
- If no qualified Copilot review mode is available, report the required capability and keep the review pending.
- SFlow must not silently self-review, substitute another AI harness, or claim a review occurred.

The rules for report content and for human approval remain unchanged.

## 10 Commands and host presentation

| Surface command | Contract |
| - | - |
| `/sf-code`, `/sf-phase` | Equivalent current-step authoring entry. Obtain successor consent when needed, continue the open task, build, check and publish when permitted, and start a qualified reviewer. Never submit or approve automatically. |
| Other phase-authoring names | Compatibility adapters into the same coordinator. Preserve arguments, targets, constraints and error meanings. |
| `/sf-call`, `/sf-run` | Their phase-authoring usage delegates to that coordinator. Any existing standalone agent, workflow or execution usage keeps its distinct registered contract. Ambiguous invocations receive a precise clarification. |
| `/sf-next` | Follow the primary current-step agent action under its exact scope. Stop at a human action, an unsupported capability or a scope handoff. Submission, if it is the authorized next action, keeps its own gates and ends the turn. |
| `/sf-review-source` | Independently review the exact published target, or repair its staged review report. |
| `/sf-decide`, `/sf-approve`, `/sf-submit` | Keep their distinct decision, authority and lifecycle contracts. |
| `/sf-recover` | Reconcile actual damage or an interrupted operation. For healthy work, report that no recovery is needed and show its real next action. |
| `/sf-session`, `/sf-resume` | Keep selection and explicit target arguments while sharing the session-opening path and the current-step decision. |
| `/sf-phase-documents` | Inspect documents. Never used as a substitute for required authoring. |

**One command map.** Every host uses one versioned action-to-command map. Its rendered next action is shown on separate lines:
- Copilot: the supported Copilot command;
- Shell: the supported executable and arguments;
- VS Code (model-free): the supported `@sflow` command, or an explicit unavailable result.

**Rendering rules.**
- Only supported mappings are executable.
- Shell rendering and escaping belong to the adapter.
- A skill follows the issued action and completion contract. It does not interpret lifecycle fields or invent routes.
- Pure reads keep explicit inspection routes, even though document display is not an authoring next action.

**Words.** User-facing language uses step, version and named actions. Existing serialized `generation` fields and diagnostic codes keep their compatibility meanings. The plain-language rule applies to new human-facing prose; it does not rename historical schemas.

## 11 Normative requirements

| ID | Requirement |
| - | - |
| OSA:REQ-001 | One pure decision owner MUST determine step projection, authoring eligibility and the primary action from an explicit verified basis. |
| OSA:REQ-002 | The publication-history, open-version and current-publication predicates, and version arithmetic, MUST have one owner and keep their distinct meanings. |
| OSA:REQ-003 | Recovery MUST require positive damage or interruption facts. Unknown facts and ordinary failures MUST keep their actual classifications. |
| OSA:REQ-004 | Scope, revision and observation contracts MUST distinguish missing, unavailable, stale, corrupt and legitimately absent facts. |
| OSA:REQ-005 | Overlapping conditions MUST follow the precedence in section 5 and preserve all unresolved obligations. |
| OSA:REQ-010 | Entry, edit permission, the real guard and task completion MUST use the same basis and authoring scope. Actual mutation checks remain fresh. |
| OSA:REQ-011 | Healthy steps MUST receive their legal primary action, without a recovery fallback. |
| OSA:REQ-012 | Authoring MUST have a durable task, with explicit waiting, repair and completion outcomes. Reading or preparing alone MUST NOT satisfy completion. |
| OSA:REQ-013 | Review staging and declared execution outputs MUST have exact, independent capabilities that grant no source or artifact edits. |
| OSA:REQ-014 | Recovery of changed published files MUST preserve local bytes and immutable accepted history. Keeping the changes requires normal successor consent. |
| OSA:REQ-020 | Surfaces observing the same basis and principal MUST show the same primary target, operation and prerequisites. Stale surfaces MUST identify their basis. |
| OSA:REQ-021 | Command and skill mapping MUST live in host adapters over structured actions. The kernel MUST NOT emit host commands or model prompt wording. |
| OSA:REQ-022 | A refusal MUST keep its original code and details, and lead with the legal post-refusal action derived from verified facts. Unavailable state MUST produce an explicit diagnostic or refresh route. |
| OSA:REQ-023 | A route MUST name a supported operation whose scope and prerequisites the indicated principal and host can satisfy. |
| OSA:REQ-024 | `/sf-code` and `/sf-phase` MUST share the current-step authoring coordinator for all declared supported kinds. |
| OSA:REQ-025 | `/sf-next` MUST perform authorized current-step agent work and stop at human or scope boundaries. |
| OSA:REQ-026 | Kernel-built steps MUST run their declared deterministic operation and publication gates through the work coordinator. |
| OSA:REQ-027 | Command aliases MUST preserve original arguments, standalone meanings, targets and errors. Incompatible meanings MUST use explicit adapters. |
| OSA:REQ-030 | Every new successor opening MUST require authenticated consent for the exact proposal. Neither defaults nor model output may supply consent. |
| OSA:REQ-031 | Openings MUST reserve a version conditionally and obtain shared acceptance before successor authoring. Persistence MUST exclude unfinished application files and local attachments. |
| OSA:REQ-032 | An open successor MUST take precedence over submission or current review of an earlier version. Historical inspection MUST remain possible. |
| OSA:REQ-033 | Duplicate opening requests, lost acknowledgements and uncertain publication MUST reconcile the same operation and receipt, without duplicate successors. |
| OSA:REQ-034 | A writable takeover MUST use the applicable writer fence. Stale or concurrent writers MUST be refused. |
| OSA:REQ-040 | Accepted lifecycle records MUST supply authority; working files MUST supply bounded observations. The decision MUST expose both sources and their differences. |
| OSA:REQ-041 | Guards MUST NOT perform new Git or history discovery per tool call. Adapters MAY reuse compatible observations, while consequential mutations verify their current basis. |
| OSA:REQ-050 | A change of bound phase, version, session or role MUST end current-scope work and issue a handoff. Prefill MUST NOT auto-send or overwrite user text. |
| OSA:REQ-051 | Turn renewal and execution liveness MUST remain separate from authorization, consent expiry and required human presence. |
| OSA:REQ-052 | Reviewer delegation MUST preserve independent context, exact packet bindings and restricted permissions. Unsupported delegation MUST name the qualified Copilot fallback. |
| OSA:REQ-060 | New human-facing text MUST use plain language and name the next action. Historical schemas and diagnostic identities MUST keep their meanings. |

## 12 Acceptance and qualification

### 12.1 Pure rules and agreement across surfaces

**The generator.** It covers valid combinations of:
- lifecycle state;
- published and open versions;
- high-watermarks;
- rework and amendments;
- reviews;
- step capabilities;
- holds;
- task state;
- authority freshness.

It also generates deliberately invalid combinations.
- Valid cases are checked against independent expected fixtures.
- Invalid cases must be classified explicitly, not coerced into a plausible healthy state.

| ID | Acceptance check |
| - | - |
| OSA:AC-001 | For the same valid basis and principal, the entry, the permission and the actual guard agree for an admitted authoring write. Guard tests also deny excluded, foreign, stale and revoked writes. Separate staging and execution permissions do not imply authoring rights. |
| OSA:AC-002 | Every migrated surface agrees on primary operation, logical target, role and prerequisites for the same basis. |
| OSA:AC-003 | Every rendered route has a supported mapping and satisfies its declared turn, role and scope contract. |
| OSA:AC-004 | The abstract lifecycle model reaches a real agent milestone, a human boundary, an explicit wait or a terminal result within six modelled transitions. This bound excludes tool calls and polling; repair attempts use their configured budgets. |
| OSA:AC-005 | Recovery appears as the primary action only for positively established damage or interruption. |
| OSA:AC-006 | Refusals preserve their original error and lead with the current legal action. Unavailable facts yield their actual recovery or refresh diagnostic. |
| OSA:AC-007 | Every use of each named publication predicate agrees with its independent definition, including published version 1 while version 2 is open. |
| OSA:AC-008 | The work, next, recover and review skills contain no competing lifecycle tests and no unsupported routes. Their route assertions include role and target. |
| OSA:AC-009 | The kernel dependency closure has no host I/O, command rendering, prompt composition or AI-provider implementation. Supported custom kinds use declared capabilities. |

### 12.2 Journeys through the actual guard

**The route follower.** `test/helpers/route-follower.mjs` (or its actual equivalent, found in Stage 0) must:
- execute the real issued route;
- check every write with the actual pre-tool guard before bytes change;
- compare next steps, session, phase show and submission readiness at each common basis.

| ID | Acceptance check |
| - | - |
| OSA:AC-010 | A denied write fails the journey before writing. Report staging, execution outputs and artifact or source paths are tested separately. |
| OSA:AC-011 | The route follower compares actual surfaces with independent expected actions, rather than calling the new helper twice. |
| OSA:AC-012 | Repeating an action with unchanged causal progress is detected. Legitimate running-task observation, a declared wait and an idempotent acknowledgement are not misclassified as loops. |
| OSA:AC-013 | Journeys F–J below pass for their applicable kinds and hosts. |
| OSA:AC-014 | All eight reported 16 November incidents have named reproducible journeys A–E, or an explicit replacement with the same incident coverage. |

**Journeys F–J** keep their original intent:

| Journey | Covers |
| - | - |
| F | Rework, republish, a correction review, consent, and the corrected review |
| G | An open successor that submission cannot bypass |
| H | A shared opening becoming visible after another checkout refreshes |
| I | The same consent rule for document corrections |
| J | A fresh-chat `/sf-next` completing current-step agent work without a relay command |

**Additional journeys** MUST cover:
- concurrent openings;
- lost local or shared acknowledgements;
- stale caches;
- offline authority;
- writer takeover;
- changed identity or configuration;
- declined or expired consent;
- unavailable question, delegation or prefill tools;
- future-phase inspection;
- the last phase with an open successor.

Hand-edited published files must survive both the preservation path and the authorized restoration path.

**Truthful continuation** is required for:
- long-running tests;
- required missing local uploads;
- repaired review citations;
- supported repair-budget exhaustion;
- revoked permissions;
- role-changing handoffs.

A staged review result for the wrong version must be refused.

### 12.3 Atomicity and compatibility

| ID | Acceptance check |
| - | - |
| OSA:AC-015 | Two openings from one basis cannot reserve competing successors. The loser receives a conflict and the current accepted action. |
| OSA:AC-016 | Faults before or after local persistence, shared acceptance and reply delivery produce no duplicate opening, no accidental source commit and no lost local work. |
| OSA:AC-017 | An authorized second host resumes shared state and fences the old writer. No cache or caller flag fabricates authority. |
| OSA:AC-018 | Independently scoped Copilot review keeps its exact result. Unsupported delegation uses the supported review command, without self-review or another harness. |
| OSA:AC-019 | Old command invocations, argument meanings and accepted record and hash meanings pass explicit compatibility tests. Older-reader behaviour is tested, not presumed. |
| OSA:AC-020 | An AST and dependency ratchet starts in Stage 1. Per-owner raw lifecycle reads and competing route decisions cannot grow. Approved normalizers, record validators and renderer strings remain explicit exceptions, not hidden policy owners. |
| OSA:AC-021 | Turn renewal cannot revive expired consent, presence or revoked authority. A phase or role change stops the current scope's mutations. |
| OSA:AC-022 | Hot-path qualification measures time, imports and Git and file calls on representative guard, entry and next requests, and verifies there is no per-tool Git discovery. Existing ceilings are not raised to pass. |

**Evidence rules.**
- Repair and negative-path tests must assert the original diagnostic and the retained effects.
- A passing process is not evidence of a phase approval.
- Matching outputs alone are not enough when every output can share the same faulty implementation.

## 13 Revised delivery stages

The implementation plan below defines file ownership, dependencies and exit gates. The fixed sequence is:

| Stage | Delivery | Exit condition |
| - | - | - |
| 0 | Establish the baseline, incident fixtures and compatibility inventory. **The 16 November incident fixes, including v1's built "stop the loops" work (one "being written" test, the entry following the permission, no recover fallback, step commands naming the work command, submit refusing while a version is open, journeys through the guard), count as this baseline; Stage 0 verifies them, it does not redo them.** | Named prerequisites and original behaviour are recorded; no branch is assumed to have landed. |
| 1 | Freeze contracts and precedence, implement the pure decision owner, and migrate guard, entry and next together. Start the ratchet. | A real authoring route reaches completion through the guard, with independent expected results and no contradictory entry. |
| 2 | Consent, conditional shared openings, operation reconciliation and writer fencing. | Race, crash, replay, offline and two-host opening journeys pass. |
| 3 | Move the remaining surfaces, refusal and recovery routes, and durable task and turn behaviour. | Common-basis agreement, and truthful waiting, repair and handoff journeys, pass. |
| 4 | Unified work commands, aliases, kernel-built work and independent Copilot review. | Authoring commands share behaviour without losing standalone contracts or reviewer boundaries. |
| 5 | Remove obsolete policy copies and complete qualification. | Remaining adapters are explicit; ratchets, journeys, compatibility and performance gates pass. |

**Rules for every stage.**
- An incomplete stage is reported as incomplete.
- Individual surface cohorts move atomically, after shadow comparison. Two active decision owners must not compete.
- A discovered regression is fixed, or that cohort is explicitly excluded from activation. It is never waived by reducing the test.

## 14 Compatibility and release boundaries

**What stays unchanged.** Accepted publications, reviews, approvals, human decisions, evidence hashes and error meanings.

**New records.**
- New wire records have explicit versions and reader requirements.
- A release must test the actual older-reader and new-writer combinations it supports. Otherwise it reports the incompatibility and provides a supported update route, without modifying accepted bytes.

**Legacy local openings.**
- A legacy local opening is normalized only when its actual authority, identity and intent can be established.
- An ambiguous local intent grants no new permissions.
- Promotion to a shared opening uses the same scoped opening operation and any successor consent that is owed. A read command never silently rewrites a Story.

**Runtime qualification (owner's rule of 16 November 2026).**
- Every landing is tested on Node 22, the line most people use.
- The full suite runs on the managed Node 26 line once a week.
- A stage is complete only after the weekly Node 26 run following it passes. Its real failures are fixed then, not waived.
- Features that need newer optional runtime APIs have an explicit applicability classification and an unsupported-runtime result.
- An unavailable required run remains open qualification, not a silent skip.

**Hosts.**
- Implementation qualification is Mac-only under the current work constraints.
- Updating this specification does not imply Windows, hosted CI, live Copilot qualification or production installation changes.
- The owner's approved daily paid Story run (about ten premium requests) is the live Copilot qualification row.
- Qualification reports distinguish local deterministic tests, simulated host capabilities and actual Copilot host runs.

**Outside OSA's policy scope:**
- approval groups and approval semantics;
- presence-signed steps;
- reviewer-content standards;
- branching strategy;
- workspace configuration;
- the paused Engine SDK migration.

OSA respects those boundaries and integrates their actual decisions through explicit facts and actions.

## Appendix A Original contradiction mapping

| Original item | Resolution in v1.1 |
| - | - |
| C1 Healthy publication sent to recovery | REQ-003, REQ-011; AC-005 |
| C2 Open successor offered as old review or submission | REQ-002, REQ-032; AC-007; journey G |
| C3 Refusals add recovery or document detours | REQ-022; AC-006 |
| C4 Skill guessed from command spelling | REQ-021, REQ-027; AC-003 |
| C5 Open work has no completion task | REQ-012; AC-004, AC-012 |
| C6 Consumed-intent skill text routes to recovery | REQ-011, REQ-021; AC-008 |
| C7 Entry and guard use different permission tests | REQ-010, REQ-013; AC-001 |
| C8 Correction after rework misses successor consent | REQ-030, REQ-033; journey F |
| C9 Kernel-built step has competing routes | REQ-026; AC-002, AC-003 |
| C10 Typed name changes the workflow meaning | REQ-024, REQ-025, REQ-027; AC-019 |
| C11 One refusal produces incompatible skills | REQ-020, REQ-021, REQ-022; AC-002, AC-006 |
| C12 Hand-edited publication receives conflicting advice | REQ-014, REQ-030; AC-016 |
| C13 Returned code step has contradictory entry and actions | REQ-005, REQ-010; AC-001 |
| C14 Rollover offered during submission | REQ-005, REQ-032; AC-002, AC-003; submitted-state guard journey |
| C15 Phase changes during the same authoring turn | REQ-050; AC-021 |
| C16 Interaction window expires during work | REQ-012, REQ-051; AC-021 |
| C17 Local and shared opening disagree | REQ-031, REQ-033, REQ-034, REQ-040; AC-015–AC-017; journey H |
| C18 Last phase's open successor is bypassed | REQ-005, REQ-032; AC-002, AC-007 |
| C19 Generic agent hook owns another lifecycle rule | REQ-010; AC-001, AC-020 |
| C20 Author conflict points to an impossible action | REQ-005, REQ-023; AC-003 |
| C21 Refusal guidance ignores the open successor | REQ-022, REQ-032; AC-006 |
| C22 Next version computed inconsistently | REQ-002, REQ-031; AC-007, AC-015 |
| C23 Different meanings of publication are conflated | REQ-002; AC-007 |

## Appendix B Changes introduced by this revision

This revision:
- separates historical publication from current authoring;
- uses verified shared authority plus local observations;
- defines conditional opening and durable consent receipts;
- adds explicit state precedence, task waits and scope handoffs;
- requires independent reviewer context;
- places command rendering in host adapters;
- preserves standalone alias semantics;
- moves independent expected tests and the ratchet to the first working slice.

Owner corrections applied on adoption:
- the Node 22 landing rule, with Node 26 weekly;
- requirement and acceptance numbers restored;
- v1's built stop-the-loops work counted in the Stage 0 baseline.

# Implementation plan

| Field | Value |
| - | - |
| Product | Singularity Flow |
| Date | 16 November 2026 |
| Specification | The specification above |
| Status | Implementation plan; no stage completion is claimed. |
| Branch boundary | A separate OSA branch from the verified main baseline. Keep `codex/engine-sdk-foundation` aside. |
| AI harness | Copilot only. |
| Qualification boundary | Mac-only local qualification, unless the owner explicitly requests additional hosts or live harness runs. |

**Approach.**
- Deliver one consistent current-step decision through the actual guard before the broad surface migration.
- Preserve existing authority and record meanings while replacing the separate policy interpretations.
- Each stage has a measurable exit gate. A passing helper test alone does not complete a stage.

## 1 Sequence and effort

These are planning estimates for one engineer familiar with the codebase.
- They exclude waiting for prerequisite fixes, product decisions and unavailable host qualification.
- Re-estimate after Stage 0. The ranges are not delivery commitments.

| Stage | Focus | Indicative effort | Depends on |
| - | - | - | - |
| 0 | Baseline and reproducible incidents | 1–2 engineer-days | The named incident-fix baseline is available. |
| 1 | Pure decision contract, and the guard, entry and next slice | 4–6 engineer-days | Stage 0 |
| 2 | Consent and atomic shared version opening | 4–6 engineer-days | Stage 1 |
| 3 | Remaining surfaces, and the task and turn lifecycle | 4–6 engineer-days | Stage 2 |
| 4 | Unified command behaviour and independent review | 4–6 engineer-days | Stages 1–3 |
| 5 | Delete duplicates and qualify the full change | 3–5 engineer-days | Stages 1–4 |

**Total:** approximately 20–31 engineer-days, or 4–6 weeks of focused work.

**Largest uncertainties:** the existing opening, push and takeover behaviour, and the independent Copilot reviewer capability. Stop-and-verify gates reduce the chance of shipping another route that its own guard refuses.

## 2 Stage 0 Establish the actual baseline

**Purpose:** turn the reported incidents and source counts into a finite implementation inventory.

**Work:**
1. **Branch.** Resolve the selected main commit and record the repository and worktree status. Create a separate OSA branch when implementation starts. Do not merge or modify the Engine SDK branch.
2. **Prerequisites.** Verify the original prerequisite fixes, and record exact commits and outstanding dependencies. Don't infer that a branch name means it was delivered.
   - review-next, kernel-step-route, turn-renew, refusal-next-step;
   - chat prefill, the decisions card, plain language;
   - journey and reset changes;
   - upgrade compatibility, review-visual-evidence;
   - v1's stop-the-loops work.
3. **Decision inventory.** Locate every state, permission, publication-predicate, version-number and command-route decision. For each, record the actual call site, owner, inputs, outputs, current tests and intended replacement. Keep normalizers and validators separate from policy decisions.
4. **Incident fixtures.** Capture the eight incidents as fixtures, with exact Story, phase and version facts and independent expected next actions. Resolve the actual journeys A–E and define F–J. Don't count unnamed journeys as covered.
5. **Command semantics.** Freeze them, including `/sf-call`, `/sf-run`, explicit phase arguments and session targets. Identify which invocations are current-step aliases and which keep standalone contracts.
6. **Mechanisms.** Inventory source and state refs, opening records, conditional-write support, push journals, ownership fences, consent tools, and the actual Copilot reviewer and prefill capabilities. Reuse a genuine equivalent mechanism before proposing another one.
7. **Performance baseline.** Measure representative cold and warm guard, phase-entry and next-action requests: elapsed time, module loading, Git processes and file reads. Keep the data and the method, so later stages have a comparable baseline.

**Deliverables:** a baseline manifest, a call-site and owner matrix, incident fixtures, an alias compatibility matrix, a capability matrix and a performance baseline. These are implementation records on the OSA branch.

**Exit gate.**
- Every incident and every competing decision has a named owner and a reproducer, or an explicit unresolved dependency.
- The supported runtime versions and the existing test, size and deadline ceilings are recorded.

## 3 Stage 1 Create one working decision path

**Purpose:** make the guard, phase entry and next action agree end to end.

**Implementation:**
- **Contracts.** Define exact `StepSnapshot/v1` and `StepDecision/v1` contracts, reason codes, logical targets and record-version admission.
- **Kernel.** Implement the pure kernel reducer with the precedence table. Its hot-path input is bounded, normalized facts. No Git discovery, full-history walk or host command implementation enters its import closure.
- **Predicates.** Implement separate historical-publication, accepted-opening and current-publication predicates, plus one high-watermark calculation. Existing helpers become explicit semantic wrappers.
- **Fact normalization.** Add it on the adapter side, with source bindings and tri-state differences. Missing authority does not become permission, and reading working files does not create an accepted opening.
- **Shadow comparison.** Evaluate the new decision against existing outputs on the same captured basis. Do not execute shadow actions, or repeat I/O merely to compare decisions.
- **Migration.** Migrate the actual mutation contract, pre-tool guard, phase-entry act, authoring task and immediate next route as one cohort. For that cohort only one implementation supplies policy; other surfaces may temporarily adapt its result.
- **Existing restrictions.** Preserve the exact review staging and execution-output capabilities, the application path restrictions and the current authorization checks.
- **Ratchet.** Start the AST and dependency ratchet now. Record each necessary compatibility exception with an owner and a deletion target.

**Qualification:**
- Independent golden fixtures for:
  - publication history during an open successor;
  - no prior publication;
  - future-phase inspection;
  - the last phase;
  - submitted work;
  - holds;
  - missing facts.
- Overlapping-condition tests for rework, open versions, stale review, and pause or authority conditions.
- Actual guarded writes and denials for phase artifacts, application files, other repositories and capabilities, exact report staging and execution outputs.
- Journeys F and G, plus incident routes in the migrated cohort. Verify that a work command authors and reaches its real boundary, instead of reading and reporting completion.
- Import and AST guards, and the first comparative hot-path measurements.

**Exit gate.**
- AC-001–AC-009 and AC-020 pass for the migrated cohort.
- No contradictory entry and permission, and no new competing policy owner.
- Broader surface coverage remains explicitly pending.

## 4 Stage 2 Make successor openings durable

**Purpose:** one human confirmation produces one shared version opening, despite races and interruption.

**Implementation:**
1. **Proposal and receipt.** Create the scoped successor proposal and the trusted human confirmation receipt. Render the actual proposed version and the actual last publication; don't promise test evidence that doesn't exist.
2. **Opening operation.** Reuse or register one conditional opening operation. It atomically reserves the version and high-watermark, and appends its receipt against the expected authority and lifecycle revisions.
3. **Git.** Connect a metadata-only commit and push through the storage adapter. Preserve uncommitted source and local attachments. Reuse the original publication journal where its contract is equivalent.
4. **Checkpoints.** Persist operation checkpoints that distinguish local persistence from confirmed shared acceptance. A lost reply inspects the same operation; a changed payload cannot reuse its identity.
5. **Writer fence.** Require the applicable accepted opening and the current writer fence before successor authoring. Reuse the verified takeover protocol rather than introducing a second lock system.
6. **Refresh.** Before consequential actions, refresh only the relevant shared authority. Keep cached UI advisory and label stale observations. A second checkout reads the opening after refresh.
7. **Legacy openings.** Normalize verified legacy openings without changing accepted publication or history bytes. Ambiguous or incompatible records get an explicit current route.

**Qualification:**
- Two workers propose the same successor. Exactly one opening succeeds; the other receives a conflict with the current action.
- Inject faults before reservation, after local persistence, before and after the push, after shared acceptance, and before reply delivery.
- Replaying an accepted request returns the original receipt, with no duplicate version and no repeated question.
- Test declined, expired, wrong-target and changed-principal confirmations. A changed proposal requires new consent.
- Verify that source and unrelated files remain uncommitted by the opening operation.
- Journey H: visibility in a second checkout, stale-cache behaviour, offline authority and verified writer takeover.
- Older-reader and new-writer compatibility for the record combinations actually supported.

**Exit gate.**
- REQ-030–REQ-034 and AC-015–AC-017 pass.
- An uncertain push cannot grant successor edits, and cannot allocate a replacement version automatically.
- No accepted opening or consent is manufactured from local JSON.

## 5 Stage 3 Move surfaces and durable continuation

**Purpose:** every supported surface gives the same action for the same basis, including waits and interruptions.

**Implementation:**
- **Surfaces.** Move them in named cohorts: source-review continuation, submission readiness, next steps, the Story guide, sequence guidance, phase show, session listing and selection, and the VS Code views.
- **Refusals and recovery.** Move refusal presentation and the recovery planner.
  - Keep original errors, timeout details and known effects.
  - Unknown facts receive refresh or diagnostic actions.
  - Remove generic recovery, help and document detours from healthy lifecycle routes.
- **Review reports.** Repair a malformed staged review report inside its own review task. Keep this distinct from a retained review finding that requires a new product version.
- **Task stages.** Add durable authoring task stages, and the waiting-input, waiting-environment, waiting-person and repair-required outcomes. Each carries its exact continuation and original resources.
- **Repair budgets.** Reuse the configured current-step self-healing and repair budgets. Missing inputs, failed tests and exhausted repairs stop at a specific recoverable boundary rather than repeating an identical route.
- **Separations.** Keep interaction-window renewal, execution liveness, approval and presence validity, and actor authorization separate. Preserve the actual process and task outcome through interruptions.
- **Handoffs.** Enforce a handoff on a change of phase, version, authoring session or role. VS Code prefill keeps unsent text and never auto-sends; other hosts show the same supported action.
- **After mutations.** Re-evaluate, and reconcile original operation results. Don't reread every branch or the Git history in place of the relevant authority snapshot.

**Qualification:**
- Run the route follower through every migrated surface and the real guard at a common revision, plus independent expected results.
- Journey I, and the relevant F and G variants for code, documents, reopened steps and the last phase.
- Long execution, an actual heartbeat, an expired interaction window, a resumed task, a revoked permission and an expired required presence.
- A missing local attachment, a missing-file or permission error, a failed test with bounded repair, a malformed review citation, and preservation of a damaged published file.
- A stale screen, a switched Story, a concurrent window, unavailable prefill, and user text already in the composer.
- Detect actual no-progress loops, without rejecting legitimate observation, explicit waits or idempotent acknowledgements.

**Exit gate.**
- All listed surfaces agree at the same basis.
- The original incidents have named, passing journeys.
- Actual human boundaries and damaged operations keep their own routes.
- No source, review or approval permission is broadened by a generic work command.

## 6 Stage 4 Unify commands and qualify review delegation

**Purpose:** deliver the one-command experience without changing standalone commands or reviewer independence.

**Implementation:**
1. **Work commands.** Route `/sf-code` and `/sf-phase` through the same coordinator. Remove the wording where each relays to or refuses the other, while keeping the actual phase scope.
2. **Aliases.** Implement the documented writing aliases through compatibility adapters. Preserve parameters, explicit targets, output and error shapes, and standalone `/sf-call` or `/sf-run` behaviour.
3. **`/sf-next`.** It executes its authorized current-step agent action in the same turn.
   - It stops for human decisions, unsupported capabilities and scope handoffs.
   - Submission uses its existing operation and gates; the work commands themselves do not submit.
4. **Kernel-owned steps.** Execute them through their declared deterministic build, check and publication path. Don't launch an AI task for deterministic work.
5. **Independent review.** Start independent Copilot review only through a qualified delegation adapter. Bind its exact packet, fresh reviewer context, restricted staging scope, role and retained report identity. The parent author does not acquire reviewer or approver authority.
6. **When delegation is unavailable.** Issue the supported `/sf-review-source` handoff with its independent-context prerequisite, including a fresh reviewer conversation when necessary. If no qualified review mode is available, keep the review pending with a named capability requirement. No self-review and no alternate harness fallback is permitted.
7. **Sessions.** Share the session-opening path for `/sf-session` and `/sf-resume` without dropping explicit selection arguments.
8. **Map and texts.** Update the central action-to-command map, skill texts, help and examples together. Show the Copilot, Shell and model-free commands on separate lines, with truthful unavailable mappings.

**Qualification:**
- Journey J: a fresh-chat `/sf-next` completes current-step agent work without a second relay command.
- Identical authoring targets and behaviour for both main work commands and the parameter-preserving alias cases.
- Kernel-built code, document and convergence steps, and supported custom capability profiles.
- Independent reviewer packet and permission tests, refusal of a wrong-version report, failed or cancelled delegation, unavailable subagent or question tools, and the supported fallback.
- Deterministic paths with refusing AI and harness ports, to prove no model invocation.
- Live Copilot host behaviour is a separate qualification row; the owner's daily paid Story run covers it.

**Exit gate.**
- D1, D2 and D5 behaviour is qualified for each declared host mode.
- Aliases keep their compatibility contract.
- Review claims match actual retained reports.

## 7 Stage 5 Remove duplicates and qualify completion

**Purpose:** finish the migration without leaving competing owners or weakening prior contracts.

**Implementation:**
- **Delete.** Remove obsolete state, permission and route rules for migrated cohorts. Keep record validation and source normalization in explicitly named adapters.
- **Wrappers.** Replace temporary wrappers with exact predicate delegates where compatibility still requires the old symbol. Do not reinterpret historical-publication queries as current-publication queries.
- **Ratchet.** Tighten the AST and import ratchet to the final owner set. Check alternate spellings, renamed fields, computed route construction and kernel imports, not only three literal command strings.
- **Mappings.** Keep only supported action-to-command mappings, and fix unsupported routes in skills, refusals and UI examples.
- **Coverage matrix.** Publish a requirement and acceptance coverage matrix with each executed qualifier, runtime, host mode and remaining limitation.
- **Performance.** Complete the comparative cold and warm guard, entry and next measurements. Keep the original resource and package deadlines unchanged.
- **Activation and reversal.** Document staged activation and reversal using supported record compatibility. A reversal must not erase accepted openings or let stale writers in.

**Qualification:**
- The full OSA property, golden and invalid-state suite, plus all named incident and journey tests through actual guards.
- A matrix of concurrency, crash, cache, takeover, role and presence, repair-budget and historical-evidence preservation.
- Node 22 for every landing; the weekly Node 26 run after the stage passes (section 14).
- The existing touched-set tests, source validation, type checks, package and host compatibility, import and AST ratchets, and the original bundle and performance gates.
- Confirm that existing Stories, records, hashes and local attachments stay unchanged by read-only operations or unsupported migrations.

**Exit gate.**
- Every applicable OSA requirement and acceptance row is qualified, and the remaining limitations are explicit.
- No supported surface retains an independent authoring-state decision.

## 8 Traceability and delivery discipline

| Requirement area | Primary stage | Completion evidence |
| - | - | - |
| REQ-001–REQ-005 and REQ-040–REQ-041 | 1 | Pure contract, independent fixtures, precedence and bounded fact loading |
| REQ-010–REQ-014 | 1 and 3 | Real guard agreement, exact staging and execution capabilities, durable task and preserved local edits |
| REQ-020–REQ-023 | 1 and 3 | Common-basis surface agreement and original-error continuation |
| REQ-024–REQ-027 | 4 | Unified coordinator, current-step execution and alias compatibility |
| REQ-030–REQ-034 | 2 | Authenticated consent, conditional opening, replay and writer fencing |
| REQ-050–REQ-052 | 3 and 4 | Handoffs, liveness and authority separation, and independent review |
| REQ-060 | Every stage | New human-facing wording and consistent named next actions |
| AC-020 | 1 through 5 | A non-increasing decision inventory, and the final dependency and AST guards |
| AC-022 | 0, 1, 3 and 5 | Comparable timing, import and Git and file measurements under the original limits |

**What each stage records:**
- its exact starting and ending commits;
- the owners it changed;
- the tests actually run;
- unresolved rows;
- compatibility implications.

**Rules.**
- A helper's passing test cannot substitute for a route-following journey through the actual guard.
- Distinct views of one snapshot must not each load the same repository state again.
- OSA implementation and qualification do not resume, merge or consume the paused Engine SDK branch.
