# Durable execution units for explicit SDK hosts

The optional `execution/runtime` entry decorates the SGOS execution-unit port with durable
attempts, live ownership, retained events and exact candidate results. It uses Operational Store
v1 and immutable-content ports. It selects no repository, provider, Git executable or installed
authority. The engine registry and native execution paths retain their existing behavior.

## Ownership and compatibility

The foundation captures the original eight execution methods, preserving getter refusal,
class-method support and binding semantics. One shared owner supplies the unchanged ABI bounds.
SGOS owns runtime coordination; SDA owns persistence. Stored candidates do not certify tests,
publish artifacts or approve phases. Phase integration retains its own engine owner.

New attempts use a separate `sgos-durable-execution/v1` envelope. Existing execution-unit ABI
records keep their v1 identities and hashes. Installed SGOS leases, live-store admission and
lifecycle authorization remain unchanged.
The frozen ABI schema has one shared admission owner and native registry entry. Missing and
future versions are refused before launch; retained wire bytes are never restamped or migrated.

## Execution and recovery

Before calling the executor, the decorator conditionally accepts an attempt and owner. Only the
winning claimant can launch. Repeating an exact contract cannot launch another attempt while
the earlier execution is live or uncertain. A deliberate new attempt needs a new task contract.
An absent current record is insufficient: the claim checks verified retained history at the same
conditional revision. Operational rollback or deleting the current key cannot make an earlier
command appear unexecuted. Unavailable or changed history never permits a duplicate launch.

Immutable runtime events bind the original handle, sequence and prior digest. Collection requires
a matching started/terminal stream and real quiescence. The candidate's output, contract and
manifest digests are verified. An execution failure retains its original name, code, message and
details. Storage failures remain storage failures; they do not become failed tests or success.

The explicit Node owner issues opaque process-local live capabilities. Stored owner IDs do not
prove another process exited. No expiry, PID guess or missing local handle releases a foreign
attempt or repeats an unknown effect.

A lost launch acknowledgement or post-launch history write leaves an explicit unresolved attempt.
Recovery includes the exact attempt, owner and any actual returned handle. The original error is
retained when storage is available; a later host receives its original code/message as the recovery
cause. Diagnostic-storage failure never replaces the original execution failure.

The original adapter can resume collection using its actual live handle without launching again.
A lost completion acknowledgement is recovered from the genuinely accepted terminal record.
After completion, a fresh Node process can read the same candidate, events and quiescence without
the original session. Missing or changed bytes remain errors. A stop decision keeps its exact reason
on both the original and later hosts. Stopping an already quiescent execution without a prior stop
returns the explicit collection route rather than asking for nonexistent live-owner recovery.

An outage of history storage does not prevent this host from stopping its actual owned process:
the stop goes to the live handle before receipt persistence. A receipt-write failure is reported.
Actual events and quiescence can be collected after storage returns. Requesting a stop never
claims that the process stopped.

## Explicit use

```js
import { createDurableExecutionUnit, createNodeExecutionOwner } from
  '@singularity-flow/engine-sdk/execution/runtime';

const execution = createDurableExecutionUnit({
  unit, store: operationalHistory, content, scope: { projectId },
  owner: createNodeExecutionOwner({ hostId }),
  clock: { now: () => new Date().toISOString() }
});
const handle = await execution.start(taskContract);
const candidate = await execution.collect(handle);
```

The application owns connections, task construction and executor authorization. Importing or
constructing the decorator launches nothing. Candidate results keep their original ABI and gain
no verification fields. Runtime history/content never writes `state`, `config` or `evidence`.

The unchanged 1,024-session and 4,096-event bounds have one shared owner. Operational snapshots
keep their existing entry/event/byte limits. Candidate bodies use separate content under a 32 MiB
ceiling, which the supplied content port must support; namespace metadata and operational state
bounds are not enlarged. Function bindings are captured at construction.

## Mac qualification

The final affected run passed 140 checks across nine files. The separately installed archive
passed all 21 checks, including cross-process execution-result collection with an empty PATH and
NodeNext declarations. Neither run reported failures, cancellations or skips. The archive retained
its existing sequential test order, 120-second parent bound and 60-second child-process bound.

Coverage includes all three metadata backends, competing claimants, uncertain launches, lost
launch/completion acknowledgements, original error retention, live-owner loss, result corruption,
stop-reason replay, real process failure and stopping an actual process during storage failure.
Rollback/current-record deletion cannot authorize another launch of an earlier contract. A
deliberately different task contract remains executable after that explicit recovery boundary.
Captured native ABI records and port-method bindings preserve their existing meanings.

The SDK retains 51 operations and builds from 139 source modules, emitting 1,385,256 JavaScript
bytes. VS Code typechecking, the unchanged 2,011-site Git/process ownership audit and all 13 bundle
budgets passed. No ceiling was raised. All execution used isolated Mac fixtures. No Windows,
hosted CI, live provider, product installation, real Story mutation, merge or push ran.

## Remaining integration

This supplies durable coordination for an explicit authorized executor. It cannot automatically
resolve an unacknowledged effect, restore a dead process or invent a terminal result. Foreign
unresolved attempts retain explicit recovery requirements. Full SGOS recovery-policy integration,
phase-command authentication, structured test-result verification and phase acceptance evidence
remain required.

The namespace engine continues refusing phases with unavailable policy/execution owners. Complete
application Story execution, remaining native queries/rules, existing-project migration and writer
cutover, and final distribution/performance qualification retain their Phase 5, 7, 8 and 9 gates.
