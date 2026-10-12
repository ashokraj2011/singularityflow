# Phase self-repair: analysis and recommendations

**Status:** Analysis and proposed plan (2026-10-12, main d5f769d9)

**Question:** how should prompts (and whatever they depend on) change so that each phase repairs
itself and a Story in phase 2 never fails in phase 2 because of a phase 1 issue?

**Method:** four read-only reviews of the code at d5f769d9 (cross-phase blockers, the prompt and
skill layer, repair and rework machinery), plus the durable logs, refusal records and Copilot
session logs of real Stories in fourteen local workspaces. The load-bearing code claims were
re-checked by hand. No tests or models were run.

## 1. Summary

Today a defect in an earlier phase usually becomes a **stall** in a later phase. The reasons:

1. **The prompts forbid the wrong move but name no right one.** Every authoring prompt says
   "never re-author an earlier phase" (`phase-authoring-contract.mjs:63`). No prompt, skill or
   template says what to do instead. Agents stop, loop, or work around the defect silently.
2. **The kernel offers no forward path.** A phase can return work only from `awaiting_approval`
   (`state.mjs:7031-7035`). An upstream defect usually stops the phase from publishing, so it
   never reaches that status. Every route that changes an approved earlier phase rewinds the Story
   and resets every later phase (`lifecycle-transitions.mjs:113-137`).
3. **Detection is late.** Much of the cross-phase judgement (scope items, applicability, clause
   coverage, approval staleness, risk expiry) runs only at the **final** submit or approval
   (`evidence/terminal.mjs`), when every earlier approval is immutable.
4. **Some offered routes are dead ends.**
   - `recover --phase <approved phase>` returns nothing (`recovery-plan.mjs:246-249`).
   - The final gate offers `reopen` commands that the CLI refuses on an open Story
     (`gate-recovery.mjs:115-129` against `state.mjs:7796-7798`).
   - About 41% of throw sites have no error code, so remediation falls back to "repair the
     current phase" even when the cause is upstream.
5. **The shipped workflows cannot reach the owner of the defect.** In ten of the seventeen packaged
   work types, the code phase can reject only to itself. In `spec-driven-standard`, no phase after planning
   can return to specification or planning (`templates/workflow.yml`).

Real Stories confirm it. Of 29 blocking episodes found, at least 12 were a later phase blocked by
an earlier phase. Most of those Stories are still stuck or were abandoned (section 3).

Better prompts are necessary but not sufficient. Prompt changes alone can stop agents from
stalling, make them record upstream defects and continue, and make them use the routes that
exist. Making a phase truly unblockable needs four kernel capabilities:
- a return request from an in-progress phase;
- a forward amendment that does not rewind;
- deterministic restore of approved bytes;
- early (entry-time) detection.

Section 5 gives both, ordered so the prompt work ships first.

## 2. What "never blocked" can mean under governance

Human approval and exact evidence are the product's point, so "never blocked" cannot mean "never
waits for a person". It can and should mean:

| Property | Meaning |
|---|---|
| Always an executable next step | Every refusal carries one legal, runnable command or skill for the current status. Never a dead end, never a route the CLI then refuses. |
| Upstream defects do not stop downstream drafting | Phase N records the defect, proceeds on a stated assumption, and the defect is routed to the earlier phase's owner as governed work. |
| The system fixes what it can | Restoring approved bytes, syncing pending publication and re-composing a stale prompt happen without a person, behind plan-hash confirmation. |
| Problems surface at entry | What will refuse at the final gate is visible when each phase starts. |
| A person is asked once, for a real decision | Amend, return, or accept risk, with the exact command and its cost. |

## 3. Evidence from real Stories

The episodes, condensed. Workspaces and Stories are local test projects. Cost is from logs.

