# SPEC-SPA v1.4 Business and technical specifications

**Status:** Draft for product and implementation review.
**Date:** 4 November 2026.
**Namespace:** SPA4. Requirement IDs in this document are independent of the accepted SPA v1.3 IDs.
**Baseline:** main `f2bfd18d4`.
**Extends:** [SPEC-SPA v1.3 Spec Studio](SPEC-SPA-v1.3-SPEC-STUDIO.md).
**Primary experience:** the user-selected **Write together** design from the interactive mockup.

Normative requirements use MUST, MUST NOT, SHOULD and MAY. Internal identifiers and storage terms in this document are for implementers; the default product interface uses the plain labels in section 4.

## 1. Product outcome

Spec Studio is the place where a person turns an idea into something a team can understand, build and check. They can begin with a sentence, bring documents, images, links and selected code, and develop the specification with Copilot. They can edit or leave at any time without completing a process first.

The specification remains useful beyond the conversation that created it. A business specification can lead to technical specifications, larger work can be divided into smaller parts, and Stories carry the precise requirements they are expected to deliver. SFlow preserves the connection from the original need to the resulting implementation and evidence.

The product succeeds when a first-time user can describe an idea, obtain a useful first draft, improve it with Copilot, leave and return, and create a Story without learning record formats, command syntax or Git operations.

### 1.1 Existing foundation

The implementation extends the existing engine rather than creating a separate authoring service.

| Existing capability | Implementation reference | Change in this specification |
| --- | --- | --- |
| Automatic specification IDs and revision references | `src/spec-library/ids.mjs` | Preserve identity while adding an explicit specification kind. |
| Immutable local draft snapshots with operation IDs and expected sequences | `src/spec-library/draft-store.mjs` | Retain local durability and add background sharing of draft checkpoints. |
| Immutable published revisions on the configured state branch | `src/spec-library/library.mjs` | Preserve reviewed revisions and keep synchronized drafts separate from them. |
| Copilot proposals that a person accepts | `src/spec-library/proposals.mjs`, `apps/vscode/src/views/spec-studio-tool.ts` | Add focused edits, broader source support and simpler batch review. |
| Reviewed specification slices in a Story's pinned source | `src/spec-library/slice.mjs` | Add typed parent relationships and a direct intake handoff. |
| Child specifications, Story slices and coverage | `src/spec-library/split.mjs`, `allocation.mjs`, `usage.mjs` | Extend the experience to business and technical relationships and larger work. |
| Seven authoring stages in the Studio | `apps/vscode/src/views/spec-studio-model.ts` | Replace stage-based navigation with one continuous editing surface. |

SPA v1.3 remains the compatibility baseline. This proposal changes the editing experience and adds typed relationships and shared drafts. Historical records, their review standing and their existing signatures remain intact.

### 1.2 Scope boundaries

This release covers specifications, their sources, editing, sharing, review, derivation, work creation and delivery links. Application execution, repository onboarding, deployment and existing Story approvals continue through their existing services. Specification authoring has read access to selected application code and does not grant permission to modify that code.

Real-time simultaneous cursor editing, an external document-management platform, autonomous execution of a whole programme, and a new storage backend are outside this release. Concurrent editing uses recoverable drafts and explicit comparison.

## 2. What a specification means

### 2.1 Definition

> A specification is a named, versioned description of an intended outcome or solution. It states its scope, requirements, constraints and the observable results by which success will be checked. It records the sources, decisions and relationships needed to understand those statements.

A draft records work in progress, including suggestions and unanswered questions. A reviewed revision records the intent that the relevant people have agreed. SFlow MUST preserve this distinction throughout saving, sharing, prompting, work creation and reporting. Saving a document establishes neither agreement nor delivery. [SPA4:REQ-001]

### 2.2 Identity

Every specification MUST have one stable, automatically generated ID independent of its title, repository checkout, work branch and conversation. Retrying creation with the same operation ID MUST resolve to the same specification. Titles are editable and need not be unique. A published revision is immutable and has an exact reference and content digest. A local or shared draft has its own checkpoint identity and editing basis. [SPA4:REQ-002]

The UI identifies a specification primarily by title. IDs and digests are available under **Details** and in machine-readable results.

### 2.3 Kind and size

| Kind | Question answered | Expected substance |
| --- | --- | --- |
| Business | What do people need, and why? | Intended outcomes, affected people, scenarios, business rules, scope, priorities and observable acceptance criteria. |
| Technical | How should the system deliver the outcome? | The proposed design, affected components, interfaces, data, dependencies, technical constraints and verification approach. |

Kind and size MUST be independent. Either kind can describe a broad outcome, an Initiative, a Story-sized change or a reusable concern. A specification can begin without a selected kind; Copilot may recommend one, and making a new revision ready requires the person to confirm it. Existing records without a kind remain readable and usable under their existing rules. **Epic** and **Initiative** refer to the same SFlow work level; the UI MUST use one consistent label rather than presenting them as separate levels. [SPA4:REQ-003]

The default UI labels are **Business needs** and **Technical details**. A person starting a technical design directly does not need to invent a business parent.

### 2.4 Requirements and their meaning

A specification MUST distinguish a requirement from background information, a design suggestion, an assumption, an open question and a source observation. Requirements and acceptance criteria receive stable internal IDs; reordering or rewriting their display text does not create new identities. Deleting, replacing or superseding an agreed requirement retains its history and explanation. A statement about existing code describes current behaviour and does not automatically become desired behaviour. [SPA4:REQ-004]

An agreed requirement has a responsible owner, a testable statement or an explicit inspection method, and a source or decision basis. A business acceptance criterion expresses the outcome people need to observe. A technical check can support that outcome without replacing its meaning.

Ownership normally inherits from the specification. A separate owner is recorded only where responsibility differs; the person must not fill an owner field for every sentence.

### 2.5 Relationships

