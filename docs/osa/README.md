# SPEC-OSA v1.1 — implementation records

These are the implementation records for [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md):
- **Stage 0** (section 13; plan section 2), on branch `osa-s0`, from `d7a976821`. It records the baseline.
- **Stage 1** (plan section 3), on branch `osa-v11-s1`, from `293a2e9a8`: [stage1.md](stage1.md) and [stage1-perf.md](stage1-perf.md). See "Stage 1" at the end.
- **Stage 2** (plan section 4), on branch `osa-v11-s2`, from `90e7095cc`: [stage2.md](stage2.md). See "Stage 2" at the end.
- **Stage 3** (plan section 5), on branch `osa-v11-s3`, from `91dac87bb`, completed on `osa-v11-s3b`: [stage3.md](stage3.md). See "Stage 3" at the end.
- **Stage 4** (plan section 6), on branch `osa-v11-s4`, from `osa-v11-s3` at `dac523e22`: [stage4.md](stage4.md). See "Stage 4" at the end.
- **Stage 5** (plan section 7), on branch `osa-v11-s5`, from the 11-17 landing at `d5522e815`, beside `osa-v11-s5b`: [stage5.md](stage5.md), [coverage-matrix.md](coverage-matrix.md), [stage5-perf.md](stage5-perf.md) and [activation.md](activation.md). See "Stage 5" at the end.

## The records

| # | Deliverable | Where |
|---|---|---|
| 1 | Baseline manifest: starting commit, prerequisites, runtimes, ceilings | [baseline.md](baseline.md) |
| 2 | Call-site and owner matrix (decision inventory) | [decision-inventory.md](decision-inventory.md) |
| 3 | Incident fixtures (8) and journeys H–J as fixtures | `test/fixtures/osa/incidents.json`, `test/fixtures/osa/journeys-h-j.json`; checked by `test/osa-stage0.test.mjs` |
| 4 | Alias compatibility matrix | [alias-matrix.md](alias-matrix.md) |
| 5 | Capability matrix | [capability-matrix.md](capability-matrix.md) |
| 6 | Performance baseline and its script | [perf-baseline.md](perf-baseline.md), `benchmarks/osa/perf-baseline.json`, `scripts/osa-perf-baseline.mjs` |
| 7 | Where the decision owner lives | [kernel-location.md](kernel-location.md) |
| 8 | First AC-020 inventory | `benchmarks/osa/inventory.json` from `scripts/osa-inventory.mjs`; summary in [decision-inventory.md](decision-inventory.md) §7 |

## Incidents and their journeys

The fixture ids follow SPEC-OSA v1 §1. Each expected action is written by hand from v1.1, independently of the code.

| Fixture | Incident | Expected (v1.1) | Journey | Status on this branch |
|---|---|---|---|---|
| OSA-INC-1 | A review asked for before writing went to help | `not-started`: open version 1, agent, no consent | C | passing |
| OSA-INC-2 | The card's wait ended the 30-minute window | `writing`: the turn goes on after the answer | E (D for the card) | passing; long runs are Stage 3 |
| OSA-INC-3 | Corrections were sent to `/sf-recover` | `review-corrections`: the person's consent for version 2 | B | passing; Stage 2 records the person's consent receipt |
| OSA-INC-4 | Version 2 was held as "review record unpublished" | `writing` version 2 | B | passing; Stage 2 promotes a legacy local opening on the person's yes |
| OSA-INC-5 | Held again, and `/sf-session` offered version 1's review | `writing` version 2, the same on every surface | B, plus `review-every-step-cli` | in part: `session open` is not among the journey's views (Stage 3) |
| OSA-INC-6 | The entry said author while the permission said recover, and it looped | `writing` version 2; entry, permission and guard agree | B (and F, G through the guard) | passing; the guard's `next` lacks the handoff |
| OSA-INC-7 | A kernel-built step was sent to a skill that would not build it | `kernel-build`: the deterministic build | B (Verify), A | in part: `osa-stage-3-c9` `/sf-publish`, session resume |
| OSA-INC-8 | A reviewer's reply dropped its next step | `review-corrections`; the reply carries the next action | B | passing; reviewer independence is Stage 4 |

