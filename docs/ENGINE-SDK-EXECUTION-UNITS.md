# Standalone execution units for the Node SDK

The SDK exposes an explicit operational port through `execution` and a local implementation
through `execution/node`. Importing the core engine or port-binding entry selects no executor.
The Node entry uses the existing SGOS execution-unit v1 protocol and can run outside an SFlow
checkout with an empty PATH. Its constructor requires explicit local bindings.

## Ownership

The Node execution host owns manifest/task validation, bounded sessions and event streams,
candidate collection, process supervision, executable-byte checks and registry authorization.
Installed Copilot selection, repository configuration and model invocation belong to the GVM
integration. Existing `sgos/execution-units.mjs` imports remain a compatibility facade over
those owners. Production dispatch selects its owner directly.

Shared SGOS record serialization moved to the foundation with its existing finite-JSON,
plain-object, unsafe-key and cycle semantics. Native execution hashing and SGOS record hashing
use that same owner. Captured manifests, task contracts, handles, events, stop/quiescence receipts
and failure fields from `02a68ef23` verify their original v1 meanings without restamping data.

Native process-value helpers have a separate owner used by both platform process dispatch and
the local executor. Git host-selection imports retain their compatibility exports. Standalone
execution loads no Git, workspace, installed provider, configuration or lifecycle module and
performs no Git executable selection.
The existing Windows system-tool and descendant-termination behavior is preserved through
explicit process callbacks. The audit relocates the existing executor's three sites and keeps
the reviewed total unchanged.

## Explicit capabilities

`captureExecutionUnit` captures the eight operational methods without invoking them. Plain
objects and class-based adapters are supported; accessors are refused without being evaluated.
The embedding host supplies the implementation. Method capture establishes no authorization,
test result or lifecycle authority.

The Node manifest binds an absolute executable, its SHA-256, fixed argument array and approved
environment allowlist. Registry authorization is required at execution time. The retained v1
generic profile requires an externally attested sandbox, denied network and empty repository
and Device scopes. Process output is bounded JSON; candidate output cannot certify a task or
phase. The deterministic unit shares the same candidate/event protocol.

A stop is checked before launch and after asynchronous authorization and executable inspection.
An acknowledged stop interrupts a pending preflight wait, including an authorization callback
that never resolves. Completion of that callback later cannot launch the command. Active process
stops retain the existing tree signaling, close and collection behavior. The original stop reason
and ordinary provider/preflight errors remain distinguishable.

## Recovery boundary

Execution handles and buffered sessions belong to the adapter process. A different process cannot
reconstruct an execution from its digest: it receives `SGOS_GEU_HANDLE_STALE`. Portable durable
attempts, leases, uncertain-effect reconciliation and retained phase-check evidence remain a
separate SGOS/engine integration gate. Applications must use that owner rather than infer an
accepted phase or automatically repeat an unknown external effect.

This component does not migrate an installed project or complete application publication.
Remaining phase policy/query extraction, production execution ports, the full cross-agent
application Story, existing-project migration, authority cutover and final distribution/surface/
performance qualification retain their Phase 5, 7, 8 and 9 scope.

## Mac qualification

The affected regression run passed 445 checks across 20 files. A subsequent, separately installed
SDK consumer passed all 20 package checks against the final implementation. Neither run reported
failures, cancellations or skips. Coverage includes captured SGOS v1 records and error identity,
pending and active cancellation, process-tree termination, runtime recovery, leases, concurrent
state changes, compatibility imports, isolated execution and NodeNext declarations.

Source validation passed 3,866 checks across 191 skills. VS Code typechecking, the unchanged
2,011-site execution audit and all 13 existing bundle budgets passed. The optional SDK retains
51 registered operations and builds from 131 source modules / 1,321,846 generated JavaScript bytes. The gateway stays at
851 modules, the extension at 152, Help at 135, support at 111 and prewarm at 23; no ceiling was
raised. These are compatibility and packaging checks, not an end-to-end performance measurement.

All execution used isolated local fixtures on this Mac. No Windows or hosted CI, live provider,
product installation, real-project migration, merge or push ran.
