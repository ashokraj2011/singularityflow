# Phase entry and authoring context

`engine.run('phase.enter', {workId?, phaseId?, compose?})` enters the bound Story's current phase.
The kernel decides admission and clarification state; the SDK coordinates the native ports. A
host's invocation directory, workspace selection, model preference, prompt wording and command
rendering never become operation inputs. Historical inspection still uses `phase.review`.

This is a context-entry operation. It may materialize context, issue an exact local clarification
staging grant, and update local task progress. It runs no model, test, preparation, code-generation
opening, lifecycle commit, push or approval. An entry result is not publication or completed work.

## Stages

1. `load` observes pause, accepted Story/phase and agent binding. Paused entry returns here, even
   with a non-repository explicit root. An unbound entry calls only its lightweight `finish` route.
2. `inspect` observes existing policy, recovery, references, attachments and execution evidence.
   It returns semantic facts, not instructions or command strings.
3. `compose` runs only when explicitly requested and kernel admission permits it. The existing
   integration composer keeps its saved inputs, reuse, locking, authority replay, personalization,
   attached assets and local evidence delivery. The SDK receives hashes and metadata, never text.
4. `clarify` verifies the existing record and issues the existing staging grant when applicable.
   The kernel derives question/record/authoring permissions from the policy and observed record
   state. A port cannot supply a different checkpoint stage or question permission.
5. `finish` renders the private native packet and updates its existing local task checkpoint.
   Interrupted operation inspection and spent continuation budgets remain visible and preserved.

An explicit SDK root is the project's bound checkout; machine-global workspace selection cannot
redirect it. CLI entry keeps the existing workspace selection and exact binding checks. Neither
form silently attaches another Story, selects another agent, restores files or changes a branch.
Archived Story and historical-phase authoring refusals retain the native authority and recovery.

## Result and manifest

The immutable `sflow-engine/v1` receipt includes a status, subject/phase/generation observation,
context admission findings, authoring and code-generation readiness, composition status and local
effects. Paused and unbound results have no authoring manifest. The SDK's `authoringAllowed` and
`codeAuthoringReady` are false for an interrupted task, even if the underlying phase's input
admission is otherwise valid. Inspecting that operation is required before replay.

An admitted binding has a `sflow-phase-entry-manifest/v1` manifest:

| Field | Meaning |
|---|---|
| `publishedGeneration`, `inspectionGeneration`, `prospectiveGeneration` | Distinct captured generation identities, including allocation high-watermarks |
| `agentId` | The existing bound phase agent, without provider choice or instruction prose |
| `budgets` | Native document preview and supporting-evidence budgets |
| `resources` | Approved input references first, canonical Story source documents next, then active supporting documents |
| `context` | Resolved context generation, delivered/rendered hashes, byte length and native file availability; no body or path |
| `clarification` | Policy/record stage, errors count, response/question counts, context state and exact answer binding |
| `task` | Existing operation identity, resume state and continuation budget, when applicable |
| `readsVerified`, `humanReviewRecorded`, `approvalRecorded` | False; a read plan and byte identity are not consumption, consent or acceptance |

Resources use the existing `story-document` and `phase-document` references consumed by
`document.read`. Retained producer hashes and lengths are captured before inspection. The returned
inventory cannot omit a declared producer or substitute a new expected hash. Private source keys
used to join those records are stripped from the public manifest. Story-source snapshots are
marked for verification on read; discovery does not turn them into retained evidence.

The supporting-document inventory is the active native document manifest offered to this phase.
It includes local files/images, existing Git-stored files and external links. Local availability
keeps its original re-upload requirement and exact expected hash. Links remain references, with
no network fetch. Pinned specification slices and their sources remain in the canonical Story
source pipeline and the native context composer; this read plan does not flatten their entire
transitive asset closure or replace that pipeline.

The manifest is data for an integration. It never says that a body was read merely because a path
or reference was returned. The existing composer and CLI retain prompt/instruction wording and
delivery. A host supplying its own entry port owns that integration text. The Git convenience API
returns only its semantic manifest; its private native packet is used by the existing CLI. No
generic context-body operation or new public prompt grammar is advertised by this extraction.

## Admission and clarification

The shared kernel enforces the existing binding, authoring-boundary, deterministic-producer,
pinned-policy, authoring-route, recovery, worktree-review, reference and approved-input conditions.
Missing phase-required local documents also refuse composition. Draft quality findings remain
repairable; they do not become an additional admission gate. Pending evidence may permit draft
composition only, never evidence acceptance, publication, authority or recovery bypass.

Pure input/checkpoint policy now also owns the accepted upstream input selector, clarification
normalization, marker mode and checkpoint stage. Existing exports are compatibility aliases with
the same values, error identity and messages. Configuration and SKP validation use the pure owner
directly, without importing native clarification record I/O.

Missing clarification records do not mean questions were unanswered. Required missing responses
still prevent drafting; optional ambiguity assessment retains its existing behavior. Complete
records are reused. Stale/incomplete records retain inspection or human-rebinding states; entry
never accepts them or asks settled questions again. Answer binding uses the rendered prompt hash,
not its delivered personalization/local-evidence overlay. Declared invalid hashes remain diagnostic
data while verification fails; they never grant authoring permission.

The CLI's packet retains its native question instructions, exact issued paths, repair actions and
Copilot/Shell/model-free guidance. Task progress remains progress-only and is batched into ordinary
Story publications as before. The SDK does not infer tests, witness acceptance or completed
delivery from source edits, context composition or a task checkpoint.

## Compatibility and remaining work

The old entry and authoring-entry signatures forward through the registered operation. The
binding-only helper remains shared by existing session, next-step, input and source-review reads;
its current-phase selection uses the same kernel owner. The native authoring implementation is
split into observation, integration composition, clarification, presentation and local checkpoint
stages. The host retains its previous packet and wording; the kernel does not render them.

All native Git/configuration authorities, saved records/hashes, human approvals, staging rules and
normal CLI results remain installed. Canonical native errors keep their identity, code, cause and
recovery. On failure/cancellation the SDK may attach `enginePhaseEntry`, recording completed and
pending stages and whether local effects may exist. It does not retry an unknown stage or claim
that cancellation rolled back files, staging or task metadata.

This delivery extracts entry coordination and its read-plan manifest. It does not finish the
portable prompt/asset inventory, preparation/code-generation/prepublish admission operations, or
the remaining native policy extraction. Alternate storage backends, portable execution/resume,
explicit existing-project migration and final distribution/performance qualification remain in
the full migration plan.

## Local qualification

On macOS 26.7.2 with Node 26.12.0, 330 focused checks pass without failures, cancellations or
skips. They cover the SDK protocol, native/source/bundled parity, clarification repair, task
continuation, local-document takeover, configuration validation, unchanged Git conformance,
architecture guards and cold-start boundaries. Source checks, VS Code typechecking, all 13
unchanged runtime budgets, the Git ownership audit and dry-run packaging pass.

The SDK has 15 pure modules / 187,008 input bytes and no external imports. All native fixtures
use isolated machine state and local bare remotes. No real Story, workspace or installation was
changed. Windows, hosted CI and live model/provider runs are outside this qualification.
