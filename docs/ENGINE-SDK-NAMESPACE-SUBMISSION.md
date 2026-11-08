# Shared-record phase submission

`hosts/namespace-submission` supplies registered `phase.submit` for the initial portable
primary-document profile. A runner or another laptop uses the published shared records directly:
private drafts, a source checkout, Git, provider access and the original author's laptop are not
required. Installed Git hosts retain their existing submission owner and outputs.

```js
import { createNamespaceSubmissionEngine } from '@singularity-flow/engine-sdk/hosts/namespace-submission';

const engine = createNamespaceSubmissionEngine({
  records, content, scope: { projectId }, workId, authority,
  access: applicationPhaseAccess,
  clock: applicationClock,
  notice: event => applicationLog(event)
});
const submitted = await engine.run('phase.submit', { phaseId });
const review = await engine.run('phase.review', { phaseId });
for (const item of review.manifest.items) {
  const document = await engine.run('document.read', { reference: item.reference });
  // The application presents these verified bytes to its reviewer.
}
```

The trusted access port supplies authenticated `projectId`, `principalId`, `actorKind`,
`identity`, `agentId` and permissions. New submission needs `phase.submit`, the pinned author
agent and fresh sequence, permission, configuration, Story and authority checks. A service may
request submission when authorized; it does not become a human reviewer or approver.

## Supported policy and exact evidence

This host accepts an actual namespace publication under
`sflow-primary-document-publication/v1`, with required human phase approval. It verifies the
canonical phase, exact retained artifact metadata/bytes, publication manifest, approved
configuration and shared input-resource bindings. Private input references remain metadata;
publication and submission do not upload their content.

Additional code, test execution, specification, source-review, clarification, MCP, skill-host,
presence, automatic-approval and other policy requirements need their actual owners. Required
owners remain explicit `ENGINE_PORT_UNAVAILABLE` refusals, not caller-supplied ready flags.
Unknown decision inputs retain the kernel's `DECISION_INPUT_UNKNOWN` refusal. Declared decision
inputs use the [versioned routing-input packet](ENGINE-SDK-NAMESPACE-ROUTING-INPUTS.md), with the
pinned compiler's value rules and original author provenance. `runChecks: false` cannot waive
required execution.

The first accepted submission moves the phase to `awaiting_approval`. It retains no fabricated
test execution, human review, approval or phase advancement. The canonical generation and
published artifact remain unchanged. The result's revision is the real opaque namespace Story
revision, with `effects.committed: true` and `pushed: false`.

## Review packet and one read owner

The versioned `sflow-namespace-phase-review-packet/v1` binds the actual publication reference,
configuration, submitting actor/agent, original source-state revision and time. It does not
reinterpret a storage revision as a Git commit. Its immutable bytes, submission binding, lineage
entry and state update are retained through the conditional lifecycle writer.

Decision-free submissions continue writing exactly that v1 shape. A pinned decision following the
phase selects v2, which adds canonical own inputs and exact earlier submitted-packet references
for reused inputs. Both versions remain readable; old packets are never restamped or given new
routing meaning. Retaining decision inputs does not execute a route or answer a human question.

Every explicit namespace host uses the same read-only publication/submission proof owners.
`phase.review` returns the submitted packet hash, actual source revision and observed current
revision only after checking the retained packet, publication and artifact. The final current-head
and authority check occurs after these proof reads. A moved head or authority cannot acquire a
review binding from a mixed snapshot. Existing read-only projection formats retain their prior
behavior and do not acquire approval proof from metadata alone.

The manifest still reports `humanReviewRecorded: false` and `approvalRecorded: false`. Reading
documents and obtaining their exact binding are prerequisites; [human approval](ENGINE-SDK-NAMESPACE-APPROVAL.md)
uses its own explicit operation owner and records nothing through the read query.

## Interrupted preparation, retry and takeover

The same publication, authenticated author/agent, admitted Story/authority basis and normalized request select one stable
operation identity. A prepared candidate retains its original timestamp, actor and packet. A
different actor cannot accept it, and restoring permission does not restamp it.

Another authorized person may instead submit their own candidate under their authenticated
identity. The first author's pending candidate and the original publication's authorship stay
intact. This does not enroll or approve the new person as a reviewer. Actor selection reuses the
operation's initial access check; it does not add an authorization round-trip.

If an authorized Story operation changes the canonical basis after preparation, the candidate
cannot overwrite that change. A subsequent explicit submission checks the new basis and creates
a distinct candidate when still permitted. The previous immutable candidate remains retained;
its conditional writer cannot overwrite the later state. Rework still requires a successor
generation according to the shared kernel rule.

After acceptance, the shared submission binding resolves the original receipt. Retrying on
another host acknowledges that receipt without author permissions or a new clock sample, even
when the writer has subsequently been fenced. New decision values on an already-submitted phase
are ignored, preserving the existing SDK submission meaning; the notice port receives
`submission.decision-values-ignored`. Cancellation after acceptance cannot report it as undone.

Timeouts, permission failures, corruption, future schemas and unknown acknowledgements preserve
their real errors and details. An accepted receipt is never replaced by a new timestamp or an
empty Story. The new host does not perform automatic migration, dual writes or Git fallback.

## Remaining scope

This advances Phase 7 with actual shared submission and review proof. The explicit approval host
now completes sequential reviewed-document workflows. Full portable publication and approval
policies, decision/routing owners, execution and complete cross-agent application Story journeys
remain required. Existing-project migration, fencing, final cleanup
and distribution/performance qualification retain their separate Phase 8–9 scope.

The shared reader now supports explicit versioned terminal views without changing stored v1
projections. Historical reads remain distinct from accepting an approval or completing a Story.

## Mac qualification

On macOS 26.7.2 with Node 26.12.0, 214 distinct checks across 14 affected files passed with no
failures, cancellations or skips. The focused 146-check set, 79-check native regression set and
43-check final recheck overlap; repeated cases are counted once. They cover actual filesystem,
SQLite and application-backed submission, private-draft isolation, original receipt recovery,
changed actors and legitimate source bindings, different-person takeover, concurrent candidates,
fencing, final read stability, malformed records and original storage failures. Source/bundled
CLI/SDK review, document reads and preparation retain their native compatibility behavior.

The installed archive publishes, submits and reopens the actual packet in independent empty-PATH
processes. Read-only and writer hosts return identical verified review bindings. Installed NodeNext
declarations and negative input examples passed. Source validation passed 3,815 checks across 191
skills; VS Code typechecking, the Git ownership audit and whitespace checks passed. All 13 existing
bundle budgets passed with unchanged ceilings: gateway 851 modules / 6,854,208 bytes, extension
152 modules / 1,289,513 bytes. No new production process/Git site was added.

The SDK preview retains 49 registered operations and contains 109 owned modules / 1,119,564 runtime
bytes. These counts describe the artifact, not full-Story latency or completion of the runtime
milestone. No Windows, hosted CI, live provider, real Story migration, installation, push or merge
ran.
