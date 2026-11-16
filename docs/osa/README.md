# SPEC-OSA v1.1 — Stage 0 records

These are the Stage 0 implementation records for [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md) (section 13, Stage 0; plan section 2), on branch `osa-s0`, from `d7a976821`.

They record the baseline. No Stage 1 work is claimed.

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
| OSA-INC-3 | Corrections were sent to `/sf-recover` | `review-corrections`: the person's consent for version 2 | B | passing; the receipt is Stage 2 |
| OSA-INC-4 | Version 2 was held as "review record unpublished" | `writing` version 2 | B | passing; promotion of the local opening is Stage 2 |
| OSA-INC-5 | Held again, and `/sf-session` offered version 1's review | `writing` version 2, the same on every surface | B, plus `review-every-step-cli` | in part: `session open` is not among the journey's views (Stage 3) |
| OSA-INC-6 | The entry said author while the permission said recover, and it looped | `writing` version 2; entry, permission and guard agree | B (and F, G through the guard) | passing; the guard's `next` lacks the handoff |
| OSA-INC-7 | A kernel-built step was sent to a skill that would not build it | `kernel-build`: the deterministic build | B (Verify), A | in part: `osa-stage-3-c9` `/sf-publish`, session resume |
| OSA-INC-8 | A reviewer's reply dropped its next step | `review-corrections`; the reply carries the next action | B | passing; reviewer independence is Stage 4 |

| Journey | Covers | Stage |
|---|---|---|
| H | A shared opening becomes visible after another checkout refreshes | 2 |
| I | The same consent rule for document corrections | 2 |
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
