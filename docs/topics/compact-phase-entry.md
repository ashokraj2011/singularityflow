---
id: compact-phase-entry
title: Compact phase entry for Copilot
commands: [phase, nextsteps, inputs, review-source]
aliases: [phase-entry]
related: [artifacts-and-generation, approvals]
version: 7
---
# Compact phase entry for Copilot

`singularity-flow phase enter --for-agent --json` combines pause, selected checkout and agent
binding, accepted phase policy, recovery, clarification and reference verification. It is a
model-free read. Pause is checked before Git, workspace discovery or loading Story context.

`ready` describes the checkout/session binding, not publication, passing tests or approval.
Inspect the returned recovery actions and clarification status. Protected/unrelated changes,
required human confirmations and immutable-generation repair still use their exact existing routes.
Recovery and entry actions include verified `commandGuidance`/`copilotCommand` centrally; shell
commands are never interpreted as implicit permission or guessed slash commands. A misclassified
retained screenshot has a scoped evidence-contract review route, not a request to delete it or
commit unrelated source merely to clear the worktree. The reviewed correction can restore draft
ownership without changing prior publications or claiming that visual acceptance passed.

`contextAdmission.allowed` and `contextAdmission.blockers` report the actual composition guards.
They are distinct from `recovery.blockers`, which can contain incomplete draft/tag findings that
an admitted author may repair. A manual worktree review lists the exact unexpected paths;
its evidence-contract route is presented before document inspection and optional source commits.
Do not claim tags are the sole admission blocker while that human boundary remains pending.
When composition is not admitted, relay these blockers and the returned `next` route rather than
repeat document viewing or the unchanged authoring skill. No guard or human confirmation is waived.

An exact, bounded, untracked evidence file may instead be reported as
`contextAdmission.pendingEvidence` with `status: draft-only`. This requires a current prospective
phase, an approved preceding plan owner, intact approved documents and (for code) a verified open
generation intent. It does not add the file to `expectedPaths`. The author can compose and repair
the verified draft while preserving each held file's bytes and the index; do not edit, execute,
stage, delete or use it as passing proof. Staged/tracked unknown evidence, links, protected/unrelated
edits, unsafe Git operations and lifecycle/authority failures cannot use this continuation.

Prepublish and publication independently re-read pending evidence contracts and refuse with
`PLAN_EVIDENCE_CORRECTION_REVIEW_REQUIRED` until ownership is reviewed. An evidence-correction
preview returns `humanReview.surface: human-terminal` and the exact confirmation text. Relay it
to an interactive human terminal; an automated Copilot shell is not that review surface
(`ACTION_TERMINAL_PRESENTATION_REQUIRED`). No phase approval, passing screenshot or test waiver
is implied by preserving an image or correcting its contract.

Prepublish can return `draftRepair.scope: draft-only` and same-turn owned corrections while that
decision is pending. It freshly rechecks the same worktree hold; unknown/protected edits cannot
use it. The bounded repair coordinator may repair other owned findings, but retains the evidence
review in the condition/readiness hash. Fixing the draft never clears or records that human decision.
This also applies to owned coverage gaps found only by recovery while the Markdown draft is ready:
the bound author can repair the planned source/test bindings in the same open generation. Unclaimed
paths, invalid evidence, withdrawn claims and lifecycle/authority findings retain their owner routes.

Prevent that classification mismatch while the plan is still a draft. New/modified obligations
name product source in Expected paths; a retained screenshot or document instead uses fulfillment
`evidence` and its exact current-Story evidence path. An evidence acceptance criterion also needs
a primary visual/inspection row in `## Verification contracts`; prose and passing unit tests alone
do not establish visual correctness. Planned tests remain required by the execution policy.

For any phase configured to own a downstream code phase's planned claims, prepublish can return
`planningEvidenceRepair`: artifact/author-owned hashes, exact before/after patches and their clause,
path and method. It only suggests an explicit, unambiguous declaration, validates the candidate with
the publication parser and never writes it. The bound producer must compare its meaning with the
approved criteria; apply only when `sameTurn` is true and the draft hash still matches, preserving
managed inputs and unrelated clauses, then recheck. Ambiguous/unapproved clauses, unsafe paths,
duplicate anchors and conflicting explicit witness contracts need author reconciliation; existing
primary tests, combinations and assurance are not silently replaced. Reference existing clause IDs
in backticks, not as new bracketed declarations, when the same phase also defines the clauses.

