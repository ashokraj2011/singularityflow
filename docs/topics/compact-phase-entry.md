---
id: compact-phase-entry
title: Compact phase entry for Copilot
commands: [phase, nextsteps, inputs, review-source]
aliases: [phase-entry]
related: [artifacts-and-generation, approvals, phase-appeals, nextsteps]
version: 13
---
# Compact phase entry for Copilot

`singularity-flow phase enter --for-agent --json` combines pause, selected checkout and agent
binding, accepted phase policy, recovery, clarification and reference verification. It is a
model-free read. Pause is checked before Git, workspace discovery or loading Story context.

## Purpose and prerequisites

Use this topic to understand the compact JSON packets that Copilot skills read before they author,
code or review a phase, and what those packets do and do not permit. They replace separate
pause/session/status, recovery, clarification and reference lookups with one verified read.

- Run the reads from a governed checkout with the Story attached. A different Story must be
  attached first; entry never switches Stories for you.
- `--for-agent` is a boolean flag that requires `--json`.
- Phase entry is a model-free read. With `--compose` it writes preparation context/audit only
  (see the guided workflow).

No production token-reduction composer or unqualified cache policy is enabled by this change.
Existing approved-input briefs and exact clause capsules remain the context authority. Token and
Git-call savings depend on workflow content; fewer CLI calls are not a claim of fewer validators.

## Approval-to-authoring conversation handoff

Approval, nextsteps, phase continuation and phase entry expose the same `contextBoundary` before
next-phase authoring. In a conversation that worked on an earlier phase, `new` means `/clear`, then
`/sf-next`; `compact` means `/compact`, then `/sf-next`. Nextsteps marks Copilot's authoring timing as
`after-context-boundary`. Fresh conversations proceed without another reset; `keep` has no reset.
These are chat operations, not Shell or model-free workflow gates. The approval remains recorded.
Pending publication, recovery and required after-step actions keep their priority.

## Governed execution evidence across phases

Every phase entry includes `retainedExecutionEvidence`, including custom phase names and future
workflows. Composed prompts include the same read-only facts. They come from the latest generation's
immutable submission packets in this Story's Git ancestry, not mutable test-report files or agent
narratives. Each entry names the producer phase, generation, packet hash, evidence commit, source
binding and retained structured test counts when available. Command output and command arguments
are not copied into the prompt.

Keep these distinctions when authoring Verification, Release or any other phase:

- An earlier report written before publication may describe an initial failed command even though
  the governed publication/submission later ran tests successfully. Cite both observations and
  their provenance; use retained execution facts for the governed outcome.
- An IDE saying **No tests found** is a discovery failure. It neither erases a governed passing
  execution nor establishes a new passing test run. This phase having no configured tests does
  not mean its upstream phases have no execution evidence.
- Reuse requires matching source and separately hashed test inputs, committed execution ancestry,
  unchanged check inventory and no pending runner revalidation. A changed binding makes the
  result historical, not current. The recorded runtime describes where the test ran; opening the
  same evidence on another host does not pretend that host ran it.
- A successful command is not proof that every criterion passed. Use exact bound witness results,
  required assurance and any visual/inspection obligations. Missing, failed, skipped or omitted
  results never become acceptance through this projection.

Repair the current open draft to reconcile contradictory prose, using the returned correction
route. Preserve approved reports and decisions. If policy requires new execution or an earlier
phase correction, use the normal owner/human return route; do not edit approved evidence or change
partial conformance verdicts to matched without proof. The projection grants no new authority and
does not run tests, publish, approve or create an extra blocker when old history is unavailable.

Projection bytes and record counts are bounded. Omissions are explicit; inlined records include
immutable packet paths, and inspection routes provide more detail. They are not zero failures. A reused older
generation prompt receives a read-only evidence refresh when necessary; its canonical prompt and
receipt remain unchanged, and the delivered prompt audit records the refresh.

## Use it from each surface

- **Shell:** the packets are ordinary CLI reads, so you can run them yourself to see what Copilot
  sees: `singularity-flow phase enter --for-agent --json`,
  `singularity-flow phase enter PHASE --work-id WORK-ID --compose --for-agent --json`,
  `singularity-flow nextsteps --for-agent --json`, `singularity-flow inputs PHASE --for-agent --json`,
  `singularity-flow inputs --dry-run --for-agent --json`,
  `singularity-flow phase prepublish PHASE --for-agent --json` and
  `singularity-flow review-source context --for-agent --json`. Run `singularity-flow phase --help`
  for the exact forms supported by this build.
- **Copilot:** `/sf-phase` and `/sf-code` start with phase entry; `/sf-next` starts with
  nextsteps and delegates to `/sf-inputs`; `/sf-review-source` starts with the source-review
  context packet. `/sf-appeal` opens the guided evidence-correction review described under State
  and safety.