References between specifications MUST identify the owning library, exact revision or draft checkpoint, relevant requirement IDs and relationship. Supported relationships include:

- **Derived from:** a specification was developed using a particular source specification.
- **Implements:** technical requirements realize selected business requirements.
- **Refines:** a smaller specification adds detail to part of another specification.
- **Depends on:** a requirement or piece of work needs another result or contract.
- **Supersedes:** a reviewed statement or specification is intentionally replaced.

One business specification may lead to several technical specifications. One shared technical specification may support several business specifications. Derivation and execution-precedence links MUST be checked for cycles. Ordinary references and inverse display links do not impose a tree on all knowledge. [SPA4:REQ-005]

## 3. The authoring experience

### 3.1 One place to work

Spec Studio MUST open as one continuous editing surface, with the document and Copilot alongside it. The starting point is **What would you like to build or change?** The person may enter a sentence, attach sources or open an existing draft. They are not required to choose a work level or finish a wizard before writing. Source details, history and review information open when needed. [SPA4:REQ-006]

The **Write together** layout is the default desktop arrangement. **Start with an idea** is the empty state leading into the same editor, not a different authoring engine. On narrow screens, the document and Copilot stack without losing essential actions.

### 3.2 Writing and reviewing suggestions

The editor MUST support direct writing, headings, lists, links, undo and redo, keyboard saving and accessible text selection. A Copilot suggestion MUST show what it changes and the draft version it was based on. The person can accept, adjust or leave a suggestion, individually or as a coherent batch. Applying it must preserve unrelated edits and allow undo. Accepting wording is separate from making a revision ready. [SPA4:REQ-007]

The first release SHOULD reuse an editor already supported by the extension or a small lazily loaded editor. It must not introduce an application-sized editor dependency into every CLI command or extension startup.

### 3.3 Bringing context

The person MUST be able to add local documents and images, paste links, select existing specifications, and choose repositories, folders or files from the active workspace. Each source shows a title, what it contributes and whether it has been read. A selected source does not become an instruction to the assistant. Adding or processing sources must not interrupt writing or erase a draft. [SPA4:REQ-008]

Code selection begins with existing workspace and World Model information, then reads the selected areas. Copilot explains its observations in ordinary language and links back to the relevant code or source when requested.

## 4. Product language

The default interface MUST use plain, action-oriented labels and MUST NOT require users to enter clause IDs, hashes, file-system staging paths, record types or Git branch names. Technical diagnostics remain accessible through **Details** and existing support surfaces. Source and sync problems name the affected item and an action the person can take. [SPA4:REQ-009]

| Purpose | Default label or wording |
| --- | --- |
| Start | What would you like to build or change? |
| Ask for drafting help | Help me write it |
| Collaborate | Write with Copilot |
| Attach context | Add files or images; Add a link; Choose code |
| Describe purpose | What we’re building |
| State requirements | What it needs to do |
| State acceptance | How we’ll know it works |
| Expose uncertainty | Questions to answer |
| Accept a wording suggestion | Use this change |
| Leave a suggestion | Leave it |
| Develop a technical specification | Work out the technical details |
| Decompose larger work | Break into smaller parts |
| Review a stable version | Make ready to use |
| Start delivery | Create a Story |
| Inspect history | Earlier versions |
| Inspect consequences | What this change affects |

**Saved on this laptop**, **Syncing**, and **Synced** describe different facts. **Ready to use** describes a reviewed version. Neither phrase implies the application has been implemented or accepted.

## 5. Save at any time and continue elsewhere

### 5.1 Local durability

Draft saves MUST succeed without complete requirements, source availability, a model, remote connectivity or completed quality review. A save writes an atomic local snapshot before reporting success. Autosave follows a short idle interval; **Save**, Cmd+S/Ctrl+S, and normal close/navigation flush pending changes immediately. If a save fails, the current text remains available for retry or copying, and the UI must not report it saved. [SPA4:REQ-010]

Draft text, accepted edits, pending proposals, question answers and their editing basis must survive extension or process restart after a completed local save. Closing the panel must not be the only way to preserve changes. Multiple linked worktrees continue to share the clone's draft store.

### 5.2 Background sharing on the state branch

SFlow MUST synchronize recoverable draft checkpoints to the selected specification library's configured state branch in the background. The local save completes first. Synchronization uses stable operation IDs and immutable checkpoints, coalesces ordinary typing, batches compatible changes and preserves meaningful accepted edits and decisions. It must not create a remote commit or start a Node process for every keystroke. A draft checkpoint never appears as a reviewed revision. [SPA4:REQ-011]

Default behaviour is local autosave after 750 ms of idle time, background synchronization after 10 seconds of quiet, and no more than one automatic publication batch per library every 30 seconds. **Sync now** can flush sooner. These are configurable starting values, subject to qualification in section 14. Automatic sharing can be paused without disabling local saves.

If publication succeeds but its acknowledgement is lost, SFlow reconciles the original operation before retrying. If a push is retained for recovery, the pending save stays bound to that checkpoint and commit. Retrying must not create another specification or reviewed version.

A checkpoint, revision or split cannot be retracted once pushed, so the exact files each publisher would ship MUST pass the repository's secret scan first, including links, which are judged by the shape of their values so ordinary specifications are not refused. A finding, or a scan that fails, shares nothing, keeps the writing saved locally and tells the person where to look and how to clear it without repeating the value. It never stops them writing. Answers to a model withhold such values on every route; only the person's own page reads them.

### 5.3 Another laptop and concurrent changes

Another laptop MUST be able to list synchronized drafts, open their content and continue from a known checkpoint without the original conversation. Pending changes that exist only on the first laptop are reported there as local; they must not be represented as available elsewhere. When two edits share an older basis, neither may silently overwrite the other. Both remain recoverable while the person compares or combines them. [SPA4:REQ-012]

