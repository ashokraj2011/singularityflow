# SPEC-OSA v1 — One step author

**Product:** Singularity Flow
**Date:** 16 November 2026
**Status:** Approved by the owner on 16 November 2026 ("approve"). The eight decisions in section 3 were approved the same day ("ok"). Nothing in this spec is built yet; Stage 1 starts next.
**Namespace:** OSA. No other document uses it.
**Source baseline:** main 56dfa031e. File references are to that commit unless a branch is named.
**Input:** the authoring-model review of 16 November 2026 (46 deciding places, 23 contradictions). Appendix A lists the contradictions and the requirement that closes each.
**Companions:**
- [SPEC-PHR](SPEC-PHR-PHASE-RESPONSIBILITY-v1.md): every issue is repaired in its own step.
- [SPEC-PSS](SPEC-PSS-v1-PRESENCE-SIGNED-STEPS.md): person-only steps.
- [SPEC-SCF](SPEC-SIMPLE-CONFIGURATION-v1.md): one source of truth.

**Normative language:** MUST, MUST NOT, SHOULD and MAY express requirements.

## 1. Why

On 16 November 2026 one real Story went round eight dead ends and loops while its code step was written, reviewed and rewritten:

1. A review run before the step was written pointed to the help page.
2. The decisions card's wait ended the agent's 30-minute window.
3. A review that asked for corrections sent the person to `/sf-recover`, which cannot open a new version.
4. After a new version was opened, the code step was held as "review record unpublished".
5. After a new version was prepared, the code step was held again, and `/sf-session` offered to review the old version.
6. `/sf-code` was told "write now" by the step entry and "no edits, recover" by the edit permission in the same reply, and went round recover, the documents view, review and `/sf-phase` back to itself.
7. A step SFlow builds itself was sent to a skill that would not build it.
8. A reviewer's reply dropped its next step.

Each was fixed where it showed, and the next appeared somewhere else. The owner: "this is the nth time we are fixing it".

**The cause** is one design fault. Three questions decide what an agent does with a step:
- May it edit now?
- What is the one next thing?
- Which command does it?

About 46 places answer them, each from its own reading of the Story:
- ten decide "may edit";
- twenty-seven decide "what's next";
- seven mechanisms plus about a hundred hard-coded names decide "which command".

There is no single answer to "is this step being written right now?". Six different tests and six meanings of "published" disagree. Every fix so far taught one more place about one more state.

## 2. The model

Five rules.

1. **One answer.** One function reads a step once and answers all three questions. Every message, permission, route and screen takes its answer from it. Nothing else decides.
2. **One command to work on a step.** A person types one command to work on a step, whatever kind it is. It writes, rewrites, builds, publishes and starts the review. Review, decisions and approval stay separate, because they are other people's work.
3. **A new version always needs the person.** Starting version N+1 of a step always asks the person first, with one rule for code, documents and reopened steps.
4. **Recover means damage.** `/sf-recover` is offered only when something is actually broken. It is never the way forward for a healthy step.
5. **One copy decides each question.** "May I edit?" reads the files on disk. "What is published, reviewed or approved?" reads the commit. Opening a version is committed at once, so the two never disagree about whether a version is being written.

## 3. Owner decisions (approved 16 November 2026)

| ID | Decision |
|---|---|
| D1 | **One work command.** `/sf-code` and `/sf-phase` both stay and do the same thing for any step: code, document, kernel-built or convergence. No new name. The other writing skills (`/sf-implement`, `/sf-specify`, `/sf-plan`, `/sf-verify`, `/sf-call`, `/sf-run`, `/sf-converge`, `/sf-code-docs`, `/sf-scenario-repair`) stay as aliases of it. |
| D2 | **`/sf-next` does the step's own work** in the same turn when the next thing is the agent's work on the current step. It stops at a person's step (decide, approve, confirm) and names it. |
| D3 | **The person's yes before every new version:** code and document steps, after a review asks for corrections, after a return for rework, after an amendment, and when an agent wants to correct its own published version. One rule, no exceptions. |
| D4 | **`/sf-recover` only for damage**: published bytes changed afterwards, a publication that failed to send, broken state, an interrupted operation. Removed from every other route. |
| D5 | **Steps SFlow builds itself are built automatically** by the work command in the turn that reaches them, with nothing extra for the person to type. |
| D6 | **Copies.** "May I edit" uses the working copy. "What is published, reviewed or approved" uses the committed copy. **Opening a version is committed at once**, so other chats, checkouts and laptops see it. |
| D7 | **After a submit, the next step waits for a new turn.** The next command is pre-filled in VS Code chat. The turn that submitted does not start the next step. |
| D8 | **Stage 1 starts this week**, after the 16 November fix branches land. |

