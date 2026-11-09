# GDP companion authority review — a stopped command's process group — 2026-11-09

Review boundary: `d7c61de356c4597872430e980b23ebc61c3b37e4` (`scs-next`, at the start of this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-09-REVALIDATION-NAME.md`.

Two GDP-locked companions differ from their accepted bytes: `sgos-execution-unit-v1` and `candidate-custody`. `60b90a16c` and `5f00dbbda` changed them without a review. Those commits' touched tests did not include `test/gdp-contract-freeze.test.mjs`; a later touched run found the drift. This review records what changed, read from the code. Neither file changes here. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

Both changes are the same fix: how a stopped command is ended, and when it is reported. What a command may run, who may start it, what it is given and what its result says are unchanged.

## Reviewed in `src/sgos/execution-units.mjs` (`sgos-execution-unit-v1`)

`createGenericProcessExecutionUnit`'s process path.

- **One `send(force)`** for SIGTERM and the later SIGKILL. Before, the two were written out twice. Windows still uses `taskkill` (forced on the second send) and falls back to `child.kill`. POSIX still signals the process group and falls back to the child.
- **A stop reaches an exited leader's group on POSIX.** Before, `terminate` returned once the leader had an exit code. A descendant could still hold the pipes open, so the unit waited out its deadline. Windows still returns once the leader exited, because an exited ID may name another process `[TCE:REQ-034]`.
- **A stopped unit is reported once nothing of its group is left.** When the unit was stopped (deadline or abort), `close` waits for `endStoppedProcessGroup(child)` before it resolves. That function sends SIGKILL to the group every 10 ms until it is gone, for at most 2 s, and never throws. On Windows, and for test doubles, it returns at once. A unit that was not stopped resolves on `close` as before.
- **What this does not change:** the manifest, the admission checks, the budgets (`activeMinutes`, output limits), the environment given to the child, and the resolved fields (`status`, `signal`, `overflow`, `timedOut` and the output). A stop still reports `timedOut` or the abort as before.
- **Checked by:** `test/sgos-execution-units.test.mjs` and `test/exited-leader-stop.test.mjs`.

## Reviewed in `src/auto/auto-candidate.mjs` (`candidate-custody`)

`runVerificationCommand`, which runs a Candidate's verification commands.

- **A stop reaches an exited leader's group on POSIX.** The group always gets SIGKILL, as before. Before, nothing was sent once the leader had exited. Windows is unchanged: forced `taskkill` only while the leader has not exited, then `child.kill`.
- **The group is swept until it is gone** before the result is built, when the command was stopped. This is the same `endStoppedProcessGroup` as above.
- **What this does not change:** which commands run (the allowlist and the gate kernel from `COMPANION-LOCK-REVIEW-2026-11-06-AUTO-GATE-RUN.md`), the command boundary proof, the result path's containment, the receipt fields and their fail-closed status, and the tree comparison after the run. A stopped command still records its timeout or signal, as before.
- **Checked by:** `test/auto-candidate.test.mjs`, `test/auto-mode.test.mjs` and `test/exited-leader-stop.test.mjs`.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `sgos-execution-unit-v1` | A stop reaches an exited leader's group on POSIX; a stopped unit is reported once its group is gone; the two signals share one sender | `sha256:a6f3db4ed2278c183d7d50fd792036234bd1032e83f62fc0a2fdc4b5fc38d12f` | `sha256:9d054bfc43a3cb556a4adc1adeea7bc3cd4f0783c5f7ba3bb3b52917d2e328c0` |
| `candidate-custody` | A stopped verification command's group gets SIGKILL even after its leader exited (POSIX), and is swept until gone before the result | `sha256:206b5cf73df93351a844d9d7c1c461ad928755092a1480cffd8a04ff28e47a51` | `sha256:df22395c4509c76d75b63e480f0fcf3c5955e9b2aa59323208aac663901769c4` |
