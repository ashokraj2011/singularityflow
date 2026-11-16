# OSA requirement and acceptance coverage matrix

**Specification:** [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md) sections 11 and 12; implementation plan section 7, "Coverage matrix".
**Tree:** `osa-v11-s5`, from the 11-17 landing `d5522e815`. Built beside `osa-v11-s5b`, which owns VS Code's decisions card, the Copilot hook's skill lists, the AC-019 alias cases and the two red files; its rows say "on osa-v11-s5b".

**How to read it.**
- **Qualifier:** the test file and the test that executes the row. A file name without `.test.mjs` is under `test/`.
- **Runtime:** every qualifier here ran on Node 22 (22.14.0), through the isolated runner, at Stage 5 or at the stage named. No row has run on Node 26 yet: the weekly Node 26 run comes after the heavy Node 22 run, which comes after this report.
- **Host mode:**
  - *pure*: the kernel or a renderer called in process;
  - *guard*: the real Copilot pre-tool and post-tool guard (`mutationToolGuard`, `repositoryPostToolGuard`) on a real Git checkout, with a simulated Copilot payload;
  - *CLI*: the real `singularity-flow` CLI in an isolated fixture (own HOME, Git configuration and bare remote);
  - *VS Code model*: the extension's view models, without a VS Code window;
  - *live Copilot*: a real Copilot host. **No row was run on a live host here**; the owner's daily paid Story run (about ten premium requests) is that row (spec section 14).
- **Limitation:** what the qualifier does not show, said plainly. "None known" means none was found, not that none exists.

## 1 Requirements

