# Phase preparation

`engine.run('phase.prepare', {workId?, phaseId?})` and `engine.preparePhase(inputs)` prepare the
selected phase through one registered operation. The CLI's `prepare` and its legacy `next`
preparation helper use this same coordinator. The configured deterministic convergence service
remains distinct from an ordinary artifact template.

## Inputs and execution

| Input | Meaning |
|---|---|
| `workId` | Optional exact Story binding; does not select another checkout |
| `phaseId` | Optional phase ID, defaulting to the current Story phase |

Actor, provider, model mode, checkout, workflow and adoption overrides are not operation inputs.
The native host binds the checkout and model-mode observation. The kernel captures the Story,
phase and next monotonic generation, selects the existing producer and distinguishes convergence
from an ordinary draft by its accepted contract. Custom phase names do not change those rules.

The port stages are `load`, `prepare` and `inspect`. Native preparation retains the installed
phase sequence and actor checks, required local documents and reference repositories, pending
publication/test-command gates, approved scope, source boundary and expected revision. Ordinary
drafts use the existing local draft transaction. Deterministic convergence uses its existing
locked projection service, including exact source/candidate bindings, retained human decisions
and reviewed legacy migration. A preparation result does not bypass any of those checks.

The private legacy helper can pass the exact accepted context refreshed by `next` and composition.
That collaborator is not available through operation JSON or the public Node API. It avoids
reloading a different Story/context between the existing composition and preparation steps.

## Result meaning

`sflow-phase-preparation-manifest/v1` records:

- the captured Story, phase, prospective generation, producer and preparation mode;
- the required artifact's logical key, with `contentVerified: false`;
- the contract's `authoringRequired` and `codeDeliveryRequired` flags;
- available input-record and open-generation identifiers/digests, their observed generations,
  and whether those generations equal the prepared generation;
- deterministic convergence iteration/hash, counts and still-undisposed item IDs;
- explicit false flags for publication readiness, final-binding checks, test execution, human
  review and phase approval.

The artifact key is a logical declaration, not an issued laptop path, body read or integrity
proof. Record metadata is observation, explicitly marked `integrityVerified: false`; incomplete
legacy metadata remains visibly incomplete. Native edit/publication guards still verify receipts
and source bindings. No additional artifact reads or Git scans are introduced to construct this
manifest. Existing CLI file ranges and scope guidance remain its host presentation.

Authoring flags describe the phase's producer/delivery contract, not a finding that completed
work must be written again. A deterministic implementation summary still requires application
code delivery. A deterministic convergence report can still await human dispositions. Neither
case establishes publication readiness; inspect the current draft and native gates before the
next mutation.

The effect receipt distinguishes a newly opened generation from reuse of an existing open
receipt. Preparation saves local draft state; it does not commit, push, execute tests, invoke a
model, record approval or advance the Story. Configured remote-resource reads retain their
installed behavior. Their URLs, prompt bodies and command wording do not enter the public SDK
manifest.

## Compatibility and recovery

CLI narration, instructions, original artifact paths, file ranges and ordered next actions remain
host projections. Its rendering statements retain their predecessor tokens. Explicit CLI
`--work-id` now reaches the operation's exact Story binding, as it does for the other extracted
phase operations; it cannot silently prepare another checked-out Story.

Native errors retain identity, cause, exit code, recovery details and existing structured refusal
envelopes. Sequence refusals retain `sequence.refused` and their original exit status. Optional
`enginePhasePreparation` diagnostics identify completed/pending stages and possible local
preparation effects. They cannot mask frozen errors, retry an uncertain write or assert rollback;
the installed draft journal remains the recovery owner.

Code-delivery, deterministic-only and kernel-owned interpretation now have pure kernel owners.
The legacy policy exports and convergence-summary path retain function identity. Existing Git
lifecycle, state projection, configuration, approval and record/hash authority remain unchanged.

The portable asset inventory, remaining queries, further native policy extraction and the full
alternate-backend/headless-runtime/verified-migration scope remain in the
[migration plan](ENGINE-SDK-MIGRATION.md). This preparation operation does not complete them.

## Mac qualification

On macOS 26.7.2 with Node 26.12.0, 393 distinct checks across 25 affected suites passed, without
failures, cancellations or skips. They include source/bundled CLI parity, native deterministic
convergence in a full Story journey, generation begin/rollover, phase entry, draft/prepublication,
authoring/recovery contracts, scope/code delivery and import/startup guards. Fixtures used isolated
machine state and temporary local remotes.

Source validation passed 3,633 checks. VS Code typechecking, all 13 unchanged bundle budgets,
the Git ownership audit, npm dry-run packaging and whitespace checks passed. The gateway retains
851 modules. No Windows, hosted CI or live provider invocation was used.