- **VS Code:** there is no separate phase-entry view. When the current phase needs a generation,
  its **Generate and publish** action in the Story tree (**Singularity Flow: Generate and Publish
  Current Story Phase in Copilot**) only prefills the engine-selected phase skill in Copilot Chat for your review; that
  skill then runs entry. For an evidence correction use **Resolve phase issues → Review evidence
  correction** (also reachable through **Singularity Flow: Resolve Phase Issues and Appeals**).

## Guided workflow

1. Read the entry packet with `singularity-flow phase enter --for-agent --json` and inspect its
   binding, recovery actions, clarification status and `contextAdmission`.
2. If composition is not admitted, relay the blockers and the returned `next` route, then stop.
3. If entry returns `status: successor-preparation-required`, run the returned preparation once
   through `/sf-phase`, then refresh entry.
4. Compose once with `--compose` and use the returned `context.text`.
5. Resolve `clarification.checkpoint`, then author the draft and run `phase prepublish PHASE --for-agent --json` once.
6. Follow the returned continuation. It does not authorize another lifecycle action in the same
   turn.

### Preserve code and finish the remaining authoring milestone

`ready` verifies the Story/session binding. For code edits, inspect `mutationContract` and
`codeAuthoringReady` separately. An unopened code generation returns the exact `phase begin`
prerequisite before edits; review any adoption request, then refresh entry once. A consumed
generation uses guarded successor recovery, never implicit reopening. Successful clarification
recording may need one entry refresh; reuse the delivered prompt and settled replies.

`authoringProgress` is shared by entry, nextsteps and submission readiness for every configured
agent-authored phase, including custom code/repair steps. It distinguishes opening the generation,
creating a missing artifact, completing a prepared draft, validating an authored draft and reviewing
a successor. It does not infer code completion, passing tests or publication from edits or a local
test report. Generation zero can contain completed application work but still lack its publication.

Preserve those source/test changes. Finish the configured summary and Agent brief, reconcile exact
planned bindings and run prepublish. A planned `src/App.test.jsx` obligation cannot be substituted
by passing utility tests elsewhere; implement and verify the actual required test. Routine findings
repair the open draft in place. Publication still requires fresh readiness and its returned command;
human decisions, protected paths and prior-generation integrity are not waived.

The prompt-submission hook announces the bound turn's edit permission and prerequisite before a
tool attempts a source write. `/sf-next` is kernel-only: it returns the explicit configured authoring
handoff, not permission to inline `/sf-code`. The authoring skill completes the summary, repair and
authorized publication, then returns submission guidance; raw edits alone are not its endpoint.

### Read the entry packet

`ready` describes the checkout/session binding, not publication, passing tests or approval.
Inspect the returned recovery actions and clarification status. Protected/unrelated changes,
required human confirmations and immutable-generation repair still use their exact existing routes.
Recovery and entry actions include verified `commandGuidance`/`copilotCommand` centrally; shell
commands are never interpreted as implicit permission or guessed slash commands. A misclassified
retained screenshot has a scoped evidence-contract review route, not a request to delete it or
commit unrelated source merely to clear the worktree. The reviewed correction can restore draft
ownership without changing prior publications or claiming that visual acceptance passed.

### Clarification is a conversation, not a missing question file

`clarification.checkpoint` is presented before large recovery/context bodies. `derive-questions`
permits questions from the pinned evidence while artifact authoring remains blocked. Load the
returned composed context once, derive specific material ambiguities, and ask the human; never
ask the human to supply the questions or unspecified “clarification answers.” In required mode,
if there is no material ambiguity, ask for confirmation of a concise interpretation. A menu
selection promising an answer is not an answer. Record actual replies through the returned
`responseStagingPath` and response-file command; do not invent answers or edit governed records.

`assess-ambiguity` applies the same process only when needed; `off` neither asks nor records.
`inspect-binding` preserves an existing invalid/stale record for exact binding inspection, not
automatic re-questioning or reuse. Question permission never overrides an integrity, ownership,
agent or lifecycle admission refusal. These stages derive from phase policy, not phase names.

Read complete control fields. Arbitrary character slices of a large JSON/context string can hide
the checkpoint and are not evidence that instructions are missing. Read complete named sections
in bounded portions from the same saved packet, without repeated composition or document searches.

### Context admission

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

### Compose preparation context

After reviewing that entry packet, use:

```sh
singularity-flow phase enter PHASE --work-id WORK-ID --compose --for-agent --json
```

Composition is an explicit mutation of preparation context/audit only, through the existing
composer. It returns `context.text` once and reuses verified immutable prompts when unchanged.
It does not begin or prepare a generation, run tests, commit, push or advance a phase. A retained
publication is not implicitly replaced by a successor. A different Story must be attached first.

### Successor preparation