These draft patches are not an amendment or visual acceptance. An already published/approved plan
keeps its exact bytes and uses the reviewed append-only evidence correction or a reviewed successor.
The repaired draft's eventual contract owns its retained file during implementation, without a late
classification appeal. File presence still cannot pass the visual criterion: fresh tests, exact
witness review and the normal phase approval remain independent gates.

After reviewing that entry packet, use:

```sh
singularity-flow phase enter PHASE --work-id WORK-ID --compose --for-agent --json
```

Composition is an explicit mutation of preparation context/audit only, through the existing
composer. It returns `context.text` once and reuses verified immutable prompts when unchanged.
It does not begin or prepare a generation, run tests, commit, push or advance a phase. A retained
publication is not implicitly replaced by a successor. A different Story must be attached first.

A current, verified source review requiring author correction returns
`status: successor-preparation-required`, `successor.targetGeneration` and the exact
`successor.preparation.command`. `/sf-phase` reviews recovery/diffs, executes that explicit
preparation once and refreshes entry before composing. Read-only entry, including `--compose`,
cannot reserve the successor or edit the retained publication. Submitted phases, pending human
dispositions, unverifiable bindings and consumed code intents keep their guarded routes.
This classification uses phase policy, not built-in phase names, including copied/custom workflows.

`/sf-code` and `/sf-phase` consume these packets instead of separate pause/session/status,
recovery, clarification and reference commands. Standalone agents retain a boundary fallback;
they reuse only a verified packet from the current invocation, never an earlier chat's selection.

`/sf-next` begins with `singularity-flow nextsteps --for-agent --json`. That read checks pause
before routing and returns the active binding plus the first enforced-input preview, without
searching skill directories or reading draft documents. Its delegated `/sf-inputs` action uses
that preview and runs `singularity-flow inputs PHASE --for-agent --json` once. Standalone
`/sf-inputs` first previews with `singularity-flow inputs --dry-run --for-agent --json`.

Recording still revalidates the active binding, approved hashes, sequence, agents and preparation
gates. The response identifies the exact audit and artifact paths, hashes and managed-block
verification. Input `generation` is the upcoming preparation generation; `phaseGeneration` is
the retained published generation. A smaller approved summary is labeled as a summary, not
truncation; exact source expansion remains available through its hash-bound reference.

Inputs and nextsteps use one prerequisite resolver. Full CLI guidance retains explicit grounding
composition. Compact guidance delegates composition to `/sf-phase` or `/sf-code` entry only;
custom drafting skills, integrity recovery and other prerequisites keep their explicit routes.
Use the returned continuation instead of another nextsteps or phase-show call. This does not
authorize another lifecycle action in the same turn. Repeated identical budget warnings print
once per CLI operation; different observations and later invocations retain their warnings.

Authoring skills use `phase prepublish PHASE --for-agent --json` once. Prepublish already runs
draft-check internally. Compact checks preserve all findings, correction/repair/risk choices,
fingerprints, warnings, exact commands and test requirements. Omitted verbose observations have
an explicit full-inspection command; the ordinary `--json` contract is unchanged. Required tests
still run freshly at the governed execution transition, not during these read-only checks.

No production token-reduction composer or unqualified cache policy is enabled by this change.
Existing approved-input briefs and exact clause capsules remain the context authority. Token and
Git-call savings depend on workflow content; fewer CLI calls are not a claim of fewer validators.

`/sf-review-source` starts review with `singularity-flow review-source context --for-agent --json`
(optionally name the current phase). The packet includes pause/session binding and every exact
source, approved clarification, upstream specification, published artifact, pinned reviewer,
schema and report template. The authoritative inventory appears once at `reportTemplate.binding`;
no review material is summarized or truncated. `reviewGuide.readOrder` avoids key-enumeration and
repeated inventory/hash lookups. The ordinary context JSON stays unchanged. Explicit status and
human decisions retain their pause/session checks; compact entry cannot make either decision.
