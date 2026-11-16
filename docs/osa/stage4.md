# OSA Stage 4 — one work command, the step's work from /sf-next, kernel-built steps and independent review

**Specification:** [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md) sections 2 (D1, D2, D5, D7), 7.1, 9 and 10; REQ-024–027, REQ-050–052, REQ-060; AC-003, AC-018, AC-019, AC-020; implementation plan section 6.
**Branch:** `osa-v11-s4`, from `osa-v11-s3` at `dac523e22`. Plan item 7 (sessions) belongs to the Stage 3b branch (`osa-v11-s3b`), built beside this one.
**Status:** the stage's implementation and its targeted qualification, **with named parts not done** (section 11). The heavy run (full suite on Node 22, then the weekly Node 26 run) has not been made; it comes at the end. Live Copilot host behaviour is the owner's daily paid run, not run here.

## 1 What changed

| # | Item | What | Where |
|---|---|---|---|
| 1 | Work command (D1) | `/sf-code` and `/sf-phase` are one work command with one body. A code step follows its **Code** clauses, a document step its **Document** clauses, both the shared ones. Neither name relays to or refuses the other. A configured author and `/sf-converge` are still relayed; a step named after the command is its target (`phase enter <step>`) | `plugin/skills/sflow-code/SKILL.md`, `sflow-phase/SKILL.md` (identical after the title) |
| 2 | Work command (D1) | Both names are accepted for every one of a step's own commands, with one Shell and one VS Code command; both give the same turn and permission | `src/command-skills.mjs` `WORK_COMMANDS`, `src/safe-command-guidance.mjs` |
| 3 | The central map | One versioned action-to-command map, `sflow-action-command-map/v1`: per kernel operation, its Copilot command (the step's work command, a skill, or the crosswalk's for its Shell command) and its Shell commands; VS Code's model-free command is always read from the exact Shell command. `decisionRoutes` renders through it | `src/step-decision.mjs` `ACTION_COMMANDS`, `actionSkill`, `workCommandOf` |
| 4 | Aliases | The writing aliases as compatibility adapters (`writingAlias`, `workCommandArguments`): their arguments, explicit targets and standalone meanings, and a precise clarification for an ambiguous one. A step typed after the work command is never recorded as what the person asked for (alias-matrix finding 7). `/sf-call` delegates once to the one work command; the route follower enters it as `/sf-code`, not `/sf-start` (finding 4) | `src/writing-aliases.mjs` (lazy), `src/asked-for.mjs`, `plugin/skills/sflow-call/SKILL.md`, `test/helpers/route-follower.mjs` |
| 5 | /sf-next (D2) | `/sf-next` is an authoring turn and does the current step's own work in that turn: it loads the work command once and follows it to its own boundary (its publication and reviewer, or a person's answer). It used to report `Next in Copilot: /sf-code` and stop. Human decisions are still relayed, submission keeps its own gates and ends the turn (D7) | `src/phase-mutation-contract.mjs` `mutationTurnMode`, `plugin/skills/sflow-next/SKILL.md` |
| 6 | Kernel-built steps (D5) | A kernel-built step's successor renders as its preview (`phase rollover <step> --json`), and `prepare` refuses it (`VERSION_CONSENT_REQUIRED`) until the person's yes opens it; its generator used to build it with no yes (Stage 2 finding 5) | `src/step-decision.mjs` (`build-version`), `src/commands/phase-opening.mjs` `openBeforePrepare` |
| 7 | Independent review | The qualified delegation adapter: the dispatch modes (Copilot CLI's `task`, VS Code's `runSubagent`, each with what makes it independent and its evidence), the delegation the publication hands the author (the exact version and packet, a fresh reviewer context, its read-only role and issued staging, the retained report's identity, and nothing gained by the author), the check that a retained report answers it, and the outcome of a failed or cancelled launch | `src/review-subagent.mjs` |
| 8 | Independent review | The guard refuses any other sub-agent tool as a reviewer start (`PHASE_MUTATION_DELEGATION_NOT_QUALIFIED`), with the fresh-conversation route; a failed or cancelled launch adds the fallback to the author's turn | `src/copilot-mutation-guard.mjs`, `src/copilot-repository-boundary.mjs` |
| 9 | Card consent | The decisions card is a consent surface (section 6) | `src/commands/decisions.mjs`, `src/story-version-consent.mjs`, `plugin/extensions/decisions/{card,extension}.mjs`, `src/copilot-mutation-guard.mjs`, `src/commands/phase-opening.mjs` |
| 10 | Document version 1 | Opens through the opening operation behind the owner's switch, measured (section 7) | `src/commands/phase-opening.mjs` |
| 11 | Texts | Help topic (`compact-phase-entry`, version 21), the workflow agent's lines for `/sf-next`, `/sf-phase` and `/sf-code`, the skills HTML, the exit baseline | `docs/topics/`, `plugin/agents/sflow-workflow.agent.md`, `docs/SINGULARITY-FLOW-SKILLS.html`, `test/fixtures/skill-exits.json` |
| 12 | Qualification | `osa-stage4-commands` (12), `osa-stage4-review-delegation` (7), `osa-stage4-consent-card` (3), `osa-stage4-journeys` (5, slow lane); the route follower takes a work route inside `/sf-next`'s turn and the work command's two names as one turn | `test/` |

## 2 One work command (D1, REQ-024)

**One body.** The two skill files differ only in their frontmatter and title. `osa-stage4-commands` checks the bodies are equal byte for byte, and that the follower enters and finishes both the same way.

**No exit was added.** Each kind of step keeps exactly the exits its own skill had:

| | Before | Now |
|---|---|---|
| `/sf-code` on a document step | relayed the entry's routes and stopped | writes it (Document clauses) |
| `/sf-phase` on a code step | relayed `/sf-code` and stopped | writes it (Code clauses) |
| a configured author or `/sf-converge` | each relayed it | both relay it, as `/sf-phase` did |
| a document step's `retained-generation` | its own stop | the shared unchanged-publication stop |

The skill policy (`scripts/skill-policy.mjs`) holds the union of both contracts on both names (`WORK_COMMAND_CONTRACT`), forbids the removed relays (`WORK_COMMAND_FORBIDDEN`), and step 1 of either must say `effectiveAuthoringSkill` is neither `/sf-code` nor `/sf-phase` before it relays. The exit sentences that changed were reviewed and the baseline regenerated (`exit-ratchet`).

**Same behaviour from both commands.** The two names give one turn mode, one mutation contract (the kernel's), one Shell command and one VS Code command for every step command; the slow-lane journey "D1" walks a code step and a document step from each name and compares the commands they run.

## 3 /sf-next does the step's work (D2, REQ-025)

- **The turn.** `mutationTurnMode('next')` is `authoring`. The kernel's decision still grants every write, so a step whose next action is a person's grants `/sf-next` nothing (`osa-stage4-commands`: its contract equals the work command's on a code and a document step; a submitted step gives no writes and names the approval).
- **The skill.** "The current step's own agent work is this turn's: … Load that work command once and do its steps now, from its entry `singularity-flow phase enter --compose --for-agent --json` to its own boundary …; never report it as next." Human decisions are relayed as before; a submission ends the turn (step 7: "Do not automatically submit a generation you just published").
- **Journey J** (`osa-stage4-journeys`): from a fresh chat, `/sf-next` on a quick fix's code step opens version 1, writes the code and tests through the real guard in its own turn, publishes, and starts the reviewer; on a document step it writes and publishes intake. The person types only `/sf-next`.
- **The follower** models it from the skill's text (`worksInTurn`): a work route taken inside the hosting turn, its writes checked in that turn.

## 4 Writing aliases (REQ-027, AC-019)

| Invocation | Adapter result | Kept |
|---|---|---|
| `/sf-code <step> [what to change]`, `/sf-phase <step>` | the work command, target `<step>`, focus the rest | the step is the target (`phase enter <step>`; a step that is not current keeps its refusal and route); never recorded as asked for |
| `/sf-implement [focus]` | the work command, the focus | delegation to the code author |
| `/sf-scenario-repair <defect>` | the work command, the defect as focus; none named: clarification `scenario-defect-required` | retesting stays `/sf-scenario-check`'s |
| `/sf-call <AGENT> [focus]` | the work command when the agent is the Story's; otherwise `agent-mismatch` with its message; none named: `agent-required` | the mismatch message, `/sf-start <WORK-ID> --agent <AGENT>` |
| `/sf-run [focus]` | standalone `guided-run` | its registered contract, no positional task |
| `/sf-converge` | standalone `convergence` | adjudication and its record |
| `/sf-code-docs [focus]` | standalone `doc-comments` | never publishes |
| `/sf-next` | `next`: the current step's work in its turn | sync, chat resets, human decisions relayed |

## 5 Independent review (§9, REQ-052, AC-018)

**Qualified modes** (`REVIEW_DISPATCH_MODES`): `copilot-cli-task` (a sub-agent session of its own; the host names the reviewer on each call and agent-start records its read-only-review turn; Copilot CLI 1.0.109, live probe 2026-11-12) and `vscode-run-subagent` (the review prompt alone, under the author's session; the launch is noted and the review prompt opens the reviewer's own turn; VS Code 1.145, live 2026-11-11, the owner's same-chat review of 2026-11-11). Any other tool (`spawn_agent`, `delegate`, `write_agent`) is refused as a reviewer start.

**The delegation** (`reviewDelegation`, in every publication's `reviewSubagent.delegation`): `sflow-review-delegation/v1`, its digest, and

| Binding | Value |
|---|---|
| version and packet | the published version; `review-source context <step> --for-agent --json`, whose binding the report copies (another version or packet is refused at retention, `SOURCE_REVIEW_BINDING_STALE` or `SOURCE_REVIEW_REPORT_INVALID`) |
| context | fresh: the review prompt alone, never the author's conversation |
| role and staging | `reviewer`; the packet's issued staging path only (the read-only-review turn) |
| report identity | the version, the pinned reviewer (its sha256), retained by `review-source submit <step>` (`delegatedReportProblem` refuses another version, reviewer, or a report not read-only) |
| parent | `{ role: 'author', gains: [] }`: the author never writes, retains or approves the review |
| fallback | `/sf-review-source <step>` in a new chat, prerequisite `independent-context` |
| pending | `review-pending`, capability `independent-review-delegation` |

**Failed or cancelled delegation.** The launcher's after-tool result (`failure`, `rejected`, `cancelled`, …) or the host's tool-failure event adds to the author's turn: "the reviewer of `<step>` did not run (failed|cancelled). Its review stays pending and nothing was reviewed. Never review, stage or retain it yourself. Run this in a new chat: /sf-review-source `<step>`". Every view still names `/sf-review-source`. The kernel never takes a review of another version as this version's (`in-review`, `start-review`).

## 6 The decisions card as a consent surface (Stage 3 leftover)

1. A step's preview (`phase rollover <step> --json`) keeps its sealed proposal on this clone, as before.
2. `decisions <W> --json` carries `versionOpening` (`workId`, `phase`, `version`, `question`, `confirmation`, `digest`) while that proposal is the next number on the Story as it is (the local Story branch head), nothing is open, and no yes is kept yet.
3. The Copilot CLI card asks it first, with the proposal's own question ("Yes, start it" / "Not now").
4. On yes, the card runs `decisions record <W> --version-consent <confirmation> --expect <digest> --json` outside the chat. It verifies the proposal is that exact digest, for the current step, made on the current head (`VERSION_CONSENT_WRONG_TARGET`, `VERSION_OPENING_STALE` otherwise), and keeps the same sealed grant the question tool and `/sf-confirm` keep, with surface `decisions-card`, for 30 minutes.
5. The step's own confirmation turns it into `VersionOpeningConsent/v1` with `response.surface: decisions-card`, `principal.assurance: host-card`, bound to the proposal digest. In the author's Copilot turn the guard accepts the card's grant for that exact proposal: no question is asked again.
6. A chat turn never records it: `decisions record` is the person's own step in every turn.

VS Code's card (`singularityFlow_decide`) does not ask it yet (section 11).

## 7 Version 1 of a document step (Stage 3 leftover): measured, switched off

`openBeforePrepare` opens version 1 of a document step through the opening operation (consent `not-required`, a committed opening record, the Story branch pushed) only with `SINGULARITY_FLOW_DOCUMENT_VERSION_OPENING=shared`. The default, `local`, keeps the verified initial-version path every earlier build used.

Measured on an isolated quick-fix Story with a local bare remote, the first `prepare intake` (`osa-stage4-consent-card`, Node 22):

| Mode | Time | Git processes | Pushes | Remote moved | Opening record |
|---|---|---|---|---|---|
| `local` (default) | 1.0 s | 23 | 0 | no | no |
| `shared` | 2.1 s | 102 | 1 | yes | `context/version-openings/intake-v1.json`, consent `null` |

So it adds a network push and about 79 Git processes to every document step's first `prepare`, on every Story. **Owner decision** (section 9).

## 8 Ratchet and budgets

**AC-020 ratchet:**

| Family | Stage 3 | Stage 4 |
|---|---|---|
| Raw opening reads | 76 | 76 |
| Opening writes | 11 | 11 |
| Lifecycle predicate calls | 214 | 214 |
| Skill and turn chooser calls | 102 | 102 |
| Version arithmetic in place | 38 | 38 |
| Routes built in place | 115 | 115 |
| Lifecycle command literals | 321 | 322 |
| Route skill literals | 112 | 113 |

- **Named exceptions added:** `command-skills.mjs` skill literals 0 → 2 (the work command's two names, the one list the validator and the map read; renderer); `review-subagent.mjs` lifecycle commands 1 → 2 (the delegation's packet and retention commands, one template; renderer).
- **Falls locked in:** `safe-command-guidance.mjs` skill literals 3 → 2 (it reads the list instead of adding `/sf-code` itself).
- The `step-decision.mjs` exceptions now name Stage 5 as their deletion: the map moved beside `decisionRoutes`, its one renderer.

**Budgets:**

| Ceiling | Stage 3 | Stage 4 measured | Change |
|---|---|---|---|
| Lifecycle handlers' bytes | 9,747,600 (`phase-lifecycle` 9,747,581) | 9,753,705 | **raised to 9,753,750** (+6,124), commented in `test/lazy-command-handlers.test.mjs`: the map beside its renderer, the work command's names, the card's narration |
| Lifecycle handlers' files | 473 (`submit` 473) | 473 | none: no new eager file (the alias adapter, the delegation and the card's consent stay lazy) |
| Session current | 4,279,100 (4,279,062), 221 files | 4,280,210, 221 files | **raised to 4,280,250** (+1,148) |
| VS Code bundles | `benchmarks/dx/vscode-bundle-budgets.json` | `lazy-panels-runtime.cjs` 3,556,863, `runtime-prewarm.cjs` 114,914 | **raised as measured** (+715, +111) |
| Skill bodies | `/sf-code` 1,651, `/sf-phase` 1,019 (overrides), `/sf-next` none | 2,127, 2,132, 868 | the union of the two bodies (+476, +1,113) and `/sf-next`'s step 4 (+68), each with its reason in `registry.yml` |

## 9 Decisions for the owner

| # | Decision | What was done; recommendation |
|---|---|---|
| 1 | Version 1 of a document step through the opening operation | Built behind `SINGULARITY_FLOW_DOCUMENT_VERSION_OPENING=shared`, **off by default** (the conservative behaviour). On, it adds one push and about 79 Git processes (about 1 s) to every document step's first `prepare`. **Recommendation:** keep it off. The kernel already treats a verified initial version as legitimate (§4.3), and nothing else can open version 1 of a step concurrently in a way a second checkout would miss: its publication is shared anyway. Turn it on only if version 1's opening must be visible to another checkout before anything is published, and then as a pinned workflow policy rather than an environment switch. |
| 2 | Is VS Code's `runSubagent` a qualified independent reviewer? | **Kept qualified**, as the owner's same-chat review of 2026-11-11 decided: the sub-agent gets only the review prompt, but runs under the author's session, and the guard tells its calls apart by the launch frame. The conservative alternative is the fresh-conversation route only. **Recommendation:** keep it, and have the daily paid run confirm the reviewer's calls are checked as the reviewer's (the 2026-11-11 probe did). |
| 3 | `/sf-next` takes task completion | Not added: `/sf-next` does not ask the stop hook to continue an unfinished authoring task (its text already says to honour `taskCompletion`). **Recommendation:** add it once the daily run shows `/sf-next` doing the work; it is one line in `copilot-repository-boundary.mjs`. |
| 4 | Outcome review after a code publication | Unchanged, as Stage 3 left it, waiting on the owner's confirmation. |

## 10 Acceptance rows

| Row | Result | Evidence |
|---|---|---|
| REQ-024 | **Pass** | `osa-stage4-commands` (one body, one turn and permission, both names for every step command); journey "D1" |
| REQ-025 | **Pass** at the guard, the CLI and the skill text; live host behaviour is the owner's paid run | `osa-stage4-commands` (turn and permission), journey J (code and document steps, through the guard, one typed command) |
| REQ-026 | **Pass** | `osa-stage4-commands` (every declared deterministic profile, convergence included, is `build-version` by its generator; a kernel-built successor renders as its preview); journeys "D5" (built the same from `/sf-code`, `/sf-phase` and `/sf-next`; a returned kernel-built step opens on the person's yes, then is built; refusing AI and harness ports) |
| REQ-027 | **Pass** | `osa-stage4-commands` (the adapter's cases, the target never recorded, the follower's alias entries), `requested-successor-document-cli` (the step word left out of what was asked) |
| REQ-050 | **Pass** (kept) | Stage 3's evidence; D2 keeps D7: a submission ends `/sf-next`'s turn |
| REQ-051 | **Pass** (kept) | Stage 3's evidence; the card's yes holds 30 minutes, never renewed by a turn |
| REQ-052 | **Pass** for the delegation, its refusals and its fallback; live dispatch is the owner's paid run | `osa-stage4-review-delegation` (7) |
| REQ-030 | **Pass**, the card added | `osa-stage4-consent-card` (the card's receipt, wrong target, stale, a chat turn cannot record it) |
| REQ-060 | **Pass** | `plain-language-check`: 0 new |
| AC-003 | **Pass** | `osa-stage4-commands` (every rendered route carries the map's skill and its three surfaces; VS Code's said truthfully) |
| AC-018 | **Pass** | `osa-stage4-review-delegation` |
| AC-019 | **Partial.** Pinned now: `/sf-code <step>` and `/sf-phase <step>` (target, nothing recorded), `/sf-phase` on a code step and `/sf-code` on a document step end to end, `/sf-call` with no name and with another agent, the follower's `/sf-call` entry. Not pinned: `/sf-verify` on a step that is not a verification step, `/sf-run` at the authoring boundary, fast-path verbs in work types without a fast path; a bare `/sf-resume` and `/sf-session --refresh` with selectors are Stage 3b's | `osa-stage4-commands`, journey "D1" |
| AC-020 | **Pass** | `osa-ratchet` |

## 10a Targeted runs at Stage 4

Node 22, through the isolated runner at concurrency 2, targeted files only. No touched set and no full run: the heavy run comes at the end, by the owner's rule.

| Run | Files | Result |
|---|---|---|
| Stage 4 qualification | `osa-stage4-commands` (12), `osa-stage4-review-delegation` (7), `osa-stage4-consent-card` (3) | pass |
| Slow lane (`SINGULARITY_FLOW_TEST_SLOW=1`), Stage 4 journeys | `osa-stage4-journeys`: J on a code step and a document step, D1 (both names on a code and a document step), D5 (a kernel-built step from all three commands; a returned one opening on the person's yes) | **pass, 5 of 5** after `4fd0ab746` (run twice). The first run, at `e8aa7471e`, found the work command's other name handed on as a new command (section 2); fixed and run again |
| Slow lane, existing journeys | `journey-stories` (A, B, D, E, F, G, I), `kernel-step-routes` (POC Lite from `/sf-next`, start to end), `osa-stage2-journey-h`, `deterministic-code-step`, `settled-decisions-flow`, with the follower's Stage 4 changes (B and the POC Lite walks start from `/sf-next`, so the step's work now runs inside its turn) | **pass: 47 checks, 0 failed, 0 todo** |
| Neighbours (71 files in all, with the rows above) | `plugin`, `exit-ratchet`, `phase-mutation-contract`, `phase-authoring-skills`, `authoring-skills`, `osa-stage1-skills`, `skills-html`, `skill-efficiency`, `command-skills`, `copilot-guidance`, `vscode-user-agent-folder`, `cic-chat-entry`, `iac-chat`, `direct-skills`, `narration-contract`, `copilot-cli-decide-card`, `decision-card-plain-words`, `review-subagent-cli`, `osa-stage2-opening`, `requested-successor-document-cli`, `osa-stage1-guard`, `osa-stage1-kernel`, `osa-stage3-continuation`, `step-routes-stage1`, `kernel-step-routes` (fast tier), `confirmation-routes`, `review-next-step`, `osa-stage1-shadow`, `copilot-turn-renewal`, `still-holds-in-chat`, `agent-hooks`, `review-every-step-cli`, `workflow-task-completion`, `workflow-task-resume`, `nextsteps`, `sequence`, `guide`, `settled-decisions`, `agent-output`, `post-code-handoff`, `dead-end-routes`, `journey-routes` (fast tier), `phase-entry`, `step-being-written`, `submission-readiness`, `copilot-answer-binding`, `confirm-code`, `copilot-repository-boundary`, `source-reviewer-tools`, `copilot-hook-runtime`, `copilot-hook-launcher`, `review-source-cli` | pass after the changes below, but `review-source-cli` (section 10b). The first passes found tests that pinned what Stage 4 changes: `/sf-next` as a kernel-only turn that may not edit, start the reviewer or run local checks; the relays between `/sf-code` and `/sf-phase` and `/sf-next`'s "Next in Copilot: /sf-code"; `/sf-call`'s two delegations; the step word recorded as what the person asked for. Each was changed to the new behaviour with its reason; none was weakened. A kernel skill (`/sf-submit`) now carries the kernel-only checks `/sf-next` used to |
| Must stay green | `source-inspection`, `osa-ratchet`, `exit-ratchet`, `skills-html`, `lazy-command-handlers`, `docs-layer`, `documentation-privacy`, `docs-packaging`, `documentation-consolidation`, `git-bypass-audit`, `plain-language`, `cli-bundle`, `vscode-bundle-budget` (slow lane: its built closure, after the raise) | pass |
| Scripts | `scripts/plain-language-check.mjs` (0 new, 0 fixed), `scripts/git-bypass-audit.mjs` (2,013 sites, no new one), `scripts/build-docs-manifest.mjs` (93 topics), `scripts/generate-skills-html.mjs --write` (193 skills), `scripts/osa-inventory.mjs --ratchet` | pass |
| Repository check | `node check-iso.mjs <worktree>` (`scripts/check.mjs`) | pass: 3,789 checks. It first flagged two vendor names in the new tests, removed |

## 10b Reds

- **`review-source-cli`: 3 tests (7 with subtests) fail, and fail the same at `dac523e22`** (run there, unchanged). They pin a document successor prepared with no question (`successor-preparation-required`, where Stage 2's D3 asks the person: `successor-confirmation-required`) and a reviewer's `prepare` refused for its role before the consent check (`VERSION_CONSENT_REQUIRED` now comes first; both refuse before any Git change). Not changed here: they are Stage 2's and Stage 3's behaviour, and the file is next to Stage 3b's refusal work. **Stage 5** (or Stage 3b).

## 11 What is left for Stage 5

- **VS Code's decisions card** does not ask a waiting next version yet; the Copilot CLI card does. Its view (`apps/vscode/src/views/`) reads `versionOpening` the same way.
- **The alias adapter is a contract, not yet every reader's.** `writingAlias` is what the tests and the typed-words record read; the guard's task-completion and asked-for skill sets still list their names by hand (`copilot-repository-boundary.mjs`).
- **`commands/shared/prepared-phase-next-actions.mjs`** still builds its post-preparation route in place (its exception names the map).
- **The map's remaining hand-built routes:** `decisionRoutes` reads the map's skills; its Shell commands are still built in its cases.
- **`/sf-verify`** relays a step whose author is not `/sf-phase`; under D1 it could accept `/sf-code` too.
- **AC-019's remaining invocations:** `/sf-verify` off a verification step, `/sf-run` at the authoring boundary, fast-path verbs where a work type has none.
- **`/sf-next` and task completion:** the stop hook does not continue an unfinished task in a `/sf-next` turn (section 9, item 3).
- **Session listing and selection, refusal presentation, recovery planner:** Stage 3b.
- The heavy run (full suite, Node 22) and the weekly Node 26 run.