| Story | Blocked in | Symptom | Earlier-phase cause | Outcome |
|---|---|---|---|---|
| myc1 c-hex | release (last) | `STORY_COMPLETION_REFUSED`, then `REFUSAL_UNCHANGED` 3 times; `recover` said "Blockers: none" | Unresolved specification scope item; screenshot evidence owned by implementation; undisclosed self-approval in planning | Stuck more than 3 days |
| myc1 g1-hex | entering planning | `PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED` (6 files) | The agent edited source during the specification approval turn | Abandoned |
| myc1 1h-hex | release | Requirements and criteria "partial": tests never ran | Implementation test command exit 127; verification approved anyway | Abandoned (43 user messages) |
| myc1 9-hex | implementation | `TCA_AMENDMENT_UNSUPPORTED`; unplanned `package.json` | Plan omitted a file; test policy fixed at start | Abandoned, 13 files uncommitted |
| cal2 a-hex | implementation | `SPEC_COVERAGE_INCOMPLETE`, evidence correction, appeal option errors | Plan's evidence requirement; "planning is not an allowed rejection target" | Abandoned after 4 hours, 525 tool calls |
| cal2 hex-hex | implementation approve | Reject to planning refused ("Allowed: implementation") | Plan | Stuck |
| cal2 b-hex | release approve | `STORY_COMPLETION_REFUSED` | Specification scope item; missing screenshot | Stuck |
| piassist WRK-BLUE | release final gate | `GOVERNANCE_GATE_FAILED`: criteria had no planned test | Planning | Reopened to implementation (planning not allowed); stuck |
| rule-engine ANU-STORY | conformance final gate | Untagged criterion, changed `workflow.yml`, stale report | Implementation approved without delivery evidence | Stuck about 7 weeks |
| pocalc WRK-1978 | conformance final gate | Criteria had no tagged tests | Implementation | Fixed in conformance; completed |
| lab TOK-1 | last phase | Appeal repair loop for a missing self-approval disclosure | Self-approvals in earlier phases | Fixed; 30% of the run's tokens |

Where blocks originated, across the episodes:
- **About 12 came from an earlier phase.** The final gate is where most of them surfaced.
  Implementation was blocked by what planning decided. Test policy fixed at Story start could not
  be changed later. There was no route back.
- **Current-phase content problems** (table formatting, placeholders, tag placement) usually
  cleared in 2–3 repair attempts within minutes.
- **The rest were tooling defects:**
  - a prompt execution-context bug;
  - a World Model build writing into the source tree;
  - appeal options that did not match;
  - terminal-only actions;
  - `recover` reporting no blockers while approval was refused;
  - sflow's own uncommitted files triggering a worktree review.

Across 17,054 durable command records, 1,616 did not succeed. `phase prepublish` always logs
success, but in the Copilot logs 53 of 110 prepublish results were in fact "correction required":
implementation 19/31, planning 15/32, specification 15/33. Reject/reopen failed 13 of 22 times,
three of them because the target phase was not allowed.

## 4. Root causes

### 4.1 Kernel and workflow

| ID | Cause | Evidence |
|---|---|---|
| K1 | No return from an in-progress phase (except testing repair and convergence rework) | `state.mjs:7031-7035`; `reopenWorkflow` is closed-Stories only, `state.mjs:7796` |
| K2 | `rejectTo` gaps in the packaged workflows | The code phase rejects only to itself in feature, bugfix, chore, figma-mobile, quick-fix, poc-lite, benchmarking-a and -b, reference-driven-build and spec-driven-standard (`workflow.yml:1162`); nothing after planning reaches planning or specification in `spec-driven-standard` |
| K3 | Every upstream change rewinds and resets all later phases. Approval retention (rule E1) almost never applies because dependencies include the producer's generation and approval | `lifecycle-transitions.mjs:113-137`; `phase-upstream.mjs:35-44` |
| K4 | No general forward amendment | Intent amendment amends only the first scope step and still invalidates every later approval (`phase-roles.mjs:95-122`, `state.mjs:7628-7674`). Plan amendment is add-only for paths on existing rows (`plan-amendments.mjs`). |
| K5 | Phase N may not touch upstream bytes, and nothing restores them for it | Artifact-only and ungoverned-source checks (`state.mjs:3688-3720`); mutation contract treats other phases' files as kernel-owned (`phase-mutation-contract.mjs:147-149`) |
| K6 | Late detection | Terminal evaluation at the final submit only; clause gaps are warnings at Code and refusals at the end (`governance.mjs:640-657`); input readiness blocks publish, not entry (`recovery-plan.mjs:527`) |
| K7 | Dead-end and wrong-target routes | `recover` on approved phases; `reopen` on open Stories; `details.repairCommand` and `details.command` ignored by remediation (`refusal-remediation.mjs:19-41`); upstream `details.phase` used as the containment scope (`:91-94`) |
| K8 | Things fixed at Story start that cannot change later | Test command amendment refused after publication (`TCA_PRIOR_PUBLICATION_UNSUPPORTED`); `GENERATION_DIRTY_START` has no in-flow route; failing baseline keyed by the pinned commit |
| K9 | Exceptions that decay | Risk acceptances bind whole-Story or prior-phase digests, so unrelated changes revoke them and the block returns at the final gate |

