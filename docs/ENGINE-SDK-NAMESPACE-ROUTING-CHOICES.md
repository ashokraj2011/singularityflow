# Human route choices over namespace storage

`decision.context` is a new read-only registry operation. It returns the exact pinned question,
its generation, permitted options, allowed earlier steps, current observed revision and retained
source hashes. `decision.choose` keeps its existing v1 SDK input and result contract. The explicit
`hosts/namespace-routing-choice` host implements its writer for reviewed-document workflows.

```js
import { createNamespaceRoutingChoiceEngine } from '@singularity-flow/engine-sdk/hosts/namespace-routing-choice';

const engine = createNamespaceRoutingChoiceEngine({
  records, content, scope: { projectId }, workId, authority,
  access: authenticatedHumanAccess,
  clock: applicationClock
});
const { manifest } = await engine.run('decision.context', { workId });
if (manifest.question) {
  // The application presents these exact options and obtains the person's selection and reason.
  const answer = await askHuman(manifest.question);
  await engine.run('decision.choose', {
    workId, expected: manifest.question.key,
    option: answer.option, reason: answer.reason
  });
}
```

The application authenticates the human through `access.current`, which receives the project,
Story, `decision.choose` operation and cancellation signal. New effects require fresh permission
and membership in the pinned question's approval groups. The prompt's agent is audit context,
never human authority. The namespace profile requires an exact `expected` question key and a
nonempty reason. Existing native CLI optional-key behavior and rendered outputs are unchanged.

## One question and one verified transition

The read owner uses the canonical lifecycle head, actual submitted packet and immutable human
votes. It recomputes quorum and the pinned pause outcome, verifies the original question key,
then checks the final head, locator and authority. A read-only projection cannot substitute for
these owners. No question is an explicit `question: null`, including after Story completion.

The kernel reuses the existing choice interpreter, dependency checks and rework rules. An explicit
forward/end option advances or skips only its selected route. A manual rework opens its actual
range, invalidates affected votes and decision values, preserves generation counters and records
the change request and additional round. An enforced condition cannot be changed into a passing
verdict. A human may explicitly request earlier rework after automatic rounds are exhausted;
that creates another actual repair round, without another automatic retry or fabricated success.

This first host requires the whole workflow to have the supported document-review responsibilities.
Application delivery, full final-Story obligations, source review, visual witness, execution and
other production policies still need their real runtime owners. An end choice cannot use this
profile to bypass those owners. Native Git continues using its existing policy implementation.

## Generations and immutable contracts

New routed approvals keep the outer v2 vote profile and write the explicit nested
`sflow-namespace-phase-approval-routing/v2` contract. Its question identity hashes the actual
generation together with the pinned question payload. Two generations cannot alias the same
question when an application clock returns equal timestamps. The original v1 routing profile
still hashes its native payload and remains readable without rewriting its bytes or key. An
actual pre-upgrade vote is retained as a wire-compatibility fixture.

A choice writes `sflow-namespace-routing-choice/v1`, binding the exact question, original approval
reference, configuration, original canonical revision, authenticated human and agent, normalized
request, reason, selected outcome, authority group and timestamp. Typed
`sflow-namespace-routing-choice-receipt/v1` links retain it through later phases and generations.
Receipt inventories reject duplicates, malformed entries and unknown future versions explicitly.

## Retry, concurrency and recovery

A new mutation is conditional on the current canonical state, authority and configuration.
Permission and actor checks run again before acceptance. A revoked preparation stays retained and
can resume under restored permission without sampling another timestamp. Concurrent choices can
accept only one question transition.

An original authenticated human can acknowledge the exact normalized request after completion,
rework or same-epoch fencing. A different prompt agent is allowed for acknowledgement; it cannot
replace the recorded audit agent. A different person or changed request cannot claim that receipt.
Acknowledgement verifies the original prepared operation, committed receipt, immutable basis,
actual approval/packet evidence and complete reconstructed proposal. A changed live receipt
pointer cannot substitute another result. No new permission or clock sample creates a second
choice. The v1 result's revision and next phase describe that original transaction; query current
state before selecting a new action.

Lost acknowledgements, actual storage deadlines, read permissions, missing content and unsupported
schemas preserve their original error identity. Retry does not recreate the Story. Cross-epoch
archival acknowledgement and authority migration remain Phase 8 work.

## Ownership and remaining scope

The SDK owns the registered read/write coordination, the kernel owns routing and admission rules,
SDA owns retained records/bytes and the conditional commit, and the host owns authentication and
human interaction. Contracts and kernel modules have no filesystem, process, provider or Git
dependency. Architecture guards restrict the explicit host and its read-only proof service.

Phases 5, 7, 8 and 9 remain open: remaining native query/policy extraction, one complete headless
Engine composition, actual application/test and other production policy execution, verified
migration, adapter/distribution qualification and performance comparisons retain their full scope.

## Mac qualification

On macOS 26.7.2 / Node 26.12.0, 219 distinct checks across 18 affected files passed in their
respective final runs, without unresolved failures, cancellations or skips. The namespace journeys
exercise actual filesystem, SQLite and application-backed state: approved questions, human
continuation/end, manual rework after a limit, equal-clock successor generations, lost
acknowledgements, revoked/restored permission, concurrent choices, altered receipt links, missing
content and future schemas. Native CLI approval/decision parity, immutable v1 vote bytes, actual
old v1 routing bytes and native compiler/interpreter goldens also passed.

The isolated packed archive passed 19 checks. Its new separate-process journey performs real
creation, document authoring, publication, submission, independent human approval, question read
and human route choice, then acknowledges the original receipt without new permission or clock.
The consumer has no SFlow checkout and an empty executable PATH. NodeNext declarations passed.
Initial failures were invalid fixture declarations and an unsupported application fixture caught
by the earlier planned-claims gate; corrected final cases retain those production safeguards.

Source validation passed 3,842 checks across 191 skills; VS Code typechecking and the existing
2,011-site Git ownership audit passed. All 13 bundle budgets passed with unchanged ceilings:
gateway 851 modules / 6,860,814 bytes; extension 152 modules / 1,291,045 bytes. The SDK preview
contains 51 registered operations, 119 owned modules and 1,249,999 runtime bytes. These checks
qualify this document-routing slice and existing native compatibility, without claiming complete
application execution, cross-epoch migration or final distribution/performance qualification.
