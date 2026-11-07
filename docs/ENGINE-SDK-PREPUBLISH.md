# Prepublication inspection

`engine.run('phase.prepublish', {workId?, phaseId?})` and `engine.prepublishPhase(inputs)` inspect
the current review draft through one registered operation. `phase prepublish` uses that same
coordinator. The combined CLI `--publish-if-ready` route still invokes its ordinary prepublish
step, then the exact offered publication; the publication transaction retains its fresh checks.

## Boundary

The SDK captures the Story, selected phase, phase status and inspection generation before the
native check. Kernel selection uses the phase's own generation rules and high-watermark. It does
not enumerate retained document lists or submission history for this binding. Historical inactive
phases keep their original refusal; retained publications keep their own inspection generation.

The kernel owns the three existing readiness conditions: lifecycle, authored-draft readiness and
known recovery prerequisites. Advisories do not become blockers. A `ready` result admits a
publication attempt; it does not establish passing tests or verify a future transaction's exact
binding. The operation neither publishes nor submits anything.

The public `sflow-phase-prepublish-manifest/v1` contains:

- the captured subject, phase, generation, inspection stage and native readiness observations;
- producer, document-quality disposition and draft fingerprint, without an artifact body;
- findings with their original diagnostic text, canonical code, affected phase and kernel policy;
- advisory diagnostics, required-before boundary, upstream owner/issue links and warning count,
  separate from blocking findings;
- the native correction suggestion and local task identity/state/continuation budget;
- explicit false flags for final-binding verification, test execution, mutation authority, human
  review and approval.

Diagnostic text is inert data. It cannot register executable actions, waive a gate, accept a risk
or change ownership. An unresolved upstream owner stays unknown rather than being assigned to
the detecting phase. Finding classification is independent of commands or wording. Integrity and
authority codes keep precedence over nested quality hints. Upstream defects remain with their
earlier owner, and coverage exceptions remain human scope/evidence review rather than an automatic
author correction. Risk eligibility is not risk acceptance. The complete original repair choices,
hashes, staging references and platform commands remain in the private native result used by CLI.

## Native compatibility

`createGitPhasePrepublishPort` binds an explicit checkout. Its native owner loads the accepted
Story, session and existing prepublish service. Model-mode and agent-presentation preferences are
trusted host context, never model-supplied operation fields. CLI, SDK and combined publication
routes keep the existing Git lifecycle/configuration authorities, actor checks and immutable
approval/evidence records. No Git layout or receipt format changes.

The CLI's JSON, agent projection and human display remain its original presentation. It uses one
loaded context and one native inspection rather than loading the accepted Story independently in
both host and adapter. Hook task-check recording stays in the CLI host. Prepublish's existing
local progress/streak observations remain local; the SDK explicitly reports that local progress
may be written while draft, lifecycle, approvals, source and index remain untouched.

Native failures preserve code, identity, cause and recovery. Optional `enginePhasePrepublish`
diagnostics identify completed/pending stages and possible local progress. They never mask the
original failure, retry an unknown check or claim that cancellation rolled back observations.

Generation-needed, source-review-conflict and inspection-generation predicates now share a pure
kernel owner. The old imports are aliases. Installed finding identity/classification also has one
pure owner; the legacy repair/prompt facade re-exports it while retaining host-oriented
continuation wording and runtime attempt identifiers.

## Remaining scope

[Draft-check](ENGINE-SDK-DRAFT-CHECK.md) now shares registered inspection coordination and finding
policy, while keeping authored-draft health distinct from publication admission.
[Reviewed rollover](ENGINE-SDK-GENERATION-ROLLOVER.md) also uses registered coordination;
preparation remains. Native finding
collection, storage and full repair orchestration retain explicit compatibility dependencies.
This operation does not finish their extraction, authorize an alternate backend or migrate an
existing project. Filesystem/database adapters, headless packaging/resume, verified authority
cutover and final removal/distribution/performance qualification remain in the
[migration plan](ENGINE-SDK-MIGRATION.md).

## Local qualification

On macOS 26.7.2 with Node 26.12.0, 428 distinct focused checks pass with no failures, cancellations
or skips. They cover source/bundled SDK/CLI parity, combined publication, all-phase prepublish and
repair behavior, source review, edit guards, retained generations, submitted conformance, linked
upstream owners/issues and unchanged draft/index bytes. Source validation, VS Code typechecking,
all 13 unchanged bundle budgets, Git ownership audit and dry-run packaging pass.

The pure SDK closure has 17 modules / 209,814 input bytes and zero external imports. The gateway
has 851 modules / 6,742,656 bytes. Test repositories/remotes and machine state are isolated;
no real Story, workspace or installation is migrated. Windows, hosted CI and live provider runs
are outside this qualification.