The editor does not expose a Git merge. It shows **There is a newer draft** and offers **Compare**, **Keep mine as another draft**, or **Use the newer draft**, with unsaved writing preserved. Different specifications do not contend on a single mutable catalogue file.

### 5.4 Retention and backup

Drafts, pending synchronization, accepted revisions and local sources MUST participate in the existing backup, restore and cleanup model. Cleanup cannot remove the only local copy of unsynchronized work, an active recovery operation, a referenced source or a snapshot needed to resolve a concurrent edit. Retention is configurable and applies only after those protections. A preview must identify what can be removed and what is retained. [SPA4:REQ-013]

The default retains every snapshot except ordinary wording saves older than the newest 200, of which the last of each hour stays. The head holds the wording, so no unsynchronized work is lost. Immutable checkpoints stay on the state branch, because removing one from its tip would leave its bytes in Git history.

## 6. Co-creation with Copilot

### 6.1 Work from the current draft

Copilot MUST receive the current draft and its editing basis, selected specification kind, relevant parent requirements and decisions, available source references, and the person's current request. It proposes focused changes against that basis. Whole-document replacement remains supported for compatible clients only when its preconditions preserve newer edits. A stale proposal leaves both the current draft and proposed text available for comparison; it must not overwrite the document or restart authoring. [SPA4:REQ-014]

The engine remains usable without a model. Manual writing and reviewed manual specifications have the same standing as assisted ones. The engine owns storage, reference checks and existing policy enforcement; Copilot drafts, researches and explains.

### 6.2 Ask useful questions once

Copilot MUST reuse answers and relevant decisions already recorded in this draft or its selected parent revisions. It asks only unresolved questions that materially affect the requested scope. The default interaction asks one question at a time, with useful choices, an optional free-text answer and **Decide later** where policy permits. A discussion can surface additional questions, but re-entry, retries or another phase must not ask the same settled question again without a material change. [SPA4:REQ-015]

Each question has a stable identity and basis. Its answer records who chose it and what it changes. Copilot can recommend an option and explain implications; it cannot manufacture a person's decision or turn an unaccepted assumption into agreed scope.

### 6.3 Improve the draft before asking the person to repair it

Checks MUST distinguish issues the assistant can repair from decisions a person must make. Missing sections, malformed references, untestable wording and missing observable error or boundary behaviour should return exact draft corrections. Copilot performs admitted corrections in the current task and rechecks them within a bounded repair budget. Missing access, changed intent and required human review retain their explicit owner routes. A repeated unchanged failure must lead to a different actionable route rather than another identical authoring turn. [SPA4:REQ-016]

Quality checks adapt to kind and selected scope. Business drafting checks actors, observable scenarios, rules and acceptance. Technical drafting checks contracts, data, failures, dependencies and verification. A backend or command-line specification must not receive mandatory browser, button or screenshot questions. Checks run asynchronously or on request and do not block saving.

### 6.4 Research with visible support

Research MUST distinguish observed code, supplied documents, retrieved links, a person's statement and an assistant recommendation. Claims presented as sourced must identify their support and its version or retrieval basis. Inaccessible, changed or unread sources remain visibly unresolved. Copilot must not claim to have read them, invent citations, or infer desired business behaviour solely from existing code. Existing code that conflicts with the proposed outcome is a question to resolve. [SPA4:REQ-017]

When research tools are unavailable, the person can supply an excerpt or file and continue editing. External research runs through the available host tools and their existing permissions; SFlow does not silently start a separate paid model or browsing service.

## 7. Documents images links and code

Raw uploaded documents and images MUST remain local. Shared records contain source identity, display name, media type, content digest, purpose and relationships, without a laptop's absolute path or raw attachment bytes. Full extraction caches and provider-ready image data remain local as well. Text deliberately accepted into the authored specification is specification content and can be synchronized with that draft. [SPA4:REQ-018]

On another laptop, a missing local source offers **Add this file again**. A matching content digest restores the source binding. A different file creates a proposed replacement and shows the affected references; it must not impersonate the original. Missing sources only hold operations that actually require those sources. The specification, saved answers and unrelated work remain available.

The phase or authoring context MUST offer the assistant the actual readable material, not only a file name. Text sources receive bounded readable excerpts and references; supported images receive a native image input or an exact readable image path that the host supports. CLI-issued files and read ranges are authoritative. Readers must preserve real missing-file, permission, unsupported-media and timeout errors and offer the applicable upload, access or reader-recovery route. [SPA4:REQ-019]

Links store their permitted canonical address and source metadata. Access credentials and secret-bearing addresses stay out of shared records: a link carrying a credential parameter is refused. Files and code take the environment-local and secret refusals of every other document input, when added, restored and read; with no declaration, `.env` and `.env.*` are refused by name, apart from example files. What cannot be checked, such as a very large file, says so when it is read. A link is not treated as readable until retrieval succeeds. Code facts bind to repository identity, commit or observed working-copy basis, path and cited span. Source changes invalidate the affected observation rather than erasing the draft.

## 8. From business needs to technical details

### 8.1 Derive a technical specification

**Work out the technical details** MUST create a distinct technical draft linked to the selected business specification version and selected requirements. Copilot reads the business decisions, code and supporting material, proposes an approach, and explains relevant alternatives and consequences. The business specification remains unchanged. Derivation from a business draft is allowed as provisional work; making the technical result ready requires an agreed parent revision for the business intent it claims to implement. [SPA4:REQ-020]

A technical specification may be created independently for maintenance, infrastructure, architecture or another technical need. Its reason and acceptance checks must be explicit. Reclassifying an existing business specification is not the conversion operation.

### 8.2 Preserve requirement meaning

Every selected business requirement MUST be linked to technical requirements that realize it, or retain an explicit outcome such as deferred, excluded from this technical scope, or covered by another specification. Such outcomes require the applicable person's decision and reason. Every technical requirement states either its business source or a separately justified technical basis, such as an agreed platform constraint. SFlow must not force a fabricated business link onto every technical detail. [SPA4:REQ-021]