A current, verified source review requiring author correction returns
`status: successor-preparation-required`, `successor.targetGeneration` and the exact
`successor.preparation.command`. `/sf-phase` reviews recovery/diffs, executes that explicit
preparation once and refreshes entry before composing. Read-only entry, including `--compose`,
cannot reserve the successor or edit the retained publication. Submitted phases, pending human
dispositions, unverifiable bindings and consumed code intents keep their guarded routes.
This classification uses phase policy, not built-in phase names, including copied/custom workflows.

### Skills that consume the packets

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

### Prepublish once

Authoring skills use `phase prepublish PHASE --for-agent --json` once. Prepublish already runs
draft-check internally. Compact checks preserve all findings, correction/repair/risk choices,
fingerprints, warnings, exact commands and test requirements. Omitted verbose observations have
an explicit full-inspection command; the ordinary `--json` contract is unchanged. Required tests
still run freshly at the governed execution transition, not during these read-only checks.

### Source review entry

`/sf-review-source` starts review with `singularity-flow review-source context --for-agent --json`
(optionally name the current phase). The packet includes pause/session binding and every exact
source, approved clarification, upstream specification, published artifact, pinned reviewer,
schema and report template. The authoritative inventory appears once at `reportTemplate.binding`;
no review material is summarized or truncated. `reviewGuide.readOrder` avoids key-enumeration and
repeated inventory/hash lookups. The ordinary context JSON stays unchanged. Explicit status and
human decisions retain their pause/session checks; compact entry cannot make either decision.

## State and safety

Phase entry, nextsteps, the `inputs --dry-run` preview, prepublish and source-review context are
reads. Composition writes only preparation context/audit and does not prepare a generation, run
tests, commit, push or advance a phase. Recording inputs (`inputs PHASE` without `--dry-run`) is a
mutation that revalidates its binding, hashes, sequence, agents and preparation gates first. No
guard or human confirmation is waived by any of these packets.

### Evidence-correction review

Prepublish and publication independently re-read pending evidence contracts and refuse with
`PLAN_EVIDENCE_CORRECTION_REVIEW_REQUIRED` until ownership is reviewed. An evidence-correction
preview retains the interactive terminal route and also returns `guidedReview`: the exact
`/sf-appeal evidence-accept ... --review-ui` command. Copilot may open this review once, but must
never answer the form or infer confirmation from chat. In VS Code use **Resolve phase issues →
Review evidence correction**. The engine opens a scrollable local browser page displaying the
captured screenshot, file hash, original/proposed contract, authority and exact confirmation.
CLI flags, stdin answers or fabricated receipts cannot substitute for this review. Cancel, browser failure or
15-minute expiry leaves Story state unchanged. After confirmation, the engine independently
rechecks the file, worktree, owner map, policy and identity before recording an append-only decision.
No phase approval, passing screenshot or test waiver is implied.

This is configured-local human review, not cryptographically authenticated Copilot identity or
protection against another process already controlling the user's desktop. Its private one-shot
loopback page serves only the captured raster, rejects cross-origin requests, embeds no external
resources, and closes after the ceremony. The terminal route remains available on headless hosts.

### Draft repair while that decision is pending

Prepublish can return `draftRepair.scope: draft-only` and same-turn owned corrections while that
decision is pending. It freshly rechecks the same worktree hold; unknown/protected edits cannot
use it. The bounded repair coordinator may repair other owned findings, but retains the evidence
review in the condition/readiness hash. Fixing the draft never clears or records that human decision.
This also applies to owned coverage gaps found only by recovery while the Markdown draft is ready:
the bound author can repair the planned source/test bindings in the same open generation. Unclaimed
paths, invalid evidence, withdrawn claims and lifecycle/authority findings retain their owner routes.

### Preventing the classification mismatch

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

## Troubleshooting

- If entry reports `paused`, Copilot stays native. Only `/sf-pause off` resumes SFlow guidance;
  skills never resume it implicitly.
- If entry is not `ready` or returns no Work ID, select the work first with `/sf-session` or
  `/sf-workspaces` (shell: `singularity-flow session candidates`) and run entry again.
- If a command refuses with `--for-agent requires --json`, add `--json`.
- If composition is not admitted, relay `contextAdmission.blockers` and `next`. Do not retry
  composition or rerun the unchanged authoring skill.
- If prepublish or publication refuses with `PLAN_EVIDENCE_CORRECTION_REVIEW_REQUIRED`, open the
  evidence-correction review once (Copilot guided review, VS Code **Review evidence correction**,
  or the terminal route). Repairing the draft does not clear it.
- If the browser review is cancelled, fails or expires, Story state is unchanged; start the review
  again, or use the terminal route on a headless host.
- If entry returns `status: successor-preparation-required`, let `/sf-phase` run the returned
  `successor.preparation.command` once; read-only entry cannot reserve the successor.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a
  command from the label.

## Related topics

Continue with `sflow explain artifacts-and-generation`, `sflow explain approvals`, `sflow explain phase-appeals`, `sflow explain nextsteps`.
