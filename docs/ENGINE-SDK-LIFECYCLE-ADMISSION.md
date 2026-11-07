# Lifecycle admission and host confirmation

The kernel now owns phase-sequence decisions, gate-mode interpretation, confirmed sequence
state updates, read-only agent classification and source-review compiler constraints. Native
publication, submission, approval, rejection, document handling and preparation reach those rules
through their existing adapters. Structural workflow simulation uses the same sequence facts.

`sequenceAdmission` returns semantic reasons and the proposed reconciliation, without commands,
model instructions, terminal prompts or state changes. A soft gate is still a refused judgement
until its owning host obtains the required explicit confirmation. Pending human decisions and
cancelled Stories remain invalid transitions even when sequence gates are configured as soft.
Sequence reconciliation updates only a proposed aggregate; it does not grant approval, verify
evidence or persist a lifecycle event.

The root `sequence` module keeps the existing public result shape and exact reason wording. It
also owns hard/soft diagnostics, terminal/editor confirmation, session/clock observations and
override audit records. The confirmed state helper runs at the same checkpoint as before, after
the native confirmation and its audit record. Published artifacts and history remain retained;
the same affected old approvals and decision state are invalidated by reconciliation.

Read-only role eligibility is independent of host wording. The existing host continuation presenter
projects the kernel facts into its existing error/action objects; the old agent-policy import stays
a compatibility alias. Source-review policy normalization and
reviewer/author separation use one kernel owner shared by the compiler and compatibility exports.
The normalizer's optional reviewability predicate remains a trusted structural compiler input;
the registered SDK's JSON request contract does not accept such callbacks. Agent role eligibility
does not authenticate a human approver or replace membership, presence or exact-packet checks.

The extraction also corrects two edge cases:

- Confirmation callbacks previously used one global variable. Overlapping host operations could
  call each other's callback or lose their callback after another operation completed. Native
  confirmation now uses `AsyncLocalStorage`; nested scopes, explicit callback arguments and
  rejected operations retain their established behavior. This is host coordination, not a new
  kernel confirmation or authority mechanism.
- Phase selection and confirmed reconciliation now require owned phase dictionary entries.
  Inherited names such as `constructor` cannot masquerade as configured targets. An explicitly
  owned configured phase with that name still works. This corrects malformed target handling
  without changing valid workflow outcomes or broadening soft-override permission.

Before production edits, 56 native result/error/aggregate cases were captured from `0dadcea09`.
They cover current and closed workflows, explicit/unknown targets, pending decisions, cancellation,
soft modes, confirmed state changes, agent modes, review-policy validation and author/reviewer
collisions. Six moved function bodies retain their original fingerprints. Further tests exercise
the confirmation race, semantic read-only decisions, retained bytes/approval invalidation, inherited
targets and execution with infrastructure refused and an empty PATH.

Structural guards keep policy in the kernel and confirmation/rendering in the native host. The
build identity includes the shared admission/transition owners, and staged CLI payloads require
both files. Submission readiness and workflow simulation no longer import the terminal sequence
module solely to obtain these state rules.

This advances Phase 5 admission extraction. Required evidence, documents, source review, generation
intent, actual tests, final bindings and native transaction/recovery checks remain enforced by their
existing owners. Production namespace-backed lifecycle ports, complete headless Story execution,
verified authority migration and final removal/distribution qualification remain unfinished.
Installed Git behavior and authority are preserved for valid workflows.

Mac qualification on Node 26.12.0 passed 442 checks across 27 files, with no failures, skips or
cancellations. It includes the original output/body fixtures, concurrent confirmation regression,
real CLI/SDK publication/submission/approval/rejection, source-review correction and decision
journeys, workflow compilation/simulation, namespace persistence, the installed SDK archive and
VS Code packaging/staged CLI checks. All repositories, remotes and machine state are isolated.

Source validation passed 3,714 checks; VS Code typechecking, the Git ownership audit (2,011 sites),
all 13 unchanged bundle budgets and whitespace checks passed. The first bundle check found one
extra module from the new pure admission owner. Consolidating role presentation into the existing
continuation owner and retaining the old path as an unused compatibility alias restored the
gateway to 852 modules / 6,790,673 bytes. Its limits were not raised. Native `sequence` shrank from
484 to 412 lines. These are ownership/artifact measurements, not command-latency claims.
No Windows, hosted CI, live provider, install, merge, push or real-project migration ran.