| Journey | Covers | Stage |
|---|---|---|
| H | A shared opening becomes visible after another checkout refreshes | 2: `test/osa-stage2-journey-h.test.mjs` |
| I | The same consent rule for document corrections | 2, in part: the rule and its operation are tested (journey H opens a document successor; `requested-successor-document-cli`), the review-driven walk is not |
| J | A fresh-chat `/sf-next` does the step's work without a relay | 4 |

## Exit gate

| Gate item | Result |
|---|---|
| Every incident has a named owner and a reproducer, or an explicit unresolved dependency | **Met.** Every incident has a journey A–E and an expected action. OSA-INC-5 and OSA-INC-7 carry explicit unresolved items. |
| Every competing decision has an owner and a reproducer, or an explicit unresolved dependency | **Met with named gaps.** All 70 deciders, 11 predicates and 9 version groups have an owner after OSA and a stage. The rows with no pinning test are listed below. |
| Supported runtimes and the existing test, size and deadline ceilings are recorded | **Met** ([baseline.md](baseline.md) §3–4) |
| Named prerequisites and original behaviour are recorded; no branch is assumed landed | **Met.** All 51 commits were checked as ancestors. Their suites were not re-run in full (owner's rule: heavy runs at the end); the targeted files are listed below. |

**Rows with no pinning test.** Stage 1 adds a test before it moves each of these:

| Row | Why it is listed |
|---|---|
| b20 `convergenceTransitionRoute` | No test names it |
| Pub-3 | Its inline record check has no direct test |
| c8 `successorSkillForPhase` | Covered only indirectly |
| `verification/witness-records.mjs:188` | Treats an open version 2 as published |
| §4 state table, S14 and S15 | Cells not traced |

**Unresolved dependencies at Stage 0:**

1. **The local opening.** An opening on this branch is local to its checkout. Stage 2 decides how a legacy local opening is normalized and promoted (spec §14). The accidental-sharing case in [capability-matrix.md](capability-matrix.md) (an open intent without its receipt) is not yet reproduced.
2. **No writer fence.** Nothing in `src/` gives a writer an epoch or fence token, so journey H's takeover needs a new mechanism (capability 5d).
3. **No proof of reviewer independence.** A fresh reviewer context cannot be shown, and nothing detects whether the host can delegate (capability 7a, 7d). Stage 4 needs a qualified delegation adapter, and a live host run to qualify it.
4. **The session ceiling.** At `d7a976821` the session-current closure is over its byte ceiling; main `ea398577f` fixes the ceiling and is not merged here. A refusal test also fails at this base (fixed on main by `9ce7b5742`). Session current has 0 files of slack, so the kernel must move code into that closure, not add to it ([kernel-location.md](kernel-location.md)).
5. **Two computed-path imports escape the bundle.** They load 74 and 148 source modules into bundled requests ([perf-baseline.md](perf-baseline.md)). They are not OSA's to fix, but Stage 1's comparisons must keep them in view.

## Targeted runs at Stage 0

Node 22.14.0, through the isolated runner at concurrency 2:
- `test/osa-stage0.test.mjs`
- `test/git-bypass-audit.test.mjs`
- `test/documentation-privacy.test.mjs`
- `test/step-being-written.test.mjs`
- `test/step-routes-stage1.test.mjs`
- `test/kernel-step-routes.test.mjs` (its slow-lane test skipped)
- `test/refusal-story-next.test.mjs`
- `test/copilot-turn-renewal.test.mjs`
- `test/review-next-step.test.mjs`
- `test/journey-routes.test.mjs`
- `test/lazy-command-handlers.test.mjs`

**Result:** 89 tests, 85 passed, 2 skipped (slow lane), 2 failed. Both failures belong to the base, and main fixes both:
- `test/lazy-command-handlers.test.mjs`: session current loads 4,273,495 bytes against 4,273,400. main `ea398577f` raises the ceiling to 4,273,500.
- `test/refusal-story-next.test.mjs`: "the decision list for a step the Story lacks" expects `prepare`, but the merged code routes a misspelt step to the same decision list for the current step. main `9ce7b5742` makes the test assert that.

`scripts/check.mjs` passed through the isolated check (3,763 checks).

## Re-estimate after Stage 0

These are planning estimates for one engineer. They exclude waiting for host qualification.

| Stage | Plan | Now | Why |
|---|---|---|---|
| 1 | 4–6 days | **5–7** | 70 deciders, not 46. The kernel must fit closures with 0–3 files of slack by moving code (file-neutral). Golden fixtures for S14 and S15 must be traced first. v1 stage 1 already did the being-written plumbing. |
| 2 | 4–6 days | **6–8** | Reusable: the conditional write, the journal and pending reconciliation. Missing: the stable operation ID, the consent receipt, the opening event type, high-watermark ownership, legacy normalization, and the writer fence, which is a full gap. |
| 3 | 4–6 days | **6–8** | 41 route deciders, including three VS Code renderers that drop review routes, about 30 refusal codes in remediation, and the recovery planner. Execution liveness for long runs is a gap. |
| 4 | 4–6 days | **5–7** | 15 alias contradictions, `/sf-next`'s authoring turn, one session-opening path, and a reviewer delegation adapter with capability detection. |
| 5 | 3–5 days | **3–5** | About 75 direct and 11 aliased intent reads and 44 version-arithmetic sites to remove behind the ratchet, plus the final performance and Node 26 qualification. |
| **Total** | 20–31 days | **25–35 engineer-days** | |

## Stage 1

| # | Deliverable | Where |
|---|---|---|
| 1 | Contracts, the reducer, the predicates, the adapter and the migrated cohort | [stage1.md](stage1.md) §1–§5 |
| 2 | Shadow comparison and its resolved differences | [stage1.md](stage1.md) §6; `scripts/osa-shadow.mjs` |
| 3 | Stage 0 findings in the cohort, and those recorded for Stages 2 and 3 | [stage1.md](stage1.md) §7 |
| 4 | The AC-020 ratchet, its counts and its named exceptions | [stage1.md](stage1.md) §8; `benchmarks/osa/ratchet.json` |
| 5 | The first comparative hot-path measurements | [stage1-perf.md](stage1-perf.md); `benchmarks/osa/perf-stage1.json` |
| 6 | Budgets and acceptance rows | [stage1.md](stage1.md) §10–§11 |

**Exit gate (plan section 3).**

| Gate item | Result |
|---|---|
| AC-001–AC-009 and AC-020 pass for the migrated cohort | **Met** for the cohort ([stage1.md](stage1.md) §11). AC-008 carries one declared restatement owned by Stage 4. |
| No contradictory entry and permission | **Met.** One decision and one basis; the shadow comparison finds no cohort difference on 672 records. |
| No new competing policy owner | **Met.** The ratchet's rises are eight named exceptions: one normalizer and seven renderers of the kernel's decision, each with a deletion target. |
| Broader surface coverage stays explicitly pending | **Yes:** Stage 3's surfaces and their five declared shadow classes ([stage1.md](stage1.md) §6, §12) |
| A real authoring route reaches completion through the guard, with independent expected results | Journeys F and G and the incident journeys: see "Targeted runs at Stage 1" |


## Targeted runs at Stage 1

Node 22.14.0, through the isolated runner at concurrency 2. No touched set and no full run: the heavy run comes at the end, by the owner's rule.

| Run | Files | Result |
|---|---|---|
| Stage 1 qualification | `osa-stage1-kernel`, `osa-stage1-guard`, `osa-stage1-shadow`, `osa-stage1-skills`, `osa-ratchet`, `osa-stage0` | pass |
| The cohort and its neighbours | `step-routes-stage1`, `step-being-written`, `phase-mutation-contract`, `phase-entry`, `kernel-step-routes`, `review-next-step`, `phase-authoring-continuation`, `phase-authoring-progress`, `dead-end-routes`, `rework-lifecycle`, `phase-appeals`, `phase-prepublish`, `phase-governance-routing`, `iac-chat`, `document-step-routes`, `code-documentation-advisory`, `workflow-task-completion`, `workflow-task-resume`, `refusal-story-next`, `unknown-step-refusals`, `refusal-remediation` | pass (517 tests in the final rerun, 14 slow-lane skips) |
| Must stay green | `source-inspection`, `git-bypass-audit`, `sda-inventory`, `lazy-command-handlers`, `exit-ratchet`, `plain-language`, `skill-efficiency`, `skills-html`, `journey-routes` (fast tier), `documentation-privacy`, `documentation-consolidation`, `docs-layer` | pass |
| Wider neighbours | 28 more files reading the changed helpers (`agent-output*`, `documents`, `lifecycle-transitions`, `skp-amendment-*`, `spk-gate`, `test-plan`, `workflow`, `vscode-phase-prepublish`, …), `cli-bundle`, `publication-preflight`, `review-visual-evidence`, `post-code-handoff`, `copilot-turn-renewal`, `agent-hooks`, `phase-generation`, `grounding-paths`, `mig-lint` | pass (413 tests), except one red that is also red at `293a2e9a8` (below) |
| Slow lane (`SINGULARITY_FLOW_TEST_SLOW=1`) | `journey-stories`: journeys B, E, F and G, through the real guard | **pass**, 22 checks and the same 4 KNOWN_BAD todos as Stage 0: `osa-stage-2` twice in F, `osa-stage-3` in G, `osa-stage-3-c9` in B. Stage 1 fixes none of them and adds none. Run at `ac6fba431`. |
| Slow lane | `kernel-step-routes`, `review-every-step-cli`, `journey-routes`, `vscode-bundle-budget` | pass, except `vscode-bundle-budget`'s two build checks (below) |
| Repository check | `node check-iso.mjs <worktree>` (`scripts/check.mjs`) | pass: 3,770 checks |

**Reds that are not Stage 1's.** Each was also run on `293a2e9a8` in a detached worktree:
- `phase-publication-readiness`, "missing MCP evidence and a missing required host are actionable without starting any server": red at the base too.
- `vscode-bundle-budget`, "the built VS Code CommonJS closure remains inside the reviewed budget" and "concurrent bundle-budget builds use isolated output directories": `runtime-prewarm.cjs` measures 114,827 bytes against 114,803 at the base and on this branch alike. The kernel does not enter that bundle. `gateway-runtime.cjs` stays within its ceiling: 879 modules of 882, 7,156,555 bytes.

**A red the stage fixed:** `publication-preflight`, "prepare refuses a consumed code generation", red at `293a2e9a8` ([stage1.md](stage1.md) §7).

**Not run:** the full suite and the weekly Node 26 run, which are the owner's heavy run at the end.

## Stage 2

| # | Deliverable | Where |
|---|---|---|
| 1 | The proposal, the consent receipt and the guard's grant | [stage2.md](stage2.md) §2 |
| 2 | The one opening operation and its checkpoints | [stage2.md](stage2.md) §3 |
| 3 | The writer fence and the verified takeover | [stage2.md](stage2.md) §4 |
| 4 | Legacy local openings | [stage2.md](stage2.md) §5 |
| 5 | Findings and the decisions taken | [stage2.md](stage2.md) §6 |
| 6 | Ratchet, budgets, compatibility and acceptance rows | [stage2.md](stage2.md) §7–§9 |

**Exit gate (plan section 4).**

| Gate item | Result |
|---|---|
| REQ-030–REQ-034 and AC-015–AC-017 pass | **Met** ([stage2.md](stage2.md) §9), with one owner question: the own correction opens settled, without a yes (§6 item 1) |
| No opening or consent manufactured from local JSON | **Met:** receipts, grants and checkpoints are sealed per clone; a hand-written pointer grants nothing |
| Journey F's `osa-stage-2` KNOWN_BAD removed | **Met:** journey F passes all four checks, journey G passes |

The targeted runs are listed in [stage2.md](stage2.md) §10. **Not run:** the full suite and the weekly Node 26 run, which are the owner's heavy run at the end.

## Stage 3

| # | Deliverable | Where |
|---|---|---|
| 1 | One decision for every surface, and the common-basis comparison | [stage3.md](stage3.md) §2 |
| 2 | Durable task outcomes and no-progress detection | [stage3.md](stage3.md) §3 |
| 3 | Refusals, recovery and handoffs | [stage3.md](stage3.md) §4 |
| 4 | The owner's decision of 2026-11-17: the own correction asks the person | [stage3.md](stage3.md) §5 |
| 5 | Findings and decisions for the owner | [stage3.md](stage3.md) §6 |
| 6 | Ratchet, budgets, performance and acceptance rows | [stage3.md](stage3.md) §7–§9 |
| 7 | Stage 3 completion: refusals and the recovery planner, sessions, the `publication-pending` stage, the qualification journeys | [stage3.md](stage3.md) §12 |

**Exit gate (plan section 5).**

| Gate item | Result |
|---|---|
| All listed surfaces agree at the same basis | **Met** for sequence guidance, the guide and next steps, the review continuation, readiness, phase show, the session's task resume and the VS Code views (0 differences in 7,400 readings; every journey's views agree). Session listing and selection **met** in the completion: one session-opening read for `/sf-session` and `/sf-resume` ([stage3.md](stage3.md) §12) |
| The original incidents have named, passing journeys | **Met:** journeys A–G and I pass in the slow lane with KNOWN_BAD empty ([stage3.md](stage3.md) §10) |
| Human boundaries and damaged operations keep their own routes | **Met:** damage leads before holds; a waiting task names the person's decision; an uncertain opening keeps its reconciliation; a pending publication names its sync; a healthy refusal or finding no longer detours through recovery ([stage3.md](stage3.md) §12) |
| No generic work command broadens a source, review or approval permission | **Met:** the guard's grants are unchanged (`osa-stage1-guard`); a view is `turnMode: view` and grants nothing |

