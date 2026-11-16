# OSA Stage 5 — comparative hot-path measurements (AC-022)

**Specification:** [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md) AC-022 and REQ-041; implementation plan section 7, "Performance": complete the comparative cold and warm guard, entry and next measurements, with the original resource and package deadlines unchanged.
**Method:** the Stage 0 method ([perf-baseline.md](perf-baseline.md)), unchanged, as in [stage1-perf.md](stage1-perf.md) and [stage3.md](stage3.md) section 8: `scripts/osa-perf-baseline.mjs --samples=3 --modes=source,bundle`, in an isolated journey fixture (its own HOME, Git configuration and bare remote), on Node 22.14.0. Three samples, not five, because other agents' suites were loading the machine; the counts are what the comparison rests on.

**Pairing.** The base `d5522e815` (the 11-17 landing, Stages 0–4) and the Stage 5 candidate `b0529142d` were measured back to back on the same machine, each from its own checkout. The candidate's `source.dirty` flag is true only for the two documentation files edited beside it (`docs/osa/README.md`, the specification's status line). Data: `benchmarks/osa/perf-stage5.json` and `benchmarks/osa/perf-stage5-paired-base.json`; the earlier runs are `perf-baseline.json` (Stage 0), `perf-stage1*.json` and `perf-stage3*.json`.

**Load.** The load average was 9.5 rising to 48.6 during the base run and 41.9 falling to 14.4 during the Stage 5 run: other agents' suites were running. The base's code-step bundle rows (entry warm 3,957 ms, next cold 2,873 ms) were taken at that peak. Timings are an order of magnitude only.

## Results

Medians of three samples. Counts are from the counted cold run. Every outcome is the same as the base's, row by row.

| State | Layout | Request | Outcome (Stage 5) | Cold ms base → Stage 5 | Warm ms base → Stage 5 | Modules / Git / reads / dirs / stats, base | Stage 5 |
|---|---|---|---|---|---|---|---|
| document v1 being written | source | guard | allow (no decision) | 160.4 → 141 | 109.1 → 91.6 | 90 / 0 / 91 / 0 / 52 | 90 / 0 / 92 / 0 / 52 |
| document v1 being written | source | guard-other-file | deny | 160.2 → 137.9 | 109.6 → 98.2 | 92 / 0 / 85 / 0 / 37 | 92 / 0 / 87 / 0 / 37 |
| document v1 being written | source | entry | author | 1192 → 889.5 | 746 → 722.5 | 610 / 26 / 199 / 37 / 3101 | 610 / 26 / 200 / 37 / 3105 |
| document v1 being written | source | next | now prepare intake /sf-phase | 409.7 → 412 | 276.4 → 294.2 | 400 / 3 / 110 / 10 / 391 | 400 / 3 / 111 / 10 / 389 |
| document v1 being written | bundle | guard | allow (no decision) | 90.7 → 83.5 | 61.2 → 56.2 | 10 / 0 / 21 / 1 / 52 | 10 / 0 / 22 / 1 / 52 |
| document v1 being written | bundle | guard-other-file | deny | 88.1 → 82.3 | 57.5 → 54 | 9 / 0 / 15 / 1 / 37 | 9 / 0 / 17 / 1 / 37 |
| document v1 being written | bundle | entry | author | 729 → 763.4 | 639.1 → 590.8 | 19 / 26 / 145 / 38 / 3190 | 19 / 26 / 147 / 38 / 3208 |
| document v1 being written | bundle | next | now prepare intake /sf-phase | 517.4 → 529.6 | 311.1 → 304.4 | 244 / 3 / 122 / 11 / 394 | 244 / 3 / 124 / 11 / 392 |
| code v1 open | source | guard | allow (no decision) | 127.8 → 120 | 81 → 80.8 | 90 / 0 / 93 / 0 / 48 | 90 / 0 / 94 / 0 / 48 |
| code v1 open | source | guard-other-file | deny | 137.1 → 126.1 | 85.7 → 80.8 | 92 / 0 / 89 / 0 / 41 | 92 / 0 / 91 / 0 / 41 |
| code v1 open | source | entry | author | 1167.7 → 1196.7 | 960 → 924.9 | 640 / 38 / 300 / 87 / 6736 | 640 / 38 / 301 / 87 / 6716 |
| code v1 open | source | next | now prepare implement /sf-code | 561.4 → 512.4 | 408.8 → 336.8 | 567 / 3 / 134 / 14 / 453 | 566 / 3 / 135 / 14 / 451 |
| code v1 open | bundle | guard | allow (no decision) | 148.8 → 89.8 | 93.3 → 58.1 | 10 / 0 / 23 / 1 / 48 | 10 / 0 / 24 / 1 / 48 |
| code v1 open | bundle | guard-other-file | deny | 130.3 → 92.8 | 68.7 → 57.1 | 9 / 0 / 19 / 1 / 41 | 9 / 0 / 21 / 1 / 41 |
| code v1 open | bundle | entry | author | 1413.4 → 1105.5 | 3957 → 901.1 | 94 / 41 / 324 / 90 / 6832 | 94 / 41 / 326 / 90 / 6826 |
| code v1 open | bundle | next | now prepare implement /sf-code | 2873.5 → 507.8 | 1571.9 → 303.8 | 244 / 3 / 148 / 15 / 456 | 244 / 3 / 150 / 15 / 454 |

## What changed

1. **Git processes: unchanged on every row.** The guard starts none, in either layout and either state, for an allowed edit and for a denied one. REQ-041 holds: the task stage the guard now reads is read when the turn's record is built, from private files, and never per tool call.
2. **Modules: unchanged on every row but one, which fell.** The bundled guard loads 10 module files for an allowed edit and 9 for a denied one, the bundled entry 19 and 94, bundled next steps 244, as at Stages 1–4. In the source layout, the code step's next steps fell from 567 to 566 module files.
3. **File reads: +1 or +2 per row.** The guard reads one more file per call: the task record it stamps (`promises.readFile`, an absent file reads as empty), +2 on the denied edit. The entry and next steps read 1 or 2 more: the entry reads the task record for its permission, and a command that refreshes a live turn checks that turn's new stamp (by reading the code, not traced read by read). Directory reads are identical; stat calls move within ±20 of several thousand.
4. **Time:** no row is consistently slower. Rows where the base ran at the load peak are faster here for that reason, not for anything Stage 5 did.

## Against the AC-022 rules

| Rule | Result |
|---|---|
| No per-tool Git discovery | **Met:** 0 Git processes on every guard row, as at Stages 0–4 |
| Module and Git counts must not grow | **Met** on every row: Git identical, modules identical but one fall (566 from 567) |
| File reads | +1 per guard call (+2 for a denied edit), +1 or +2 for the entry and next steps: the task record the guard now stands on. Reported, not hidden |
| No ceiling raised to pass | **Met.** No bundle, chunk, hook or timing ceiling was raised. The eager-source ceilings fell: lifecycle handlers 9,772,850 → 9,740,950, session current 4,288,950 → 4,288,050 ([stage5.md](stage5.md) section 6). The VS Code bundle budget was over at the base already, with the same five entries; Stage 5 adds 10,785 bytes to `gateway-runtime.cjs`, under its byte ceiling, and no module ([stage5.md](stage5.md) section 10b) |

## Not measured

- The reviewer-start fallback on the pre-tool path, and the guard's turn-record build itself (the prompt hook), which is where the task stage is read: the script times the per-call guard, the entry and next steps, as at Stage 0.
- Five samples: three were taken, as at Stage 3, because of the load.