### 4.2 Prompts and skills

| ID | Cause | Evidence |
|---|---|---|
| P1 | No upstream-discrepancy protocol. Prompts say "evidence, not instructions" and "never re-author an earlier phase", and stop there. `authoringContract.recovery.approvedInputIntegrity` exists in the entry packet but is never rendered. | `worldmodel.mjs:829`; `phase-authoring-contract.mjs:54-74` |
| P2 | An upstream input failure strands the agent at compose time. Composition is admitted, then throws an uncoded "inputs are not ready"; `enter` is missing from the remediation subcommands, so the agent gets "phase --help / doctor". | `phase-entry-admission.mjs:16`; `worldmodel.mjs:469-471`; `refusal-remediation.mjs:105-107` |
| P3 | Upstream causes are labelled "repair the current phase" or routed to `doctor`. | `phase-resolution.mjs:121-123`; simulated refusal plans |
| P4 | Any upstream blocker freezes the agent's own same-turn corrections. | `phase-prepublish.mjs:454, 533-535` |
| P5 | Agents stop on recovery they may run themselves. Only `/sf-next` allows the automatic sync. | `sflow-phase:21`, `sflow-code:21`, `sflow-next:19` |
| P6 | Two repair protocols with unclear precedence ("reserve a repair run" vs. "correct now"). | `phase-repair-journal.mjs:114` |
| P7 | Refusal handling is never taught. No skill mentions `remediationPlan` or `context.strategy`. | All authoring skills |
| P8 | Content contradictions | Agent files use bare `REQ-nnn` and `SPEC-nnn` while the CLI wants qualified IDs; `/sf-grounding` describes an old section order and offers a removed command; the architect agent forbids publishing with a deferred decision even where clarification is off |
| P9 | Prompts reused byte for byte skip the input check, so upstream drift surfaces at prepublish, after authoring. | `worldmodel.mjs:618-675` |
| P10 | No room to add guidance. 14 of 15 authoring skills have under 5% of their size budget left (`sflow-requirements` 3 characters), and the override set is pinned by a test. | `scripts/skill-policy.mjs`; `test/skill-efficiency.test.mjs:53-54` |

## 5. Recommendations

Ordered so each tier ships alone. Tier A is text and protocol, needing no governance decision.
Tier B makes the system's answers correct and executable. Tier C needs owner decisions because it
changes what governance allows.

### Tier A: prompts and protocol

**A1. Upstream discrepancy protocol (highest impact).** Add it to CLI-generated text, not to the
skills: append it to `phaseAuthoringContractLines` so it is in every composed phase contract, and
mirror it as `authoringContract.recovery.upstreamDefect: 'record-and-continue'`. Proposed text:

> Upstream discrepancies: approved earlier-phase artifacts are fixed evidence. If one is wrong,
> incomplete or contradicts another input or the pinned source, do not edit it and do not stop.
> Proceed on the most conservative reading consistent with the pinned source and list each item
> under `## Upstream discrepancies` (producer phase, exact clause or section, problem, assumption
> used, impact, proposed owner action). Stop only for an integrity refusal or when no reading
> satisfies the pinned source.

Supporting changes:
- Add an optional `## Upstream discrepancies` heading ("None" allowed) to the shared templates.
  Draft-check treats it as non-blocking.
- Carry it into the submission review packet and the approval view, so the approver can turn each
  item into a return, an amendment or an accepted risk (Tier C) with one command.
- Make the architect agent's "deferred decision" rule mode-aware. This needs a new digest in
  `packaged-asset-history.mjs`.

**A2. One engine-owned refusal block.** Generated once, like the command-presentation contract
(about 250 characters):

> On a refusal read `remediationPlan`; run its first read-only step once and follow
> `context.strategy`; never retry an unchanged condition; for an upstream-input refusal never edit
> the input: use the returned restore, amend or return route, or record and continue.

**A3. Repair-protocol precedence.** Rewrite `phase-repair-journal.mjs:114`:

> Same-turn findings in your open draft: correct directly and recheck; no reservation needed.
> Reserve a repair run only for automation or when a refusal names it. After exhaustion, keep
> correcting your own draft; a person is needed only for risk, authority or integrity.

**A4. One automatic recovery in authoring skills.** Permit exactly one returned
`automatic: true, confirmation: plan-hash` action (today only `sync`), then re-enter once.

