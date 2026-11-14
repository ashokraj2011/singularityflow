# Cancellation and Code/recovery execution reuse

This delivery belongs to Phases 5 and 7 on `codex/engine-sdk-foundation`. It adds an explicit
namespace execution profile. It does not migrate an installed Git project, change an old
agreement, approve a phase or complete the other owners in the completion ledger.

## Cancellation ownership

The durable SGOS wrapper now carries the caller's abort signal through execution startup.
It checks cancellation before acquisition, after the asynchronous ownership claim and immediately
before starting the concrete executor. Registered checks and bounded repair pass that signal
through the same wrapper. Cancellation during the lease acquisition cannot start a late check or
repair. Cancellation after an execution is claimed preserves its recovery record; it cannot
silently start a replacement process.

A confirmed quiescence receipt may identify a terminal event beyond the first observation batch.
The wrapper retains additional batches until it reaches that exact event head, reaches the
existing event bound or makes no progress. It still validates the positive receipt against the
retained events. A negative receipt, a missing suffix or another head is a protocol failure.
The repair coordinator waits for actual termination when cancellation races with collection.

The regression cases fail against the original durable wrapper and pass against this one.
They cover cancellation inside a real ownership claim, a terminal suffix delivered in multiple
batches and a self-hashed negative quiescence receipt. These reproduce two concrete defects;
they do not establish the exact origin of every earlier intermittent load-only symptom.

## Explicit receiving capability and agreement

The host opts in through `NamespaceChecksBindings.codeRecoveryReuse: true`. Its units must expose
actual SGOS-qualified environment observations. An ordinary declared executable or caller-supplied
passing flag cannot establish compatibility.

Recovery additionally needs this approved configuration:

```yaml
testRecovery:
  enabled: true
  allowEvidenceReuse: true
  reuseProfile: environment-qualified-exact/v1
  maxEvidenceAgeSeconds: 86400
```

The original normalizer and its captured legacy results remain unchanged. A separate additive
normalizer handles this named profile. Existing failed-test and reduced-coverage policies retain
their independent inventory and authority requirements.

An authorized human reviews `test-recovery.context` with `reuse: 'environment-qualified-exact'`
and confirms its exact returned digest using `test-recovery.confirm`. This produces agreement v2.
The original agreement v1 still says `reuse: 'never'`; enabling a host capability cannot rewrite
that agreement or make it permit reuse. Without recovery enabled, no recovery agreement is needed,
but the original human evidence-reuse decision remains required.

## Original execution and fresh binding

`evidence-reuse.context` and `decision.evidence-reuse` accept an optional exact producer selection:

```json
{
  "phaseId": "implementation",
  "producerPhaseId": "implementation",
  "producerOperationId": "original-full-execution"
}
```

The operation ID names an actual accepted `phase.checks.run`, not a caller report. The producer
can be the current or an earlier phase. A raw accepted execution is explicitly labelled as such;
it has no invented publication or submission. Earlier approved producers keep their actual
publication, submission and approval references. Old artifact hosts cannot reinterpret this
selection as a v1 approved producer.

The new profile requires one complete original passing execution across every current repository
and configured command. Commands, approved configuration, repository selection, application and
test bytes, dependency inputs, runtime digest, arguments, process environment, platform,
architecture and qualified host identity must match. Every required test must have passed without
skips, cancellation or pending cases. The supported command set contains tests only. Mixed
compiler commands, selected suites, failed runs and chained reuse are not eligible for this
profile; current configured execution remains available.

The returned task ID and a genuine human reason authorize an exact reuse decision. The receiving
source and environment are checked again during recording, publication, submission and approval.
Actual read/permission/timeout errors retain their original codes and details. An already accepted
decision replays its receipt; a differently requested duplicate does not add another permission.

For recovery, the approved evidence-age limit applies to a new receiving use. The context exposes
the observed age and removes the decision action when the run is too old. The recording and
publication gates use the same pure age rule. Neither a new reason nor a newer decision timestamp
can refresh the original execution time.

## Retained contracts and downstream evidence

The versioned records are separate from existing records:

| Record | New profile |
| --- | --- |
| Recovery agreement, context value and review | v2, explicitly qualified reuse |
| Reuse decision, context, policy manifest and report | v3 |
| Recovery policy manifest and report | v3, with an explicit execution mode |
| Code policy manifest and report | v39, retaining its original evidence version |
| Approved Code-input manifest and report | v4 |
| Full-execution permission observation | v2, `kind: evidence-reuse` |
| Evidence context and evaluation | v5 |

The receiving publication retains `checks: null`: it did not launch another execution. The phase
can already have an original accepted check operation. Code v39 separately
retains the actual original check binding, reuse policy and report, with `receiverExecuted: false`.
Its existing Code evidence version keeps the original source, plan, repair, acceptance and output
rules. Failed or selected evidence cannot enter through that wrapper.

Verification and Release retain the original execution counts and current original-owner
permission. Full qualified reuse is satisfied evidence; it is not a failed-test waiver or reduced
coverage exception. Selected execution under the qualified agreement remains separately labelled
`reviewed-file-selection`, with unexecuted cases and its original human scope permission.

Expiry and revocation require the original owning phase's reuse context and human authority.
Renewal retains the same producer, source and environment evidence, even while another phase is
active or its original publication is awaiting approval. The original accepted record supplies
the old repository selection; a later phase's selection is preserved. A device with no checkout
or execution port can renew the human permission. Its context explicitly says
`purpose: renew-original-permission` and `sourceObservation: retained-original`; first receiving
use still requires fresh qualified source/environment observations. Generic renewal contexts
select the execution actually consumed by the retained publication, rather than guessing from
unrelated old decisions. Renewal does not recreate the earlier phase, execute again or change
the producer's date.
Original approval records are not rewritten. Visual acceptance and independent approval keep
their separate evidence and authority requirements.

Accepted decisions and publications can replay from shared storage after checkout removal,
without a private draft, executor or new timestamp. An installed offline consumer exercises the
same registered operations and NodeNext contracts without importing native Git/CLI/state modules.

## Qualification scope

The affected Mac suites exercise filesystem, SQLite and application storage; one- and
two-repository execution; independent approval; Code-to-Verification-to-Release consumption;
expiry and original-owner renewal; shared-only replay; old agreement and host refusals; actual
failed/selected execution; changed source/dependencies/environment; duplicate decisions; exact
reader errors; configured age; cancellation and real bounded repair.

The original package qualifier, its deadlines, all thirteen bundle ceilings and existing Git
authority remain unchanged. No Windows CI, live provider, production Story or installation is
part of this qualification. Generalized impact selection, further mixed risk/adapter profiles,
live application review and the other explicit execution owners remain in the completion ledger.

The completed Mac run passes 621 distinct affected tests across 82 files, with no failures,
skips or pending cases. This includes 117 architecture guards, 37 SDK/real-CLI parity cases and
the unchanged 34-check package qualifier. The qualifier ran alone in 72.2 seconds with its
original 120-second parent and 60-second child deadlines. Seven additional offline package
consumers retain their existing limits. Fifteen repeated cancellation modules pass another
30 cancellation/termination checks alongside validation; negative quiescence and split terminal
event batches remain covered separately. Repeated renewal, obsolete permissions, concurrent
requests and lost acknowledgements retain original execution and at most one accepted decision.

Source validation passes 4,426 checks. VS Code typechecking, the unchanged 2,011-site Git audit
and all thirteen original bundle ceilings pass. The gateway stays at 852/852 modules and
6,946,411 JavaScript bytes. The operation vocabulary remains 97. No schema/boundary suppression,
deadline increase, Windows job, production installation or main merge was used.