One requirement can be implemented across API, UI and data specifications. Shared requirements are referenced consistently. The breakdown records which part is responsible and which results need to work together. Copilot does not silently weaken business acceptance criteria to match a convenient implementation.

### 8.3 Example

| Layer | Statement | Connection |
| --- | --- | --- |
| Business requirement | A meeting room cannot be double-booked. | The requested business rule. |
| Business acceptance | Two simultaneous attempts for the same room and time produce at most one confirmed booking. | A way to observe the rule. |
| Technical requirement | The booking operation checks and records availability atomically and reports a conflict clearly. | Implements that rule. |
| Story | Add booking conflict handling to the room service and explain conflicts in the calendar. | Selects the relevant business and technical requirements. |
| Evidence | Retained concurrent-request tests and the relevant interaction checks. | Demonstrates what the implementation actually does. |

### 8.4 Review changes through their links

A new parent revision MUST leave existing children and Stories on their original versions. SFlow compares changed requirement meanings and decisions to identify affected technical specifications, Stories and shared contracts. The UI shows **This change may affect 3 Stories** and the specific reasons. Cosmetic edits must not automatically invalidate every descendant. Moving work to another version uses an explicit reviewed change through existing amendment or successor mechanisms. [SPA4:REQ-022]

## 9. Make a version ready and create work

### 9.1 Ready to use

**Make ready to use** MUST review an exact saved checkpoint and create an immutable reviewed revision using the existing library publication and applicable review/signature policy. The review presents the selected kind, requirements, acceptance checks, source standing and unresolved decisions in one understandable view. A draft can always be saved while this review is pending. Relevant unresolved scope is answered or explicitly deferred, excluded or accepted by the authorized person with its consequences visible. [SPA4:REQ-023]

Ready means the specification can be used as agreed input. It is not evidence that code, tests or the business outcome have been delivered. Existing required policy checks stay in force; this feature must not turn **Save**, **Use this change**, **Create a Story** or a Copilot statement into approval.

### 9.2 Create a Story

**Create a Story** MUST preview the selected reviewed specification versions, requirements, decisions, repository scope and required dependencies, then open the existing Story intake with those inputs prefilled. The person can choose the whole specification or a meaningful part. The created Story pins the exact references and content it started from. Retrying the same creation must resolve the existing result rather than create duplicate Stories. [SPA4:REQ-024]

A Story may use business specifications, technical specifications or both. A separate technical specification is not mandatory for every small change. When one is used, the Story retains the relevant business origin and its acceptance meaning. Story-specific clarification asks for genuinely new details and reuses decisions already supplied.

When selected technical requirements implement or refine business requirements, the engine computes the relevant business origin and acceptance closure, includes its exact text and decisions in the creation preview, and pins it with the technical slice. This is a bounded selection of relevant ancestors, not the entire parent library. Duplicate paths to the same requirement are counted once. A conflicting request for two versions of the same specification requires an explicit version choice or an updated derivation; it cannot silently choose the latest one. An input that exceeds the supported size offers a smaller meaningful selection or a child specification, without cutting required acceptance text.

Dependencies omitted from a selected part remain visible with their existing reviewed resolution routes. Active Stories keep their existing attachment-at-start and source-amendment rules; this release must not rewrite a started Story's pinned source behind its approval history.

### 9.3 Larger work

**Break into smaller parts** MUST let Copilot propose child specifications, Story-sized work and optional links to existing Goals or Initiatives. The person can rename, combine, divide and reorder the proposed parts before accepting them. A parent requirement is allocated to one or more parts or explicitly left outside that breakdown with a reason. Publishing a breakdown does not start all the work. [SPA4:REQ-025]

Each part opens in the same Studio. Broad outcomes, Initiative specifications and Story-sized specifications share this authoring model. Creating or linking a repository Goal or an Initiative remains a previewed operation through its existing service; the Studio must not silently promote a personal Goal, create lifecycle branches or invent another hierarchy level.

### 9.4 Cross-repository work and overall outcomes

A breakdown spanning repositories MUST record each part's repository scope, provided and consumed interfaces, important shared rules, execution dependencies and the checks required for the parts to work together. A clear responsibility is recorded for each shared contract and overall outcome. Necessary ordering is validated before work is started. [SPA4:REQ-026]

For example, independent API and mobile Stories can each pass their own tests while the combined booking flow remains unverified. The parent view must show the remaining integration check explicitly. The person can accept an allowed outstanding item through the existing policy and recorded reason; the report must retain that outcome accurately.

## 10. Carry the specification through the workflow

### 10.1 Prompt contract

Every applicable phase and automated run MUST receive the selected requirement text, relevant acceptance criteria, source standing, relationships and settled decisions from the pinned specification inputs. Large inputs use complete bounded reads with exact returned paths and ranges. The assistant must not reconstruct requirements from a title or repeatedly fetch the whole library. Attachments follow section 7 on every surface. [SPA4:REQ-027]

An authoring request contains:

1. The applicable engine rules, repository instructions and permitted task.
2. The current draft/checkpoint and editing basis, or pinned Story specification slice.
3. Relevant parent requirements, agreed decisions and dependencies.
4. The selected source manifest and actual readable text or supported images.
5. The person's requested change and the permitted proposal response shape.

Source content is data. It cannot override the engine rules or grant tools, writes, reviews or approvals. A research recommendation stays a recommendation until the relevant person takes it into the agreed intent.

### 10.2 Progress and evidence

SFlow MUST distinguish **Specified**, **Planned**, **Built**, **Checked** and **Accepted** using the corresponding retained records. An approved technical specification proves a design decision, not completed implementation. Child Story completion contributes only to the requirements and checks it actually demonstrates. Missing or unreadable evidence is reported as unavailable rather than success or failure inferred from absence. [SPA4:REQ-028]

