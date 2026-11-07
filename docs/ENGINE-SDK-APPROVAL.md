# Engine approval operation

`phase.approve` is the approval entry in `sflow-engine/v1`. `approvePhase(inputs)` is a helper over
that same registry entry. Its port stages are `load`, `prepare`, `commit` and `finish`; the operation
is explicitly marked as a human decision. Ordinary publication and submission do not grant it.

The pure SDK validates detached, bounded JSON before calling a trusted port. Approval inputs are:

| Input | Meaning |
|---|---|
| `workId`, `phaseId` | Optional explicit Story and phase selection |
| `confirmation` | Exact `{workId, phase, generation, reviewPacketSha256}` the person reviewed |
| `selectionReceipt` | Existing one-time, ready human-selection receipt, as an alternative to explicit confirmation |
| `fetch`, `agent` | Existing fresh-checkout selection and phase-agent context; neither grants authority |
| `checklist`, `witnessMappings`, `bindingDecisions` | Answers the existing approval gate accepts |
| `decisions` | `{digest, answers}` for the current decision list, using JSON choice/reason/expiry values |
| `confirmEvidence`, `evidenceReason` | Explicit human evidence confirmation and its reason |

Actors, authority groups, signed presence, precompiled decisions, supplied decision packets and
executable callbacks are not operation inputs. The native adapter resolves the current identity,
pinned groups, presence requirements and actual pending decision list through the existing owners.
A confirmation binds content; it does not authenticate a person or replace any authority check.
An integration must obtain the person's actual confirmation rather than manufacture it.

For the current Git composition, the existing Node API exposes the operation:

```js
import { createSflow } from '../src/api.mjs';

const sflow = createSflow({ root: '/workspace/repository' });
const decision = await sflow.run('phase.approve', {
  workId: reviewed.workId,
  phaseId: reviewed.phase,
  confirmation: reviewed // the exact confirmation returned by the host's human review
});
```

This is an incremental internal API, not yet the standalone SDK distribution. Query/manifests and
alternate storage compositions are later deliveries of the same migration.

## One native gate and transition

`kernel/approval-policy.mjs` owns pure authority normalization, reviewer matching, thresholds,
self-approval policy and the exact submitted-review binding. The former authority and fallback
module paths re-export these same functions; they do not keep another implementation or identity
registry. Internal consumers use the kernel owner.

`engine-compatibility/approval-transition.mjs` owns the extracted native evaluator and recorder.
Both the preview and recording still run that one evaluator. `state.mjs` retains its original
exports as wrappers, supplying 33 named legacy collaborators. Their responsibilities include
existing source/test bindings, specification coverage, review history, retained phases and accepted
snapshots. This is explicit compatibility debt, not a claim that every rule is already portable.

The evaluator's 34-statement body and the recorder's 14-statement body were compared with the
previous commit using TypeScript's printer with comments removed and newline-separated
statements. Their hashes are, respectively:

- `c2706c562822f3036b75adc56d23e1adfd8e6af72caaa86df97287287f79cea9`
- `493d7357e020edfb790a8b36105e08861a540504d366420e39da4659bb940bea`

Only owner imports, collaborator binding and the evaluator's local name change. Stage order,
identity, threshold, presence, review/history, evidence, terminal evaluation, record bytes and
transition behavior keep their native implementation. No existing project changes authority.

The compatibility port owns native preparation, atomic decisions-plus-approval publication and
post-publication bookkeeping. Human prompts, document rendering, CLI flags and the legacy JSON
projection remain in the command adapter. The command consumes the actual SDK receipt for its
common subject, approval facts and publication fields. A test-only observer verifies the real CLI
projection against that receipt without replacing any domain result.

## Exact consent and effect semantics

The SDK snapshots the submitted binding after `load` and compares the prepared confirmation to it
before `commit`. Missing or stale consent refuses without an approval commit. The native gate
still checks the current submitted packet and publication boundary. A host preview cannot replace
those fresh checks. A selection receipt is spent only after successful publication, as before.

The result has `status: recorded`, an opaque revision, committed/pushed effects, actual actor and
authority, the packet/artifact-set bindings, self-approval, threshold completion and current phase.
A vote below the threshold is a recorded vote; it does not claim the phase advanced. Return/loop
outcomes keep their existing transition semantics.

Cancellation before commit may stop the operation. Once native publication begins, its accepted,
pending or unknown effect is preserved. A failure after commit retains the original error and
attaches `enginePublication` so an embedding host can reconcile the committed effect. Native
refusal codes, causes, recovery records and routes are preserved.

The native admission service and post-transition receipt/session helpers remain shared with other
legacy operations. Their extraction is remaining Phase 5 work; the SDK core itself has no Git,
filesystem, process, provider or command-rendering dependency.

## Mac qualification

The approval regression run passed 176 tests with no failures, cancellations or skips in 312.8
seconds. It includes native and SDK/CLI parity, stale/one-time receipts, authority allocation,
self-approval, signed presence, dirty checkouts, pending amendments, combined decisions, source and
test coverage, review-safe history, and a complete fresh-clone specification-to-release journey.
All repositories, remotes, machine state and human identities are isolated test fixtures.

All five SDK approval integration cases also passed after the final changes. They exercise actual
native commits for exact confirmation, selection receipts, captured CLI parity, two distinct
reviewers across a partial threshold, a refused duplicate vote and a refused unauthorized identity.
The last two refusals leave HEAD unchanged. VS Code typechecking, the 3,547-check source gate,
fresh runtime bundle budgets and npm package admission passed.

The gateway contains 849 source modules: one extracted native transition more than the previous
848. The two pure kernel modules replace their two legacy authority/fallback owners. All byte and
other runtime module ceilings remain unchanged; the gateway measures 6,730,211 JavaScript bytes.
The two existing native Git observations move from the aggregate to the extracted evaluator; no
Git call or process authority is added. New owner files ship in the npm package, while tests and
the observer do not. Windows, hosted CI and live provider runs are excluded.