The targeted runs are listed in [stage3.md](stage3.md) §10. **Not run:** the full suite and the weekly Node 26 run, which are the owner's heavy run at the end.

## Stage 4

| # | Deliverable | Where |
|---|---|---|
| 1 | One work command for `/sf-code` and `/sf-phase`, and the central action-to-command map | [stage4.md](stage4.md) §1–§2 |
| 2 | `/sf-next` does the step's own work in its turn | [stage4.md](stage4.md) §3 |
| 3 | Writing aliases as compatibility adapters | [stage4.md](stage4.md) §4 |
| 4 | Independent review through a qualified delegation | [stage4.md](stage4.md) §5 |
| 5 | The decisions card as a consent surface; document version 1 behind the owner's switch | [stage4.md](stage4.md) §6–§7 |
| 6 | Ratchet, budgets, decisions for the owner and acceptance rows | [stage4.md](stage4.md) §8–§10b |

**Exit gate (plan section 6).**

| Gate item | Result |
|---|---|
| D1, D2 and D5 qualified for each declared host mode | **Met** for the guard, the CLI and the skill texts; live Copilot is the owner's daily paid run ([stage4.md](stage4.md) §10) |
| Aliases keep their compatibility contract | **Partly:** the cases pinned at Stage 4; the rest are AC-019's, on `osa-v11-s5b` |
| Review claims match retained reports | **Met** (`osa-stage4-review-delegation`) |

