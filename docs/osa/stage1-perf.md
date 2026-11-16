# OSA Stage 1 — first comparative hot-path measurements

**Specification:** [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md) AC-022 and REQ-041; plan section 3, "the first comparative hot-path measurements".
**Method:** the Stage 0 method ([perf-baseline.md](perf-baseline.md)), unchanged: `scripts/osa-perf-baseline.mjs` with `--samples=5 --modes=source,bundle`, in an isolated journey fixture, on Node 22.14.0.

**Pairing.** Both engines were measured back to back on the same machine, in the same session:
- the Stage 0 commit `293a2e9a8`, from a detached worktree;
- the Stage 1 candidate `7cb9d7aa4`. Its `source.dirty` flag is true only because documentation files were being edited. The two later Stage 1 commits (`ac6fba431`, `dadf7d1a3`) add no import and no file to any measured path; they change the kernel's handling of a stale opening and the reviewer fallback's reader.

The load average was 7.4–9.9 for both, because other suites were running.

**Data:**
- `benchmarks/osa/perf-stage1.json` (Stage 1);
- `benchmarks/osa/perf-stage1-paired-base.json` (Stage 0, re-measured beside it);
- `benchmarks/osa/perf-baseline.json` (Stage 0's own run).

## Results

Medians of five samples. Counts are from the counted cold run.

| State | Layout | Request | Outcome (Stage 1) | Cold ms base → Stage 1 | Warm ms base → Stage 1 | Modules / Git / reads / dirs / stats, base | Stage 1 |
|---|---|---|---|---|---|---|---|
| document v1 being written | source | guard | allow (no decision) | 249.6 → 136.6 | 137.9 → 97.6 | 83 / 0 / 95 / 0 / 56 | 85 / 0 / 95 / 0 / 56 |
| document v1 being written | source | guard-other-file | deny PHASE_MUTATION_PATH_DENIED | 164.6 → 131.6 | 114.6 → 156.3 | 86 / 0 / 85 / 0 / 37 | 87 / 0 / 85 / 0 / 37 |
| document v1 being written | source | entry | act author (authoring-entry) | 1228.9 → 1100 | 1035.9 → 893.5 | 606 / 26 / 199 / 37 / 3093 | 607 / 26 / 199 / 37 / 3141 |
| document v1 being written | source | next | now prepare intake /sf-phase | 470.5 → 441.1 | 332.7 → 323.7 | 397 / 3 / 110 / 10 / 375 | 398 / 3 / 110 / 10 / 379 |
| document v1 being written | bundle | guard | allow (no decision) | 191 → 92.1 | 109 → 135.1 | 10 / 0 / 25 / 1 / 56 | 10 / 0 / 25 / 1 / 56 |
| document v1 being written | bundle | guard-other-file | deny PHASE_MUTATION_PATH_DENIED | 122.7 → 99 | 74.2 → 65.9 | 9 / 0 / 15 / 1 / 37 | 9 / 0 / 15 / 1 / 37 |
| document v1 being written | bundle | entry | act author (authoring-entry) | 1017.5 → 1066.1 | 892 → 878.2 | 19 / 26 / 145 / 38 / 3198 | 19 / 26 / 145 / 38 / 3246 |
| document v1 being written | bundle | next | now prepare intake /sf-phase | 707.8 → 659.9 | 472 → 401.6 | 244 / 3 / 122 / 11 / 378 | 244 / 3 / 122 / 11 / 382 |
| code v1 open | source | guard | allow (no decision) | 232.5 → 174.4 | 118.5 → 127.4 | 83 / 0 / 95 / 0 / 52 | 85 / 0 / 95 / 0 / 52 |
| code v1 open | source | guard-other-file | deny PHASE_MUTATION_PATH_DENIED | 183.3 → 222.2 | 118.1 → 126.5 | 86 / 0 / 85 / 0 / 41 | 87 / 0 / 85 / 0 / 41 |
| code v1 open | source | entry | act author (authoring-entry) | 1575.1 → 1617.6 | 1576.9 → 1393.3 | 632 / 34 / 276 / 87 / 6449 | 633 / 34 / 276 / 87 / 6521 |
| code v1 open | source | next | now prepare implement /sf-code | 890 → 786.2 | 524.4 → 562.2 | 564 / 3 / 128 / 14 / 427 | 565 / 3 / 128 / 14 / 430 |
| code v1 open | bundle | guard | allow (no decision) | 114.2 → 148 | 69.3 → 108.5 | 10 / 0 / 25 / 1 / 52 | 10 / 0 / 25 / 1 / 52 |
| code v1 open | bundle | guard-other-file | deny PHASE_MUTATION_PATH_DENIED | 116.8 → 130.8 | 69.6 → 101 | 9 / 0 / 15 / 1 / 41 | 9 / 0 / 15 / 1 / 41 |
| code v1 open | bundle | entry | act author (authoring-entry) | 1602.7 → 1660.4 | 1216.6 → 1347.4 | 93 / 37 / 295 / 90 / 6548 | 94 / 37 / 295 / 90 / 6620 |
| code v1 open | bundle | next | now prepare implement /sf-code | 995.7 → 667 | 501.3 → 410.7 | 244 / 3 / 140 / 15 / 430 | 244 / 3 / 140 / 15 / 433 |

## What changed

1. **Git processes are unchanged on every request.** The guard starts none, in either layout and either state, for an allowed edit and for a denied one. That is REQ-041's baseline, kept.

   The reviewer-start fallback no longer loads the Story with Git on the pre-tool path. It now makes one read of the bound `workflow.json` (decision inventory a12). This script does not drive that fallback, so it is not a row here; `test/review-visual-evidence.test.mjs` exercises it.

2. **Bundled guard: no change.** It loads 10 module files for an allowed edit and 9 for a denied one, against the cli-bundle ceiling of 16. Both kernel files are in the `core` chunk the hook bundle already loads.

3. **Source layout: +1 or +2 module files.**

   | Request | Change | Why |
   |---|---|---|
   | guard (allowed) | 83 → 85 | the guard now loads both kernel files |
   | guard-other-file, entry, next | +1 each | `phase-inspection-generation.mjs` was deleted, which offsets one of the two |

   The installed product runs the bundle layout. The source layout is the development one.

4. **Bundled code entry: 93 → 94.** The extra file is a kernel file reached through the computed-path import that already escapes the bundle (`story-lineage.mjs:49`, Stage 0 finding; recorded for Stage 3). It is not a new chunk.

5. **File and directory reads are identical.** Stat calls rise slightly, by about 1–2%: the entry by 48 to 72, next steps by 3 or 4. That is within Stage 0's measured spread of up to 6% for the code entry.

6. **Timings moved both ways under load** (about ±30%), and no row is consistently slower. As in Stage 0, use them only as an order of magnitude.

## Against the AC-022 rules

| Rule | Result |
|---|---|
| No per-tool Git discovery | **Met:** 0 Git processes on every guard row |
| Module and Git counts must not grow (perf-baseline.md) | **Git: met.** **Bundle modules: met** for the guard, the document entry and next steps. **Source modules: +1 to +2**, the kernel's own files. **The bundled code entry: +1**, through the existing computed-path escape. These are reported, not hidden; no ceiling was raised for them. |
| No ceiling raised to pass | **Met** for every bundle, chunk and hook ceiling. The one raise in Stage 1 is the session-current byte budget ([stage1.md](stage1.md) §10), and it is measured, not a performance ceiling. |