## 4. One step state

### 4.1 The function

A new small module, `src/step-state.mjs`, loadable by the edit guard on every tool call. It has no heavy imports and starts no Git process; callers pass any committed facts they hold.

```
stepState({ workflow, committed = null, phaseId = workflow.currentPhase, review = null, facts = {} }) → {
  basis:   { copy: 'working' | 'committed', committedDiffers },
  kind:    'code' | 'document' | 'kernel-document' | 'kernel-code' | 'convergence' | 'none',
  state:   one of the names in 4.2,
  version: { published, writing, next },
  edit:    { artifacts, application, why },
  next:    { do, command, skill, ask, who },
  turn:    { skills }
}
```

- `version.published` is the last published version, 0 for none.
- `version.writing` is the version being written now, or null.
- `version.next` is the number the next version gets. It is computed one way only, from the higher of the published version and the high-watermark, plus one.
- `next.do` is one of: author, ask-next-version, build, publish, start-reviewer, review, submit, approve, decide, recover, none.
- `next.ask` is the question for ask-next-version, in plain words.
- `next.who` is agent or person.
- `turn.skills` lists the typed commands whose turn may carry out `next`.

### 4.2 States

| State | Meaning | May edit | Next | Who |
|---|---|---|---|---|
| not-started | The step is not current yet | nothing | the current step's next | — |
| writing | A version is being written, version 1 included | the step's files, and application files for a code step | author (write, check, publish) | agent |
| kernel-build | A step SFlow builds itself, not yet built | nothing by hand | build, then publish | agent |
| published | Published, no review owed | nothing | submit | agent |
| in-review | Published, its review owed or running | nothing | review | reviewer |
| review-ready | Its review found nothing blocking | nothing | submit | agent |
| review-corrections | Its review asked for corrections | nothing | ask-next-version | person, then agent |
| reopened | Returned for rework, or reopened by an amendment | nothing until the person says yes | ask-next-version | person, then agent |
| submitted | Waiting for approval | nothing | approve or reject | person |
| approved | Done | nothing | the next step's next | — |
| paused | An undecided amendment pauses it | reads only | decide | person |
| held | A governance hold (author conflict and the like) | nothing | the hold's own route | as the hold says |
| damaged | Something is broken (D4) | nothing | recover | agent |

- **Being written** has one definition: the step is in progress, and a version is open (committed per D6) or the step has never been published.
- **Published** has one definition: version ≥ 1 is recorded and no version is open.
- Every other module that needs either answer MUST call `stepState` or the two helpers it exports. MUST NOT read `generationIntent.status`, `phaseNeedsGeneration` or a publication record to decide them.

### 4.3 Everything derives from it

| Output today | Becomes |
|---|---|
| Edit permission (mutation contract): editable, allow, next, summary, sourceEditPrerequisite | `edit` and `next`. `recover` only in damaged. |
| Edit guard, generic agent-guard hook, stop hook, task completion | the permission above; the task from `version.writing` |
| Step entry status and its `act` | a fixed map from `next.do`. `author` if and only if `edit` grants something. |
| Next steps, the guide's handoff, `phase show`, `/sf-session`, submission readiness, sequence guidance, the VS Code views | "now" is `next`; their later rows come from a fixed list per state |
| Review continuation | `next` in the review states |
| Recovery plan | only for damaged; otherwise "nothing to recover", plus `next` |
| Refusal routes | lead with `stepState(after the refusal).next`; recover and `phase show` only when damaged |
| Command-to-skill map for step commands (`prepare`, `phase begin`, `phase enter`, `phase rollover`) | `next.skill`: the step's work command, never a name taken from the command text |
| Skill texts | "follow `act`", with no state rules of their own |