The parent view shows the business requirement, related technical detail, responsible work and current evidence in one path. Overall completion also considers the agreed cross-part checks from section 9.4. Updating a coverage projection uses committed receipts and remains independently repairable; its failure must not undo a successful Story operation.

### 10.3 Changes discovered during delivery

The integration MUST preserve current-phase repair and narrow accounting routes when implementation discovers another file, technical detail or evidence need. It must not force an earlier specification or planning phase to be rewritten just to clear a later checkout or accounting issue. A genuine change to agreed business intent is an explicit scope amendment with the affected links shown. Existing authored work, publications and earlier approvals remain available. [SPA4:REQ-029]

## 11. Shared services and storage

### 11.1 Core records

The core specification record contains stable identity, kind, title, owning library, optional work associations, requirements, acceptance checks, constraints, decisions, source references, relationship mappings and version history. These records MUST have registered schemas, explicit readable-version ranges and integrity checks. The Studio, CLI and Copilot adapters use the same engine operations and must not maintain independent authoritative copies. [SPA4:REQ-030]

Working state and reviewed state have different references:

```text
Specification
  identity: stable specification ID and owning library
  working draft: saved checkpoints, editing basis and pending suggestions
  reviewed revision: immutable content, reviewed decisions and exact references
  sources: shared descriptions with laptop-local material
  relationships: exact source versions and requirement mappings
  work links: selected requirements and the work that claims or delivers them
```

The following is a proposed logical layout, to be finalized through the repository's schema registration review. It preserves v1.3 revision paths and does not turn mutable draft pointers into reviewed records.

```text
Configured state branch
  singularity/specifications/<SPEC-ID>/
    drafts/<EDITING-ID>/checkpoints/<CHECKPOINT-ID>.json
    drafts/<EDITING-ID>/head.json
    <REVISION>/
      manifest.json
      spec.md
      gaps.json
      research.json
      quality.json
      requirements.json             derived requirement index and authored roles
      relationships.json
      sources.json
      presence.json                 when required by the existing policy
    splits/<SPLIT>/split.json
    usage/<WORK-ID>/...

Clone-local shared runtime storage
  spec-drafts/<SPEC-ID>/...          durable working snapshots
  spec-sync/...                     pending operations and reconciliation
  local source registrations        paths and extraction/image material
```

The head pointer is only a selection aid, updated with an expected previous value. Immutable checkpoints retain content and ancestry if a pointer update loses a race. State-branch draft records must be classified as working content by all readers and remote checks. They cannot satisfy any reviewed-revision or signature requirement.

The authored requirement text in `spec.md` remains canonical. `requirements.json` is its checked projection with stable IDs, semantic roles and source locations; `relationships.json` carries explicit cross-specification links. A disagreement between these representations is repaired before a new reviewed revision is published. The rich editor must preserve identity across formatting changes and generate this same document and index, rather than maintaining a separate meaning in its own HTML.

| Logical record | Minimum fields |
| --- | --- |
| Specification metadata | Schema version, stable ID, kind or legacy unclassified state, title, owning library, owners and optional work associations. |
| Draft checkpoint | Checkpoint ID, editing ID, parent/basis references, local sequence, operation ID, author, save time, prose, source metadata, proposals, questions and content digest. |
| Reviewed revision | Specification reference, kind, exact accepted checkpoint, prior revision, review record, required signature, file digests and the existing review standing. |
| Requirement projection | Stable requirement ID, role, exact statement/location, applicable acceptance links, inherited or explicit owner and agreed disposition. |
| Derivation mapping | Exact source/target references and requirement IDs, relationship, rationale, approval standing where required, and changed-source comparison basis. |
| Source reference | Portable source ID, type, display name, content/version identity, purpose, relevant references and access/materialization standing. |
| Work use | Exact work identity and repository, pinned specification references, selected requirement closure and the retained claim/delivery receipts. |

These are logical record contracts. Schema registration should reuse existing record families where their meaning fits, add the necessary draft-checkpoint and relationship/source families, and reuse the existing publication journal for pending sync. It must not introduce another transaction engine or duplicate the existing recovery state.

Repository identity is portable. Laptop paths, credentials, raw uploads, extraction caches and complete chat transcripts do not belong in shared checkpoint payloads. Pending conversation material needed to continue work is summarized as draft proposals, questions and decisions with their proper standing.

### 11.2 Operation contracts

The engine MUST expose resumable operations for reading, saving, synchronizing, proposing, accepting edits, reviewing, deriving, splitting and previewing work creation. A mutation records its operation ID, expected editing basis, effect status and exact continuation or recovery action. Large output returns complete readable references rather than silently truncated instructions. Operations that require a person preserve that boundary across native tools and shell fallback. [SPA4:REQ-031]

The logical operation set is:

| Operation | Responsibility | Important precondition |
| --- | --- | --- |
| Read draft | Return the current checkpoint, sources, questions and pending proposals. | Resolve the correct library and selected specification. |
| Save draft | Preserve edits locally and queue sharing. | The expected local basis; recoverable alternate draft on conflict. |
| Sync draft | Publish/reconcile queued checkpoints and update sync standing. | Stable operation identity and expected shared head. |
| Propose change | Stage a bounded edit, research item, question or derivation mapping. | Exact draft/source basis. |
| Accept change | Apply the person's selected proposals and preserve undo/history. | Fresh basis and applicable person/signature policy. |
| Review readiness | Explain quality, questions and source standing. | Exact checkpoint; this is a read. |
| Make ready | Publish an immutable reviewed revision. | Current review basis and required authority. |
| Derive or split | Stage a technical draft or breakdown. | Exact source versions and selected requirements. |
| Preview work creation | Prefill Story, Goal or Initiative creation/linking. | Reviewed inputs for delivery and explicit repository scope. |
| Create or link work | Call the existing work service once. | Confirmed preview, fresh authority and lifecycle checks. |