| Row | Qualifier | Runtime | Host mode | Limitation |
|---|---|---|---|---|
| REQ-001 one decision owner | `osa-stage1-kernel` "Stage 1 golden fixtures …", "the generator: every combination gets an exact decision …"; `osa-ratchet` "only the final owner set imports the reducer …" | Node 22, Stage 5 | pure | Some modules still decide parts of a route on their own (the ratchet's remaining counts, [stage5.md](stage5.md) section 8); they cannot grow |
| REQ-002 three predicates, one arithmetic | `osa-stage1-kernel` "each named publication predicate agrees with its independent definition …" | Node 22, Stage 5 | pure | The P-4 wrapper (`hasPublishedPhaseGeneration`) keeps its record-path meaning and 17 callers; each caller was not reclassified |
| REQ-003 recovery only for damage | `osa-stage3-journeys` "a failed test is repaired within its budget …"; `osa-stage5` "refusals that named recovery for healthy work …"; `refusal-remediation`; `gate-recovery` | Node 22, Stage 5 | pure, guard | Some producers' own details still name `recover` for a configuration or an earlier step's evidence (section 3) |
| REQ-004 source statuses | `osa-stage1-kernel` "unavailable, stale, missing and corrupt sources never become an empty record or a permission" | Node 22, Stage 5 | pure | None known |
| REQ-005 precedence | `osa-stage1-kernel` "overlapping conditions follow section 5 …" | Node 22, Stage 5 | pure | None known |
| REQ-010 one basis for entry, permission, guard and task | `osa-stage1-guard` "for one basis the decision, the entry …"; `osa-stage5` "the edit guard reads the task stage …", "the guard is handed the repair and running stages only …" | Node 22, Stage 5 | guard | The guard is handed the repair and running stages only: a wait for an input, the environment or a person, and a publication left pending, are named by every view but do not stop the guard's writes (owner decision, [stage5.md](stage5.md) section 9) |
| REQ-011 healthy steps get their own action | `osa-stage5` "refusals that named recovery …"; `refusal-remediation`; `step-routes-stage1`; `journey-stories` A, B, D–G, I | Node 22, Stage 5 (journeys: slow lane) | pure, guard, CLI | As REQ-003 |
| REQ-012 durable task | `osa-stage3-continuation` tests 1–4; `osa-stage3-journeys` (heartbeat, attachment, bounded repair, pending publication); `osa-stage5` "the edit guard reads the task stage …" | Node 22, Stage 5 | pure, guard, CLI | A lease held on another machine is not observed as running (spec section 8 needs a cross-machine record) |
| REQ-013 staging and execution capabilities | `osa-stage1-guard` "review staging and execution outputs are their own capabilities …"; `osa-stage3-journeys` "a malformed review citation …" | Node 22, Stage 5 | guard | None known |
| REQ-014 changed published files | `publication-preflight`; `phase-appeals`; `osa-stage3-journeys` "a publication left pending … a published document edited in place …" | Node 22, Stage 5 | CLI | None known |
| REQ-020 surfaces agree | `osa-stage1-shadow` (7,400 readings, 0 differences at Stage 3); `osa-stage3-journeys` "a stale screen …"; `osa-stage5` "a published step whose execution still runs …" | Node 22, Stage 5 | pure, guard | VS Code views: `osa-stage3-vscode` (VS Code model); the card's consent question is on osa-v11-s5b |
| REQ-021 commands in host adapters | `osa-stage4-commands` "the action-to-command map is versioned …"; `osa-stage5` "every route the renderer gives is one of the action-to-command map's named forms …"; `osa-ratchet` Stage 5 families | Node 22, Stage 5 | pure | Planners outside the map still build some routes in place; the ratchet holds them (section 3) |
| REQ-022 refusals keep their code | `refusal-remediation`; `refusal-story-next`; `osa-stage3-journeys` "a missing local attachment …"; `osa-stage5` "refusals that named recovery …" | Node 22, Stage 5 | pure, CLI | `review-source-cli` red rows are on osa-v11-s5b |
| REQ-023 routes the principal can satisfy | `osa-stage1-guard` "the guard, the entry and the authoring task give one next action …"; `no-dead-end`; `dead-end-routes` | Node 22, Stage 5 | pure | Routes are validated against the command registry, not run end to end |
| REQ-024 /sf-code and /sf-phase one coordinator | `osa-stage4-commands` "D1: …" (three tests); `osa-stage4-journeys` "D1: /sf-code on a document step …" | Node 22, Stage 4 and 5 | pure, guard (journeys: slow lane) | live Copilot |
| REQ-025 /sf-next does the step's work | `osa-stage4-commands` "D2: /sf-next is an authoring turn …"; `osa-stage4-journeys` journey J (two tests) | Node 22, Stage 4 and 5 | guard (slow lane) | live Copilot: whether the model follows the skill text in one turn |
| REQ-026 kernel-built steps | `osa-stage4-commands` "D5: every declared deterministic profile …"; `osa-stage4-journeys` "D5: …"; `deterministic-code-step`; `kernel-step-routes` | Node 22, Stage 4 and 5 | pure, CLI | None known |
| REQ-027 aliases keep their meaning | `osa-stage4-commands` "the writing aliases keep their arguments …" | Node 22, Stage 4 | pure | The remaining alias cases are on osa-v11-s5b (AC-019) |
| REQ-030 consent for every successor | `osa-stage2-opening` "a successor opens only on the person's …", "consent that is declined, expired …"; `osa-stage4-consent-card`; `settled-decisions-flow` | Node 22, Stage 2–5 | pure, CLI | VS Code's card as a consent surface is on osa-v11-s5b |
| REQ-031 conditional shared opening | `osa-stage2-opening` "version 1 opens through the one operation …" and tests 5–10 | Node 22, Stage 2 | CLI | Document version 1 stays local by default (owner's switch, off) |
| REQ-032 open successor first | `journey-stories` G; `step-being-written` | Node 22, Stage 5 (slow lane) | guard, CLI | None known |
| REQ-033 replay and reconciliation | `osa-stage2-opening` "an opening whose push is lost …"; `osa-stage2-journey-h` | Node 22, Stage 2 and 5 | CLI | None known |
| REQ-034 writer fence | `osa-stage2-opening` "a second checkout sees the opening …"; `osa-stage3-journeys` "a revoked writer …"; `osa-stage5` "a fenced writer stays out when the machine's turn records are lost …" | Node 22, Stage 5 | guard, CLI | A pre-OSA build does not read the fence ([activation.md](activation.md) section 4) |
| REQ-040 accepted records and observations | `osa-stage1-kernel` (snapshot sources and differences); `osa-stage5` "read-only surfaces leave a Story … unchanged …" | Node 22, Stage 5 | pure | The working record against the accepted one is reported `unknown`, never compared per tool call (by design, REQ-041) |
| REQ-041 no Git per tool call | [stage5-perf.md](stage5-perf.md): 0 Git processes on every guard row | Node 22, Stage 5 | CLI (hook launcher) | Measured on two Story states; the reviewer-start fallback is not a measured row |
| REQ-050 handoff on scope change | `step-routes-stage1`; `osa-stage1-guard` "a moved basis or an expired turn revokes an earlier grant …"; `osa-stage3-vscode` "the prefill only fills the chat input …" | Node 22, Stage 5 | guard, VS Code model | Prefill in a live VS Code window is the paid run's |
| REQ-051 liveness apart from authority | `osa-stage3-continuation` "liveness, authorization and acceptance stay apart …"; `osa-stage3-journeys` heartbeat test; `copilot-turn-renewal` | Node 22, Stage 5 | pure, guard | As REQ-012 |
| REQ-052 reviewer independence | `osa-stage4-review-delegation` (seven tests) | Node 22, Stage 4 | guard | Live dispatch (`task`, `runSubagent`) is the paid run's; VS Code `runSubagent` kept qualified by the owner's decision |
| REQ-060 plain wording | `scripts/plain-language-check.mjs` (0 new); `plain-language` | Node 22, Stage 5 | — | Checks the patterns it knows; it is not a reading by a person |

## 2 Acceptance checks

| Row | Qualifier | Runtime | Host mode | Limitation |
|---|---|---|---|---|
| AC-001 entry, permission and guard agree | `osa-stage1-guard` (four tests); `osa-stage5` "the edit guard reads the task stage …" | Node 22, Stage 5 | guard | None known |
| AC-002 migrated surfaces agree | `osa-stage1-shadow`; `osa-stage3-journeys` | Node 22, Stage 5 | pure, guard | VS Code card: on osa-v11-s5b |
| AC-003 every route mapped | `osa-stage4-commands` "every rendered route carries the map's skill …"; `osa-stage5` "every route the renderer gives is one of the … named forms …" | Node 22, Stage 5 | pure | None known |
| AC-004 six transitions | `osa-stage1-kernel` "the abstract lifecycle reaches an agent milestone …" | Node 22, Stage 5 | pure | Abstract model only, as the row says |
| AC-005 recovery only for damage | `osa-stage1-kernel` golden fixtures; `refusal-remediation`; `osa-stage5` "refusals that named recovery …" | Node 22, Stage 5 | pure | As REQ-003 |
| AC-006 refusals lead with the legal action | `refusal-remediation`; `refusal-story-next`; `osa-stage3-journeys` "a missing local attachment …"; `osa-stage5` "refusals that named recovery …" | Node 22, Stage 5 | pure | As REQ-022 |
| AC-007 predicates | `osa-stage1-kernel` "each named publication predicate …" | Node 22, Stage 5 | pure | As REQ-002 |
| AC-008 skills hold no lifecycle tests | `osa-stage1-skills`; `osa-stage4-commands` "D1: the two names carry one body …"; `exit-ratchet` | Node 22, Stage 4 and 5 | pure | The hook's own skill lists are on osa-v11-s5b |
| AC-009 kernel closure | `osa-stage1-kernel` "the kernel closure has no host I/O …"; `osa-ratchet` "only the final owner set imports the reducer …" | Node 22, Stage 5 | pure | None known |
| AC-010 denied write fails before writing | `osa-stage3-journeys` "a missing local attachment …" (another step's artifact denied before a byte changes); `osa-stage5` "the edit guard reads the task stage …" (the file is unchanged) | Node 22, Stage 5 | guard | None known |
| AC-011 follower against independent expectations | `journey-stories` (route follower `test/helpers/route-follower.mjs`) | Node 22, Stage 5 (slow lane) | guard, CLI | None known |
| AC-012 loops told apart | `osa-stage3-continuation` "no progress is told apart …"; `osa-stage3-journeys` "an idempotent acknowledgement …" | Node 22, Stage 5 | pure | None known |
| AC-013 journeys F–J | `journey-stories` F, G, I; `osa-stage2-journey-h`; `osa-stage4-journeys` J | Node 22, Stage 5 (slow lane) | guard, CLI | J on a live host is the paid run's |
| AC-014 incidents A–E | `osa-stage0` "every incident names its reproducing journey A–E …"; `journey-stories` A, B, D, E; `journey-routes` C | Node 22, Stage 5 | guard, CLI | None known |
| AC-015 one opening wins | `osa-stage2-opening` "two checkouts propose the same successor …" | Node 22, Stage 2 | CLI | Not rerun at Stage 5 (Stage 5 does not touch the opening operation) |
| AC-016 faults | `osa-stage2-opening` "an opening whose push is lost …" and the fault-point tests | Node 22, Stage 2 | CLI | As AC-015 |
| AC-017 second host and fence | `osa-stage2-opening` "a second checkout sees the opening …"; `osa-stage2-journey-h`; `osa-stage5` "a fenced writer stays out …" | Node 22, Stage 5 | guard, CLI | Two machines on one network were not used; two checkouts on one machine stand for them |
| AC-018 review delegation | `osa-stage4-review-delegation` "a retained review answers the delegation only for its exact version …" | Node 22, Stage 4 | guard | Live dispatch: paid run |
| AC-019 command and record compatibility | **on osa-v11-s5b** (the remaining alias cases); `osa-stage4-commands` (the cases pinned at Stage 4); `osa-stage2-compat` (older reader, run at Stage 2 against `90e7095cc`) | Node 22, Stage 2 and 4 | pure, CLI | The pre-OSA reader was not run against an OSA Story ([activation.md](activation.md) section 6) |
| AC-020 ratchet | `osa-ratchet` (seven tests, four of them Stage 5's) | Node 22, Stage 5 | pure | The ratchet counts spellings it knows; a decider written in a spelling it does not know is not counted |
| AC-021 turn renewal revives nothing | `osa-stage3-continuation` "liveness, authorization and acceptance stay apart …"; `osa-stage3-journeys` "a revoked writer and an expired yes …"; `copilot-turn-renewal` | Node 22, Stage 5 | guard | None known |
| AC-022 hot-path measurements | [stage5-perf.md](stage5-perf.md) | Node 22, Stage 5 | CLI (source and bundle layouts) | Timings under load are an order of magnitude only; counts are what the comparison rests on |

## 3 Limitations that cross rows

- **Live Copilot.** No row here ran on a live Copilot host. The owner's daily paid Story run is that row for REQ-024, REQ-025, REQ-050, REQ-052, AC-013 (J) and AC-018.
- **Node 26.** Not run. The stage is complete only after the weekly Node 26 run that follows it passes.
- **The heavy run.** The full suite on Node 22 has not run on this tree; only the targeted files in [stage5.md](stage5.md) section 10.
- **Routes still built in place.** Planners and producers outside the map still build some routes themselves: the counts in the ratchet (lifecycle command literals 299, routes built in place 107, and the Stage 5 families). They cannot grow; they were not all moved.
- **`recover` in producer details.** A clause source owed by an earlier step (`state.mjs`, `phase-prepublish.mjs` `recoveryCommand`), a missing convergence publication record (`phase-transition-routes.mjs`) and the publication-record integrity routes still name recovery. They are not healthy-work routes, but they were not each reclassified.
- **The guard and the waits.** The guard is handed the repair and running stages. A wait for an input, the environment or a person, and a publication left pending, are named by every view but do not stop the guard's file writes; the CLI's publication gate still refuses the next lifecycle mutation until `sync` runs.
- **On osa-v11-s5b:** VS Code's decisions card, the Copilot hook's skill lists from `writingAlias`, the AC-019 alias cases, and the red `review-source-cli` and `person-step-golden` tests.