## Stage 5

| # | Deliverable | Where |
|---|---|---|
| 1 | The duplicates removed, the map as the one renderer, the refusals that named recovery for healthy work | [stage5.md](stage5.md) §1–§4 |
| 2 | The guard reads the task stage; a running execution after publication | [stage5.md](stage5.md) §5 |
| 3 | The reducer behind the planners' rare paths, with the measured budgets | [stage5.md](stage5.md) §6 |
| 4 | The final owner set and the tightened ratchet | [stage5.md](stage5.md) §7–§8 |
| 5 | Requirement and acceptance coverage | [coverage-matrix.md](coverage-matrix.md) |
| 6 | Comparative hot-path measurements | [stage5-perf.md](stage5-perf.md) |
| 7 | Staged activation and reversal | [activation.md](activation.md) |

**Exit gate (plan section 7).**

| Gate item | Result |
|---|---|
| Every applicable requirement and acceptance row is qualified, with explicit limitations | **Met with named limitations** ([coverage-matrix.md](coverage-matrix.md) section 3); the rows owned by `osa-v11-s5b` are marked there |
| No supported surface keeps an independent authoring-state decision | **Partly.** Every surface takes the step's state and primary action from the kernel, and only the final owner set runs the reducer; some planners still build a route in place, held by the ratchet so they cannot grow ([stage5.md](stage5.md) §8, §11) |
| Ratchets, journeys, compatibility and performance gates pass | See [stage5.md](stage5.md) §10. The heavy Node 22 run and the weekly Node 26 run have not run |