These are proposed engine contracts, not claims that new command names already exist. Existing `spec author`, `spec split`, `/sf-spec-author`, `#sflowSpecStudio` and Story `--spec` forms remain compatible. Every new form must be registered, documented and return canonical Copilot, Shell and model-free routes where available. Unavailable routes are described explicitly.

### 11.3 Failures and continuation

Every unsuccessful operation MUST preserve the current writing and distinguish at least: a local save failure; pending or failed sync; an unknown push outcome; an older shared draft; a stale proposal; an inaccessible source; missing local material; a changed source; incomplete review; denied authority; unsupported schema; and failed or uncertain work creation. It must identify the affected item, original diagnostic and a viable action rather than only returning help or asking the same question again. [SPA4:REQ-032]

| Situation | Product behaviour |
| --- | --- |
| Connection is unavailable | Saved on this laptop. Sharing retries by itself with backoff, or use Sync now; writing continues. |
| The writing holds a secret | Saved on this laptop and not shared. Remove the value, or waive it on its line; sharing resumes. |
| Publication acknowledgement is lost | Reconcile the same operation; do not publish a replacement automatically. |
| Another laptop saved newer work | Keep both versions, compare, and use an expected-basis update. |
| Only metadata moved the head | Not a conflict: a save replaces wording, title and kind, and keeps what moved it. |
| Copilot proposes against old text | Keep the suggestion; compare or rebase it on the current draft. |
| A local attachment is missing | Ask for that source again only when the current operation needs it. |
| A link cannot be opened | Keep its unread status; offer access repair or a local file/excerpt. |
| A readiness check finds missing detail | Point to the section; repair wording or ask the actual decision owner. |
| Story creation times out | Inspect the retained creation operation and any existing Story before retrying. |
| A reader cannot open an issued file | Preserve the exact path and native error; use supported ranges or the issued recovery route. |
| A record comes from a newer schema | Keep the draft and explain the compatible-reader/update route. |

## 12. Compatibility and performance

### 12.1 Existing specifications and Stories

Migration MUST preserve the bytes, references, signatures and standing of historical reviewed revisions and Story sources. A missing legacy kind is represented as unclassified; it must not be inferred as business or technical and then used to change previous authority or coverage. Classification is offered when the next draft is edited. Readers retain the v1.3 profile for old records, and new metadata is introduced through registered schema versions and migration fixtures. [SPA4:REQ-033]

New structured requirement metadata must agree with the authored document. There is one canonical requirement identity and meaning per version; rich-text formatting, Markdown export and machine-readable views cannot silently describe different requirements. Existing signed revisions are not republished in the background just to upgrade their schema.

### 12.2 Keep everyday work fast

Typing, saving and opening a known local draft MUST avoid a remote readiness check, complete repository scan or expensive validation. Source work is selected and incremental. The initial page uses local/shared snapshots promptly; remote metadata follows existing configurable advisory freshness, with a 30-minute default and explicit refresh. Final mutations still perform their applicable fresh integrity, authority and concurrency checks. Git calls are batched, the selected state branch is fetched directly when needed, and application branches and Git history are not searched to list specifications. [SPA4:REQ-034]

Automatic quality checks and source extraction are debounced and bounded. Every activity reports its actual stage, such as **Reading your file**, **Looking at selected code** or **Writing your draft**. Cancellation preserves the latest completed save and pending operations. Performance measurements separate Copilot, network, Git, file access, Node startup and engine execution.

## 13. Acceptance criteria

All scenarios below apply to both manual and assisted authoring where relevant. Required matching-platform runs must have explicit results; unsupported or skipped coverage is not reported as passing.