## 5. Commands

| Command | Does | Never |
|---|---|---|
| `/sf-code`, `/sf-phase` (and their aliases) | Work on the current step. Write or rewrite it. Ask "Start version N?" and open it on a yes. Build a kernel step. Publish. Start the reviewer as a sub-agent in the same chat. | Answer the person's question; approve; submit |
| `/sf-next` | Says what's next, and does it when it is the agent's work on the current step (D2) | Do a person's step |
| `/sf-review-source` | Reviews a published version independently | Write the step |
| `/sf-decide`, `/sf-approve`, `/sf-submit` | The person's and the lifecycle's own steps | — |
| `/sf-recover` | Repairs real damage only (D4) | Appear as a next step for a healthy step |
| `/sf-session` | Opens a Story and says what's next. `/sf-resume` becomes an alias of it. | — |
| `/sf-phase-documents` | Shows documents | Appear as a next step |

## 6. Requirements

### State
- **OSA:REQ-001** `stepState` MUST be the only place that decides a step's state, what may be edited, the one next action and its command. It MUST be a pure function of the facts it is given.
- **OSA:REQ-002** "Being written", "published" and the next version number MUST each have one definition (4.2). The previous tests (`phaseNeedsGeneration`, `successorGenerationOpen`, `hasPublishedPhaseGeneration`, `requiresProspectivePhaseInspection` and the raw intent reads) MUST be removed or become thin wrappers over it.
- **OSA:REQ-003** `damaged` MUST come only from facts that show damage (D4). No other state's next action is `recover`.

### Permission and entry
- **OSA:REQ-010** The edit permission, the edit guard, the generic agent-guard hook, task completion and the step entry's `act` MUST derive from `stepState`.
  - The entry MUST say `author` if and only if the permission grants an edit and the guard would allow it.
  - The edit guard is the copilot-mutation-guard's pre-tool check.
- **OSA:REQ-011** A step not being written MUST NOT be routed to recover by its edit permission. Its permission's next is `next` (C1).
- **OSA:REQ-012** A version being written MUST have a task that holds the turn until it is published or the person stops (C5).

### Routes and commands
- **OSA:REQ-020** Every surface that shows "now" MUST show `next`, with the same command and the same skill: next steps, session, `phase show`, submission readiness, the VS Code views, the review continuation, the recovery plan and refusal routes (C2, C21).
- **OSA:REQ-021** A route's skill MUST come from `next.skill`. `prepare`, `phase begin`, `phase enter` and `phase rollover` MUST name the step's work command (C4, C11).
- **OSA:REQ-022** A refusal MUST lead with `stepState(after the refusal).next`. Recover and `phase show` MAY be added only when the state is damaged (C3).
- **OSA:REQ-023** No route MAY name a command whose turn cannot carry it out (C10).
- **OSA:REQ-024** `/sf-code` and `/sf-phase` MUST both work on any step kind (D1). Neither MAY refuse or relay to the other.
- **OSA:REQ-025** `/sf-next` MUST carry out the step's own agent work in its turn, and stop at a person's step (D2).
- **OSA:REQ-026** Kernel-built steps MUST be built and published by the work command in the turn that reaches them (D5, C9).

### New versions
- **OSA:REQ-030** Opening version N+1 MUST ask the person "Start version N+1 of <step>? Version N and its tests stay." with the host's question tool, and open it only on the person's yes recorded in that turn.
  - This holds in every case: review corrections, rework, amendment, the agent's own correction, and code and document steps alike (D3, C8, C12).
  - Without a question tool, the route is `/sf-confirm` or the terminal.
- **OSA:REQ-031** Opening a version MUST be committed and pushed with the Story at once (D6, C17). Another chat, checkout or laptop MUST see the open version.
- **OSA:REQ-032** While a version is open:
  - the step MUST NOT be offered for submit or for review of the earlier version;
  - submit MUST refuse with the route to write the open version (C2).

### Copies
- **OSA:REQ-040** "May I edit" MUST read the working copy. "What is published, reviewed or approved" MUST read the committed copy. `basis` MUST say which copy answered, and whether the other differs.

