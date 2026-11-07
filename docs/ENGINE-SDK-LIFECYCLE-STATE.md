# Pure lifecycle state updates

The kernel owns aggregate advancement, skipping, rework invalidation, decision-round resets,
automatic disposition inspection and completion-phase selection in `kernel/lifecycle-transitions`.
The same aggregate module owns the submitted phase's disposition, normalized decision-input
record and recording an already-checked human vote. Submission preflight reuses its input plan
without applying a mutation.

These functions update an in-memory proposed aggregate. They perform no Git, filesystem, process,
provider or session operation. They receive timestamps, evaluated waiver observations and checked
approval facts explicitly. They do not derive authority from those arguments, authenticate an
actor, evaluate a waiver, verify a review packet, execute tests, publish a transaction or select a
storage backend. A private helper is not an alternate public write API.

The installed native owners keep their existing sequence:

1. Resolve the accepted Story/configuration and enforce actor, phase, source-review, evidence,
   application-review, pending-publication and other admission checks.
2. Execute required tests and verify their retained results, code bindings and terminal readiness.
3. Apply the shared phase state update at the same checkpoint as before.
4. Reconcile routing, retained phases, intervals, managed metadata, approved snapshots and receipts.
5. Commit through the original verified transaction/publication and recovery path.

The submission checkpoint still precedes policy-waiver evaluation. Application-review checks
still precede the disposition update. A required human review or reviewable test failure clears
an earlier automatic waiver and leaves the phase awaiting approval. A permitted no-approval or
evaluated-waiver completion records its original disposition and waiver fields without inventing
a human approver. Exact waiver proof fields remain the native evaluator's responsibility.

Human votes are recorded only after the existing approval evaluation. A partial threshold records
the vote and clears an obsolete automatic disposition, while retaining the submitted artifact
bytes. Reaching a checked threshold updates the same approval time and owner as before. Routing,
change requests, signed presence, evidence promotion and persistence retain their original owners
and ordering.

Decision-input normalization now has one kernel owner for SDK preflight and native recording.
The native adapter samples its clock and actor key only after normalization succeeds. A retry
without new values returns the original record; it does not restamp or replace it. Request
arguments still cannot provide authority, checked gate facts or a transition callback.

All production consumers use the kernel aggregate module. The original root module retains its
public compatibility exports with identical function objects. Cancellation error text and its
existing Copilot/Shell recovery commands live in the host continuation presenter, so that text
does not enter the kernel dependency graph. Fourteen original aggregate/helper function bodies,
including the private phase-index validator, are checked against `80324fbe1`.

This extraction removes duplicated update logic from the legacy aggregate and separates state rules
from native submission and approval orchestration. It does not replace the remaining native
checks, worktree observations, completion logging or record writers, and it does not establish
namespace-store lifecycle authority. Portable writer composition and verified migration remain
separate delivery gates. Existing Git behavior and authority remain unchanged.

Mac qualification on Node 26.12.0 passed 145 checks across 18 test files, without failures, skips
or cancellations. This includes actual source/bundled CLI publication, submission, approval and
rejection; application-review repair; routing/loop-limit journeys; the installed SDK archive;
and the source ownership guards. Source validation passed 3,693 checks, VS Code typechecking and
all 13 existing bundle budgets passed, and the Git audit retained its 2,011 production sites.
The gateway remains at 852 modules. No Windows, hosted CI or provider run was used.