| Criterion | Requirements | Demonstration |
| --- | --- | --- |
| [SPA4:AC-001] | REQ-001, REQ-002 | Given one sentence with no title or ID, creation assigns a stable ID and saves a draft. Retrying its operation returns that same draft. Saving does not mark it reviewed or delivered. |
| [SPA4:AC-002] | REQ-003, REQ-004 | Business and technical drafts expose different guidance at both Initiative and Story-sized scope. A kind can be chosen later, and existing unclassified specifications retain their standing. |
| [SPA4:AC-003] | REQ-006, REQ-009 | A new user enters an idea and opens an editable draft without visiting seven stages or entering technical identifiers. Core labels match section 4. |
| [SPA4:AC-004] | REQ-007 | Direct typing, headings, lists, links, undo/redo and keyboard saving work. Accepting one suggestion preserves a manual edit elsewhere, and undo restores the prior wording. |
| [SPA4:AC-005] | REQ-008, REQ-017 | Files, images, links, selected code and existing specifications can be added without leaving the draft. An unread or inaccessible source is never shown as read. |
| [SPA4:AC-006] | REQ-010 | An incomplete draft with open questions saves offline. After the local save completes, restarting the extension restores text, answers, accepted changes and pending suggestions. |
| [SPA4:AC-007] | REQ-011 | Rapid typing produces local snapshots and coalesced background publication. An unreachable remote leaves a visible local save and a retryable sync operation; it does not freeze editing. |
| [SPA4:AC-008] | REQ-011, REQ-031, REQ-032 | When a checkpoint push acknowledgement is lost, reconciliation finds the original result or continues that operation. It creates no duplicate checkpoint publication or reviewed revision. |
| [SPA4:AC-009] | REQ-012 | Laptop B opens a synchronized draft without Laptop A's chat. Unsynchronized writing remains identified as local on A and is not claimed to exist on B. |
| [SPA4:AC-010] | REQ-012 | Two laptops edit from one basis. The second save retains its writing and the newer shared draft; comparison and a reviewed combination succeed without silently losing either. |
| [SPA4:AC-011] | REQ-013 | Cleanup retains unsynchronized changes, referenced local files and active recovery. Backup and restore recover a draft and its local sources without publishing or approving anything. |
| [SPA4:AC-012] | REQ-014 | An in-flight Copilot suggestion becomes stale after a manual edit. Acceptance preserves the newer draft, explains the conflict and offers a usable comparison/reproposal route. |
| [SPA4:AC-013] | REQ-015 | A decision answered in a parent business specification appears settled in a technical draft and subsequent Story phases. Re-entry does not ask it again; a changed answer basis identifies the affected question. |
| [SPA4:AC-014] | REQ-016 | Missing failure behaviour is repaired in the current draft. A required human scope decision produces a real question and owner route. Repeating the unchanged finding cannot create an endless self-retry. |
| [SPA4:AC-015] | REQ-016, REQ-017 | A backend/API example receives contract and failure guidance without mandatory UI screenshots. Code observations and research recommendations retain their distinct standing. |
| [SPA4:AC-016] | REQ-018, REQ-019 | On another laptop, a required local image asks for reattachment. Matching bytes restore the reference; different bytes require an explicit replacement. Raw source bytes and local paths are absent from shared records. |
| [SPA4:AC-017] | REQ-019, REQ-027 | During authoring, intake and later applicable phases, supported documents provide readable content and images provide usable image inputs. Large reads complete using exact returned ranges; real access errors retain their diagnostics. |
| [SPA4:AC-018] | REQ-005, REQ-020 | A selected business revision creates a separate technical draft linked to its exact requirements. The business bytes are unchanged. A provisional parent draft cannot silently count as agreed business intent. |
| [SPA4:AC-019] | REQ-021 | A technical design maps selected business requirements, explicitly allocates/defer items outside its scope, and records justified independent technical constraints. No selected business requirement silently disappears. |
| [SPA4:AC-020] | REQ-005, REQ-021 | One shared technical specification supports two business specifications without duplicating requirement identity or human decisions. Illegal derivation or execution-dependency cycles receive exact corrective findings. |
| [SPA4:AC-021] | REQ-022 | A changed business rule flags the linked technical requirements and affected Stories. An unrelated wording edit leaves their standing intact. Existing Stories keep their original versions until an authorized change. |
| [SPA4:AC-022] | REQ-023 | Making a checkpoint ready shows its exact scope and outstanding decisions, applies the repository's review/signature policy and publishes one immutable reviewed revision. Save remains usable throughout. |
| [SPA4:AC-023] | REQ-024 | Selecting part of a specification prepopulates Story intake with its requirements, decisions, dependencies and repository scope. The created Story prompts contain their actual text and exact versions. |
| [SPA4:AC-024] | REQ-024, REQ-031, REQ-032 | A retry after uncertain Story creation resolves the retained operation. A single confirmed request produces at most one Story. An already-started Story's pinned source is not rewritten. |
| [SPA4:AC-025] | REQ-025 | A larger idea can be divided into child specifications and proposed work. Names and grouping can be edited. Every parent requirement is allocated or explicitly left out; accepting the breakdown does not start all the work. |
| [SPA4:AC-026] | REQ-025, REQ-026 | Work spanning API and mobile repositories records both repository scopes, the shared contract, ordering and an overall interaction check. Goal/Initiative links use existing services and preserve their separate authority. |
| [SPA4:AC-027] | REQ-028 | Technical-spec review alone leaves implementation unbuilt. Completed child Stories with a missing agreed integration check leave that parent check visible; unsupported success is not inferred. |
| [SPA4:AC-028] | REQ-029 | A newly touched implementation file is accounted for through the current phase's existing narrow route. A true business-scope change uses an explicit amendment. Earlier approved artifacts remain intact. |
| [SPA4:AC-029] | REQ-030, REQ-031 | CLI, native Copilot and VS Code observe the same draft, checkpoint and review standing. Every user action has a registered engine operation and a valid continuation or explicit human route. |
| [SPA4:AC-030] | REQ-032 | Injected save, permission, network, timeout, source-read, schema and creation failures retain the draft and original diagnostic and provide actionable recovery without recreating the specification. |
| [SPA4:AC-031] | REQ-033 | Existing signed revisions and Stories load without byte changes or new approvals. Editing creates a compatible next draft. A newer unreadable schema gives an update/reader route rather than an empty library. |
| [SPA4:AC-032] | REQ-034 | Cold/warm measurements on Mac and Windows show no remote calls for typing/local saves and no all-branch/history scans for library reads. Large repositories do not cause unrelated file reads during source-scoped edits. |
| [SPA4:AC-033] | REQ-006, REQ-007, REQ-009 | Keyboard-only operation, screen-reader labels, visible focus, larger text, light/dark appearance and 320 px width preserve editing, source attachment, Copilot choices and Story creation actions. |
| [SPA4:AC-034] | REQ-005, REQ-024, REQ-027 | A Story created from technical requirements also receives the relevant pinned business requirements, acceptance criteria and settled decisions, even when the person selected only the technical specification. Shared ancestors are deduplicated and unrelated parent scope is excluded. |
| [SPA4:AC-035] | REQ-005, REQ-024, REQ-032 | Conflicting parent versions or an oversized origin selection produce an understandable version/scope choice with the draft and creation preview retained. Neither the newest version nor a truncated input is adopted silently. |

### 13.1 Required product journeys

1. **A vague business idea:** one sentence, local notes and an image; a first draft; one answered question; a saved draft; a reviewed business version; a Story using its selected requirements.
2. **Business to technical:** a room-booking rule; inspected API/calendar code; an explained technical proposal; a linked technical version; two repository-specific Stories; retained evidence and a visible overall result.
3. **A technical starting point:** a framework migration or infrastructure change authored directly as technical work, with contracts, compatibility constraints and verification, without a fabricated business parent.
4. **Leave and continue:** save offline, restart, reconnect, synchronize, open on another laptop, reattach a required local document/image, and continue without repeating settled questions.
5. **Change after work starts:** publish a new business rule, inspect the affected technical detail and Stories, then apply an authorized update to selected work while preserving untouched work and older evidence.
6. **Concurrent writing and failure:** a manual edit races a Copilot proposal and a shared draft; comparison preserves each version; an uncertain synchronization or work-creation result is reconciled once.