**A5. Fix contradictions.**
- Qualified clause IDs in the agent files; drop `SPEC-nnn`.
- Rewrite `/sf-grounding` to match the real section order (`worldmodel.mjs:845-866`) and remove
  the retired command.
- An assumption clause when clarification is off ("label `Assumption:` with its impact and
  continue").

**A6. Make room for A1–A4.**
- Move the five near-identical prepublish, publish and phase-show lines into one generated block
  in every authoring skill.
- De-duplicate clause text: the capsule and the full upstream input both carry it today.
- Fix the slow-suite regexes left stale by the recent skill compression (for example
  `test/plugin.test.mjs:447`).

**A7. Upstream health at entry.** Add a short `upstream` summary to the entry packet (inside the
first 3,000 characters, where `agentGuide` lives). It lists input statuses, unresolved scope and
applicability items, coverage gaps, and risks near expiry. The agent then knows at entry what
would refuse at the end.

### Tier B: correct, executable answers

**B1. Code and admit input readiness at entry.**
- Throw `PHASE_INPUTS_NOT_READY` (with `details.upstreamPhase` and per-input findings) at prepare,
  compose and `inputs --dry-run`.
- Add a `PHASE_CONTEXT_INPUTS_NOT_READY` admission blocker, so composition is refused with a plan
  instead of an uncoded throw.
- Add `enter` to the remediation subcommands, and never use an upstream producer as the
  containment scope.
- Add remediation entries for `PHASE_INPUTS_NOT_READY`, `SPECIFICATION_INDEX_UNTRUSTED` and
  `CONVERGENCE_UPSTREAM_ARTIFACT_STALE`, and a resolution choice that stops falling through to
  `doctor`.

**B2. Deterministic restore.** `inputs restore <phase> --confirm <plan>` checkpoints the edited
copy (reusing the appeal checkpoint) and restores the exact approved blob, whose digest is already
recorded. The most common `hash_mismatch` then becomes a self-repair.

**B3. Fix dead-end routes.**
- `recover --phase <approved>` explains that approved phases change only by amendment or return,
  and offers those.
- The final gate on an open Story offers legal commands (a return request, B/C), not `reopen`.
- Remediation reads `details.repairCommand` and `details.command`.
- Check `reopenCompleted` before suggesting `--gate-recovery`.
- `REPAIR_BUDGET_EXHAUSTED` names a reachable reset.

**B4. Recompose stale prompts.** Re-check input digests on the prompt-reuse path, as is already
done for supporting documents.

**B5. Final-gate preview at every entry.** Run terminal readiness as a non-blocking preview at
each phase's entry and at each submit, and route each finding to the phase that owns it while that
phase is still open. Approval of N-1 already checks the next code phase's planned claims
(`state.mjs:6202-6205`); generalise that forward check.

**B6. Codes for uncoded mid-phase throws.** Start with the 150 uncoded throw sites on phase
command paths and the thirteen that state their fix only in prose.

**B7. Fix the defects found while reading** (each is small):
- `reject --member` is checked against the source phase's artifact set but applied to the target
  (`state.mjs:7067-7080` against `7182-7189`).
- `/sf-decide` can be blocked by its own Copilot guard (`decide` falls to read mode).
- `story adjudicate` has no approval-group check.
- `story test-policy repair` says a person must confirm but checks only a digest.
- The vocabulary catalogue still describes test-command amendment as before-first-publication
  only.
- A corrupt repair journal routes to `doctor`, which does not handle it.

### Tier C: governance changes (owner decisions)

**C1. Return request from an in-progress phase.** Phase N files a governed *upstream issue* while
in progress, keeping its draft and continuing under A1's assumption. The earlier phase's
approvers decide among:
- amend (C2);
- plan correction (C3);
- accept as risk (C6);
- return (today's `reject --to`, now reachable from N).

One verb, for example `upstream-issue raise|decide`, replaces today's scattered routes for this
case.

**C2. Forward amendment without rewinding.** Generalise intent amendment to any approved phase:
- It creates a successor generation of that phase without re-running it.
- It keeps downstream approvals whose cited clauses and inputs are unaffected. The kernel already
  does selective preservation for skill-version adoption (`lifecycle-transitions.mjs:18-31`).
- It re-pins the unaffected phases' input bindings to the new generation.
- Phase N stays where it is.
- The earlier phase's approvers decide; acknowledgement needs authority; more than one proposal
  may be pending.

**C3. Plan corrections.** Allow governed addition of plan rows and tests and removal of wrong
paths, not only added paths on existing rows. This is the single most common planning-caused
block in the evidence.

**C4. `rejectTo` defaults.** Let implementation return to its planning and specification owners,
and verification, convergence and release return to planning and specification, bounded by repair
budgets. Alternatively derive `rejectTo` as "any earlier phase" by default.

**C5. Review-phase source boundaries.** Use the existing review repair boundary in the shipped
templates, so a verification phase can fix a code defect with its own tests instead of hitting
`PRIOR_CODE_TEST_EVIDENCE_STALE` on any edit.

**C6. One risk and exception record, used as the upstream-defect register.** It replaces the five
stores with different rules, binds to the specific obligation rather than whole-Story digests, and
is visible at every entry (A7).

**C7. Things fixed at start.**
- Allow test-command amendment after publication, through the owning phase's authority.
- A human-confirmed adoption path for `GENERATION_DIRTY_START`.
- Re-probe a failing baseline at a repaired commit.

**C8. Conformance with honest partial verdicts.** Let conformance submit with blocking verdicts
recorded as upstream issues (C1), instead of being unable to publish and therefore unable to
return work.

## 6. Delivery plan

| Milestone | Content | Depends on |
|---|---|---|
| M1 | A1, A2, A3, A5, A6 (prompt text, generated blocks, contradictions, stale tests) | Nothing |
| M2 | B1, B3, B4, B6, B7 (coded refusals, legal routes, prompt recompose, small defects) | Nothing |
| M3 | B2, A4, A7, B5 (restore, one automatic recovery, entry health, final-gate preview) | M1, M2 |
| M4 | C4, C5, C7 (template and policy changes) | Owner decision |
| M5 | C1, C3, C6 (upstream issue, plan corrections, unified risk record) | Owner decision; spec |
| M6 | C2 (forward amendment with selective preservation) | M5; spec |

Each milestone is tested against replays of the real episodes in section 3, made into fixtures:
- c-hex and b-hex: an unresolved scope item reaching the final gate;
- g1-hex: an approval-turn source edit;
- 9-hex and a-hex: an implementation blocked by the plan;
- WRK-BLUE: planning defects found at release;
- 1h-hex: a test command fixed at start.

## 7. How to measure it

- Refusals with no executable route, or with a route the CLI refuses: target zero.
- Upstream issues first detected at the final gate rather than at phase entry: should fall towards
  zero.
- Rewinds per completed Story, and phases re-approved per rewind.
- Agent turns and tokens per phase, and turns spent in repair loops (today up to 30% of a run).
- Stories completed versus stuck or abandoned, on the replay fixtures and on real use.

## 8. Decisions for the owner

1. Adopt the A1 record-and-continue protocol, with the `## Upstream discrepancies` section shown
   to approvers.
2. Allow a return request from an in-progress phase (C1).
3. Allow forward amendment of any approved phase with selective preservation of downstream
   approvals (C2), instead of rewinding.
4. Broaden the shipped `rejectTo` defaults (C4) and plan corrections (C3).
5. Consolidate risk and exception records into one upstream-defect register (C6).

## 9. Implementation status (2026-10-12)

The owner chose Tiers A and B and C1–C4. All of them are on main. The specification for C1–C3 is
[UIF-v1](SPEC-UIF-UPSTREAM-ISSUES-AND-FORWARD-AMENDMENT-v1.md).

| Item | Status |
|---|---|
| A1–A6 | Done. Authoring contract v7 records upstream discrepancies and files them with `upstream-issue raise --from-artifact`. Skills carry the refusal contract with one automatic recovery. |
| A7 | Done. Every phase entry packet carries an `upstream` summary: input statuses, open upstream issues, pending amendments and revalidations. |
| B1–B4, B6 | Done. Coded input readiness, `inputs restore`, legal routes only, recomposed stale prompts, new error codes. |
| B5 | Done for the step that ends the Story: its entry previews the final evaluation (advisory). Middle steps get the A7 summary instead, because a full preview there mostly lists obligations of later steps that have not run. |
| B7 | Done. Seven defects, each with a regression test. |
| C1 | Done. `upstream-issue raise|list|decide`; return from an in-progress step; completion waits for every decision. |
| C2 | Done for document steps. `propose-amendment`, `decide-amendment` and `revalidate`; later steps keep their approval once revalidated. Clause steps use intent amendment, plan owners use plan corrections. |
| C3 | Done. `decision plan` row corrections after live terminal review. |
| C4 | Done. Every code step may return to any earlier step. |
| C6 | Not started; it was not part of the owner's selection. |