### Turns
- **OSA:REQ-050** After a submit moves the Story on, the turn MUST end. The next command is offered for the next turn and pre-filled in VS Code (D7, C15).
- **OSA:REQ-051** A person's answer renews the 30-minute turn window (built on branch turn-renew). A long build or test run inside one turn SHOULD NOT lose the window. Stage 3 decides how.

### Words
- **OSA:REQ-060** Every person-facing text this spec adds MUST pass the plain-language check. Use "version", never "generation" or "draft" for it, and every next step must be named.

## 7. Tests

### 7.1 The all-states test (property test)
Generate every combination of:
- status;
- versions 0–2;
- version state: none, open, published, superseded;
- why it is reopened: none, rejected, rework, skill amendment, intent amendment, author conflict, open change request;
- review: none, staged, ready, corrections, disposition pending;
- kind;
- pause;
- watermark above the version or not.

For each, compute every output in 4.3 from the real modules and assert:

- **OSA:AC-001 (P1)** The entry says `author` if and only if the permission grants an edit, if and only if the guard allows an edit of the step's file (and of an application file for code), if and only if `next.do` is author.
- **OSA:AC-002 (P2)** Every surface's "now" equals `next`: same command verb, same skill.
- **OSA:AC-003 (P3)** No route names a command whose turn cannot carry it out.
- **OSA:AC-004 (P4)** Following `next` through a small transition model never returns to the same state and command without progress. It reaches a person, a publish, a submit or an approval within six steps.
- **OSA:AC-005 (P5)** `recover` appears only in damaged.
- **OSA:AC-006 (P6)** A refusal's first route equals `stepState(after).next`.
- **OSA:AC-007 (P7)** Every "published" and "being written" answer agrees.
- **OSA:AC-008 (P8)** The skill texts for the work command, `/sf-next`, `/sf-recover` and `/sf-review-source` name no route the all-states test does not produce.

### 7.2 Journey tests through the guard
- **OSA:AC-010** The route follower (test/helpers/route-follower.mjs) MUST write every file through the real edit guard, in the turn of the command the route named, and fail on a deny before writing.
- **OSA:AC-011** At every step it MUST also read next steps, `/sf-session`, `phase show` and submission readiness, and fail if their "now" differs from the agent's route.
- **OSA:AC-012** It MUST fail on a repeated state and command with no progress.
- **OSA:AC-013** New journeys:
  - (F) rework → republish → review asks corrections → "Start version N?" → version N written → review ready;
  - (G) version 2 open on a step with no review: submit refuses with the route to write it;
  - (H) a second checkout sees an opened version;
  - (I) a document step's review asks corrections → the same question;
  - (J) `/sf-next` from a fresh chat writes a step without a second command.
- **OSA:AC-014** The 16 November incidents each stay covered by a journey check (journeys A–E plus F–J).

### 7.3 Ratchet
- **OSA:AC-020** A ratchet test (like the Git-read ratchet SDA-AC-001) records, per module, the reads of `generationIntent.status` and the hard-coded `'/sf-recover'`, `'/sf-code'` and `'/sf-phase'` outside `step-state.mjs` and the command map. Counts may only fall.

## 8. Stages