## 14. Qualification targets

The following are implementation targets to measure, not claims about the current release. Measurements separate UI feedback, local durability, source processing, model time and network time.

| Area | Target and measurement |
| --- | --- |
| First interaction | A known local draft is editable without waiting for network or full validation. Target p95 first usable editor within 1 second on the recorded qualification hardware. |
| Typing | Target p95 input response below 50 ms; no Node invocation or Git operation per keystroke. |
| Local save | Default idle delay 750 ms; target p95 durable snapshot within 250 ms after the delay or explicit save request, measured separately from network. |
| Background sync | Default 10 seconds quiet / 30 seconds minimum automatic publication interval per library; report actual queue, Git and remote durations. |
| Library reads | One bounded shared snapshot per invocation; default advisory freshness 30 minutes, configurable, with explicit refresh. |
| Source work | Reuse verified content observations and read selected/changed inputs; report file count and bytes. No implicit workspace-wide scan for each draft change. |
| Size handling | Preserve explicit bounds and pagination. The existing 256 KiB prose ceiling is the initial compatibility baseline; a limit is explained with split/export options and never silent truncation. |
| Observability | Record timing categories and operation outcomes without raw source bodies, attachment bytes, secret values or full chat transcripts. |

The matrix includes a small repository, a 10,000-file repository, a large selected code area, long specifications, multiple parents, mixed documents/images, a slow remote, an unavailable remote and an uncertain push. Test Mac and Windows natively when authorized. Paid live Copilot and Windows CI runs require the user's explicit go-ahead; deterministic fixtures and local UI checks can run first. An unexecuted platform or host case remains unqualified and is not hidden by a passing aggregate.

## 15. Implementation milestones

| Milestone | Deliverable | Exit criteria |
| --- | --- | --- |
| M0 Contract and compatibility | Inventory the existing Studio, type model, schema/read boundaries, signing rules, shared context and publication queue. Finalize new record families and migration fixtures. | The design names a single owner for each authoritative record and every old reader path; no historical rewrite is required. |
| M1 Specification kinds and relationships | Business/technical metadata, stable requirements and explicit parent/implementation mappings, with legacy reads unchanged. | AC-001, AC-002, AC-018, AC-019, AC-020, AC-031. |
| M2 Reliable saving and shared drafts | Local autosave/restart, background state checkpoints, bounded publication, conflict comparison, backup and cleanup protections. | AC-006 to AC-011 and failure injection for save/sync uncertainty. |
| M3 Simple editor and sources | Write together layout, rich editing, source attachment, history and honest save/read states. | AC-003 to AC-005, AC-016, AC-017, AC-033. |
| M4 Copilot co-creation | Focused version-bound proposals, batch acceptance, question reuse, research support and bounded current-task repair. | AC-012 to AC-015, plus the manual path remains fully functional. |
| M5 Work creation and change visibility | Technical derivation, Story intake handoff, larger-work breakdown/linking, multi-repository contracts and coverage. | AC-021 to AC-029, AC-034 and AC-035, including the required end-to-end journeys. |
| M6 Qualification and rollout | Cold/warm measurements, crash/concurrency tests, native host checks and migration qualification. | All applicable acceptance criteria have retained results; remaining unqualified hosts/platforms are listed explicitly. |

Each milestone leaves a usable product path. Advanced grouping can follow a reliable single-spec authoring and Story-creation path; it must not delay safe saving. Release notes and compatibility fixtures identify the exact supported schema and application versions.

## 16. Review decisions fixed by this proposal

- The default experience is Write together, with a simple idea entry state and no required seven-screen sequence.
- Business and technical are specification kinds. Goal, Initiative and Story describe related work scope.
- Business-to-technical drafting creates a linked specification and preserves the business source.
- Saving is always allowed for incomplete drafts. Reviewed readiness remains an explicit, policy-controlled action.
- Shared draft checkpoints live on the configured state branch; raw attachments and source caches stay local.
- A Story starts with exact reviewed specification inputs and keeps them until an authorized change.
- Source reading, model calls and quality checks are incremental; normal editing does not repeatedly validate Git or scan the repository.
- Existing signed records, approvals and Story history are preserved through compatibility-aware readers and migrations.

## 17. Existing contracts to reuse

- [Accepted Spec Studio contract](SPEC-SPA-v1.3-SPEC-STUDIO.md) and [implementation inventory](SPEC-STUDIO-S0-INVENTORY.md).
- [Specification IDs](../src/spec-library/ids.mjs), [draft snapshots](../src/spec-library/draft-store.mjs) and [revision library](../src/spec-library/library.mjs).
- [Proposal validation](../src/spec-library/proposals.mjs), [research](../src/spec-library/research.mjs), [quality checks](../src/spec-library/check.mjs) and [Copilot tool](../apps/vscode/src/views/spec-studio-tool.ts).
- [Story slices](../src/spec-library/slice.mjs), [allocation](../src/spec-library/allocation.mjs), [splitting](../src/spec-library/split.mjs) and [usage receipts](../src/spec-library/usage.mjs).
- [Studio controller](../apps/vscode/src/views/spec-studio.ts), [model](../apps/vscode/src/views/spec-studio-model.ts) and [page](../apps/vscode/src/views/spec-studio-page.ts).
- [Schema migrations](../src/schema-migrations.mjs), [state-branch publication](../src/ledger.mjs), [shared context](../src/execution-context.mjs) and [backup](../src/commands/backup.mjs).
- [Goals and outcomes](topics/goals-and-outcomes.md), [Initiative orchestration](../INITIATIVE-ORCHESTRATION.md), [workflow decisions](topics/workflow-decisions.md) and [recovery](topics/recovery.md).
