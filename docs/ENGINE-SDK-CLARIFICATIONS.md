# Retained clarification checkpoints

The opt-in namespace Engine now records real human clarification replies through the registered
`clarification.status` and `clarification.record` operations. Publication binds their actual
receipts to the original phase inputs. Installed Git record formats, command outputs and approval
authority remain unchanged.

## Ownership

| Owner | Responsibility |
|---|---|
| Kernel | Shared response normalization, question limits, conflicts, marker bindings and checkpoint classification |
| SDK registry | One operation vocabulary, bounded data inputs and checkpoint coordination |
| Namespace resource reader | Actual Story source, approved upstream proofs, pinned agent/skill/instruction resources and local-document availability |
| Namespace checkpoint owner | Human identity, current membership, immutable response content and conditional record acceptance |
| Publication policy reader | Replay original context and accepted replies without treating a reference or readiness flag as proof |
| Conditional lifecycle writer | Atomically accept the observed checkpoint revision or its explicit absence |
| Host | Compose model wording, present questions, obtain human replies and render commands |

The shared response rules preserve 61 independently captured native outcomes. Native file reads,
prompt-composition checks, record timestamps and CLI admission remain in their existing owners.
Routing those remaining native effects through a portable operation is still Phase 5 work.

## Context and replies

`clarification.status` returns a versioned read manifest, its SHA-256, actual recorded replies,
checkpoint state and semantic next actions. The manifest identifies the Story, phase, prospective
generation, original lifecycle basis, pinned configuration, template, phase author, source bindings
and ordered resources. It contains references rather than model prose or uploaded document bodies.

```js
const checkpoint = await engine.run('clarification.status', { workId, phaseId });
const result = await engine.run('clarification.record', {
  operationId: stableReplyOperationId,
  workId,
  phaseId,
  agentId: checkpoint.context.manifest.agentId,
  contextSha256: checkpoint.context.sha256,
  responses: humanReplies
});
```

The authenticated responder is distinct from the phase agent. A supplied author hint must match
the approved catalog and pinned phase author; it grants no authoring or approval authority.
New replies require `clarification.record` permission and the existing phase authority membership.
A service principal cannot impersonate the human responder. Clarification does not apply a phase
approval, satisfy independence, advance the Story or move its canonical head.

Identical retries preserve the original operation receipt, timestamp and question IDs. A new
invocation carrying identical replies from the same human can reuse the original record without
another clock. Accepted acknowledgements identify the original context and do not claim that
later phase inputs are unchanged. Another principal cannot claim the original human's receipt.

Appending questions uses the same phase-wide maximum as the native writer. Conflicting replies
need explicit `replace: true` and a human review reason. The previous immutable record remains
available. A material blocking deferral is retained as pending; the human can resolve it in the
same phase. Publication does not accept it as a completed required checkpoint.

Draft-body edits do not change the clarification context. A real input-binding change preserves
the original replies and returns `inspect-binding`, the old/current context digests and an explicit
reviewed replacement route. It does not grant permission to repeat every question. A published
generation reports `published` and directs review instead of opening another question cycle.
An explicitly reopened successor can assess its own inputs and question budget.

## Retention and publication

The checkpoint writer atomically stores an immutable operation manifest, a mutable checkpoint
index and their receipt. Human response bytes are separate immutable evidence content. Both new
acceptance and replay check actual context, original request, actor, history and receipt identity.
Lost acknowledgements preserve real timeout details and can be reconciled by the same operation ID.

`clarification-checkpoint/v1` extends the existing typed publication policy evidence. Required
replies apply to the `governed-agent` route; human publication does not manufacture a reply to
satisfy that requirement. A `when-needed` checkpoint can legitimately have no recorded replies.
Its publication manifest records that absence, without invented questions, answers or assessments.

| Immutable lifecycle profile | Conditional meaning |
|---|---|
| Prepared/manifest 1 | Original lifecycle transaction; unchanged bytes and reader |
| Prepared/manifest 2 | Additional observed shared records must still have their existing revisions |
| Prepared/manifest 3 | Additional shared records can explicitly require absence with `version: null` |

The writer selects version 3 only when a read condition names absence. Versions 1 and 2 retain
their original meanings. State records remain version 2; immutable history is not restamped.
Both preparation and final acceptance check the extra conditions. A racing reply preserves the
old publication candidate, and a fresh invocation selects a new candidate for the updated index.
Historical accepted publications remain readable after later checkpoint changes.

Specification analysis uses only the accepted marker-answer bindings. An answer cannot hide a
marker still present in the authored document: the answer must reach the document. A removed
marker from an earlier publication becomes resolved only with its retained human answer; otherwise
the discrepancy remains. Submission, independent approval and `phase.review.resources` retain the
exact checkpoint document reference, which `document.read` can read without guessing a laptop path.

Uploaded attachments remain device-local. Fresh input reading still requires the matching local
content, with `DOCUMENT_REUPLOAD_REQUIRED` when absent. Historical shared receipt verification
uses declared references and does not require uploading private attachment bodies. Real missing
content, permission errors, timeouts, future schemas and authority refusals retain their own errors.

## Qualification and remaining work

Mac qualification passed 358 distinct affected native/value, namespace, architecture, Git and installed
package cases, with no failures, cancellations or skips. This includes all three storage adapters,
required/optional checkpoints, genuine human membership, deferred-answer repair, source-binding
changes, routed successors, publication races, actual review-resource reads and native remote
clarification exchange. The installed package journey combines checkpoint recording, pinned test
execution, publication, independent human approval and another empty-PATH process.
The native Git configuration, lifecycle and proof conformance cases also passed. Source validation
passed 3,981 checks across 191 skills, including the unchanged Git ownership audit.

The SDK exposes 59 operations across 204 owned modules and 2,041,156 JavaScript bytes. All 13
existing runtime bundle ceilings passed unchanged; the gateway has 852 modules against its
852-module ceiling. VS Code typechecking passed. Windows, hosted CI, live providers, installed
authority changes and real user Stories were not exercised or changed.

This qualifies checkpoint recording and publication replay. The subsequent
[namespace entry integration](ENGINE-SDK-NAMESPACE-PHASE-ENTRY.md) includes the exact retained
answers in an authoring read manifest without putting model wording in the SDK. Remaining native
policy extraction, complete application/code-delivery execution, existing-project
migration/cutover and final distribution/performance qualification retain their Phase 5, 7, 8 and 9 gates.
