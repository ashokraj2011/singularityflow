# Inspectable operation bindings

`engine.operations` remains the complete, versioned vocabulary. `engine.capabilities` describes
the operations connected by this particular host. Its separate
`sflow-engine-host-capabilities/v1` manifest contains `boundOperations` and `unboundOperations`,
each with the registered ID and port name. Reading it performs no repository, storage, identity,
process or provider access. It is constructed lazily and remains immutable for that engine.

This is a wiring inventory. It explicitly establishes neither readiness nor authority. A bound
publication operation still checks the actual Story, configuration, source, tests, policy owners
and human decisions. Missing inputs, unavailable adapters and permission errors retain their
ordinary operation-level diagnostics. Clients can avoid offering an unbound operation before they
have a Story context; a capability list never substitutes for the operation's fresh checks.

Ports that serve several registered operations can declare an explicit `operations` list. IDs
must be distinct and belong to that port in the registry. The engine captures the selection at
construction; changing the caller's array cannot add another operation. An excluded operation is
refused before the domain port runs, so it cannot accidentally fall through to another owner.
Existing ports without a selection keep their original binding behavior. Narrow runtimes only
advertise coordinators they actually contain.

The namespace composition declares its actual standalone decision and upstream owners, including
the cohort, Code/recovery risk, witness-exception, decision-batch and forward-amendment operations.
The current vocabulary has 93 operations: 42 native Git bindings and 86 namespace bindings before
optional execution. Native terminal plan ceremonies, visual-profile decisions, native narrowing
and reviewed source rollover retain their explicit unbound status in this namespace composition.
Optional local checks and bounded repair remain unbound when their execution port was
not supplied. They are not advertised as connected simply because they occur in the vocabulary.
The same selection is used by dispatch and by the manifest. Native Git composition declares
its existing eight standalone decision implementations and excludes the new namespace-only
actions. Mandatory inputs on the new operations are enforced before any host read, including
for JavaScript callers; an absent report cannot become a retained review.

Mac qualification covers immutable/captured selections, malformed/foreign/duplicate IDs,
infrastructure-free inspection, narrow-runtime ownership, exact errors, existing SDK operations,
namespace diagnostics and an actual offline-installed consumer with NodeNext types. The original
package test and all existing deadline and bundle ceilings remain unchanged. Qualification passes 192 distinct affected Mac checks with zero failures, cancellations or skips.
The original unchanged 34-check package qualifier runs alone in 34.2 seconds under the original
120/60-second bounds. Source validation passes 4,167 checks; schema (6), architecture (92), VS Code
types, native command parity, the 2,011-site Git audit and all 13 original bundle ceilings pass.
The gateway remains 851 of 852 permitted modules.

The unresolved domain owners remain in [the completion ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md).
