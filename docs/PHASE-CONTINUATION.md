# Resumable phase continuation

`singularity-flow appeal preflight --phase PHASE --json` presents one policy-driven
journey. It distinguishes draft repair, human evidence-contract review, publication,
source review, explicit visual/inspection witnesses, submission tests and approval.
Its build identity and contract revision distinguish an installed build from a checkout.
No route is itself permission, a successful test, or human consent.
Every phase-entry packet also exposes this read-only continuation review and build
identity, including user-created phases, without adding another automatic inspection.

## Producer work and human decisions

Pending evidence may remain private while the bound producer repairs an owned open
draft. Approved inputs and published generations are immutable. Planning prepublish
uses the publication contract validator; ambiguous evidence cannot silently become
source delivery. Existing planning repair proposals remain source-bound suggestions.

Evidence ownership correction and visual acceptance are different decisions. The
former accounts for the exact screenshot in the plan. The latter binds an authorized
reviewer's checklist to a published candidate and the exact file bytes. The journey
forecasts these witness obligations before publication, and offers the actual witness
route after submission pins fresh candidate/test evidence. Asking earlier would either
refuse as unpublished or become stale on submission. Changed candidates or images
invalidate the witness normally.

Unknown findings have a named owner/diagnostic route. They are not silently bypassed.
Soft quality gates still require exact, eligible human risk acceptance. Integrity,
identity, test evidence and independent reviews are not blanket-waivable.

## CLI and Copilot

1. Preview with `singularity-flow appeal resolve --phase PHASE --json` or
   `/sf-appeal resolve --phase PHASE --json`.
2. Review the current state and returned digest. Explicitly authorize guarded
   continuation only if `continuationAllowed` is true.
3. Run the exact returned `resolve-run` command/confirmation. It may publish and
   submit, running required tests and committing/pushing through the normal CLI
   transactions. It performs at most two operations and never grants approval,
   records a witness, accepts risk or executes repository-supplied command text.
4. Follow the returned author/human/owner action. An interrupted operation uses
   `resolve-resume`, which authenticates its outcome without replaying it.

The VS Code **Resolve phase issues** screen shows the same journey, build identity
and pending witness slots. **Review guarded continuation** confirms the exact phase
before mutation. **Prepare human witness review** opens a terminal with no checklist
answers preselected; the reviewer inspects the published evidence and supplies each
`--confirm`/`--deny` answer and reason.

## Durability and execution boundary

Private append-only continuation events live under the Git common directory. Each
event has a closed schema, exact checkout/Story/phase/generation/intent binding,
sequence and hash chain. Reservation precedes execution; results follow authenticated
reinspection. Corruption is an owner finding, never an automatic journal reset.
Only a bounded, redacted failure diagnostic is retained; raw command output is not
stored. Reopening preflight keeps the failed operation visible. Static readiness
does not erase a refusal or create a new retry budget.

The coordinator owns a separate coordination lock; the child CLI owns the normal
Story transaction lock. Holding the Story lock across the child would deadlock.
Only installed, reconstructed publish/submit argument vectors execute through fixed
Node/CLI paths, without a shell or nested model. Output and runtime are bounded.
Required convergence/source reviews and human decisions stop automatic continuation.

Each generation has at most three guarded operation reservations. An unchanged
operation cannot retry; interruption inspection consumes its original reservation.
This budget does not prevent manual repair, approved rework or existing checkpoint
preservation. The independent producer-repair budget is never reset by continuation.

## Qualification

Tests cover all standard phase names and a future custom phase, exact confirmation
and policy drift, hard integrity boundaries, pending evidence with producer repair,
false success, unchanged retries, journal tampering, crashes before/after execution,
and required review/decision stops. The evidence lifecycle fixture continues beyond
contract correction through publication, fresh submission tests, an explicit witness
and human approval; a custom workflow must reach completion.

Native Windows and installed-extension interactive qualification require those
environments. Source tests and a successful extension build do not substitute for it.