| Stage | What | Closes | Effort | Risk |
|---|---|---|---|---|
| 0 | Land the 16 November branches: the batch (review-next, kernel-step-route, turn-renew, refusal-next-step with its next-step source fixed, chat prefill, decisions card, plain language, journeys, resets), the upgrade, and the review-visual-evidence fix | incidents 1–8; C9 in part; C16 | in flight | low |
| 1 | **Stop the loops this week.** Introduce `stepBeingWritten()` and use it in authoring progress, the review continuation, submission readiness, sequence guidance and next steps (REQ-012, REQ-032). The entry's `author` follows the permission (REQ-010). No recover fallback (REQ-011). Step commands take the step's work command (REQ-021). No recover or `phase show` added to state refusals (REQ-022). Replace sflow-code's "Consumed intent requires /sf-recover" with "follow act". Journey tests through the guard (AC-010–AC-012) and journeys F and G. | C1–C7, C11, C18, C21 | 2–3 days | low–medium |
| 2 | **`step-state.mjs` and the all-states test** (4.1, 7.1). The permission, entry, guide, continuation and authoring progress read it. Absorb kernel-build and ask-next-version. The rework and amendment ask (REQ-030 for C8). Commit opening a version (REQ-031). | C8, C17, C22, C23 | about 1 week | medium |
| 3 | **Move the remaining surfaces:** submission readiness, `phase show`, session, VS Code, recovery plan (damage only; C12 becomes ask-next-version), refusal routes, governance hold, agent-guard hook. The long-run turn window (REQ-051). Journeys H–J. | C9, C10, C12–C15, C19, C20 | 1–2 weeks | medium |
| 4 | **Commands.** `/sf-code` and `/sf-phase` the same command, with the other writers as aliases (D1). `/sf-next` does the work (D2). `/sf-resume` becomes an alias of `/sf-session`. Help, docs and skill texts follow, guarded by AC-008. | C10 | 3–5 days | medium |
| 5 | **Delete the duplicates** and add the ratchet (AC-020). | — | small | low |

Each stage lands with:
- its own tests;
- the journeys and the all-states test (from Stage 2);
- the whole-source ratchets;
- a Node 22 touched-set run. Node 26 runs weekly.

## 9. Compatibility

- **Stories already running** keep their records. `stepState` reads today's records, and nothing is rewritten. An open version that only exists in the working copy (before REQ-031) is committed the next time the work command enters the step, after the person's yes, if one is owed.
- **Old command names** keep working as aliases. No command is removed.
- **Older builds** reading a Story whose open version was committed by a newer build see the open version as today: as a working-copy intent, which the record already carries.
- **The plain-language and journey checks** from 16 November stay in force.

## 10. Out of scope

- How approval works, approval groups, and presence-signed steps: unchanged.
- Configuration, workspaces, upgrades: SPEC-SCF.
- What the reviewer checks: unchanged. Only how a review result leads to the next step changes.

## Appendix A. Contradictions and the requirement that closes each

| ID | Contradiction | Closed by |
|---|---|---|
| C1 | Every healthy published step is told to "recover" by its edit permission | REQ-011, AC-005 |
| C2 | An open version 2 shows as "review version 1" or "ready to submit" | REQ-020, REQ-032, journey G |
| C3 | Refusals add recover and `phase show`, and skills send agents there | REQ-022 |
| C4 | Step commands get a skill from the command text (`prepare` → `/sf-phase` on a code step) | REQ-021 |
| C5 | An open version has no task, so the turn can end and "complete" is shown | REQ-012 |
| C6 | `/sf-code`'s text sends any published code step to `/sf-recover` | Stage 1 text change, AC-008 |
| C7 | "May write" and "may edit" use different tests | REQ-002, REQ-010, AC-001 |
| C8 | Reopened, republished, then corrections: no "Start version N?" and permission says recover | REQ-030, journey F |
| C9 | A kernel-built step names five different routes | REQ-026 |
| C10 | The typed command, not the step's state, decides what a turn may do | REQ-023–REQ-025 |
| C11 | One refusal code, several skills | REQ-021 |
| C12 | A hand-edited published document gets two opposite options | REQ-030 |
| C13 | A returned code step: entry says "next", two commands named | REQ-010 |
| C14 | Rollover offered while submitted | REQ-020 |
| C15 | The step changes mid-turn and the turn goes read-only | REQ-050 |
| C16 | The 30-minute window | REQ-051 (answers: turn-renew) |
| C17 | Working copy vs committed copy for an open version | REQ-031, REQ-040, journey H |
| C18 | Last step with version 2 open: ending decisions shown first | REQ-020 |
| C19 | The generic agent-guard hook has its own rule | REQ-010 |
| C20 | Author conflict lists a route that refuses | REQ-020 |
| C21 | A refusal's "next" from sequence guidance is wrong while a version is open | REQ-022 (fixed for state refusals in the batch) |
| C22 | Three ways to count the next version | REQ-002 |
| C23 | Six meanings of "published" | REQ-002, AC-007 |
