# GDP companion authority review — Auto Candidate tests run as gates, with dependencies — 2026-11-06

Review boundary: `609c449e28c563136b13087ffef0b950adcb2cc3` (`main`, at the start of this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-05-SPEC-STUDIO-RECORDS.md`.

One GDP-locked companion differs from its accepted bytes: `candidate-custody`, changed by `b405d3f14` and `3411487ff`, with no review at the time. The full test suite found it. This records what changed and why, read from the code. The file does not change here.

## Reviewed in `src/auto/auto-candidate.mjs` (`candidate-custody`)

**`b405d3f14`, each test runs as the gate runs it `[TCE:REQ-084]`.** `verifyAutoCandidate` takes an optional `runGateTest`. For a command of kind `test` it runs through the gates' kernel in the Candidate's worktree, and its result fills the same receipt fields.

- **Fails closed:** a run with no exit code records status 1 (`check?.exitCode ?? 1`). A gate that returns nothing falls back to the ordinary verifier, so no command goes unrun.
- **Quality commands** that are not tests still run under the allowlist, as before.
- **The command boundary** is still proved for every command before the first one runs, and the result path's containment is re-proved after each.

**`3411487ff`, the worktree gets the installed dependencies `[TCE:REQ-085]`.** `copyRepositoryDependencies` copies ignored dependency folders into the detached worktree.

- **Source:** `auto-executor.mjs` passes `dependencySource: root`, the checkout that started the flight, and not the Story's worktree, where the model can write.
- **Copy limits:** a folder the checkout does not ignore is refused, because it would be committed. A link leading out of the repository leaves that folder out. A failed verification names what was not copied.
- **Custody holds:** the copy happens after the worktree is proved equal to its retained tree, and the tree is compared again after the commands run (`after.tree === retained.repository.candidateTree`). Copied folders are ignored, so they cannot hide a tracked change, and a command that changes the tree still ends in `AUTO_CANDIDATE_VERIFICATION_MUTATED`.

`MAX_VERIFICATION_COMMANDS` is now exported, and the executor uses it to decide whether the gate's commands fit. Its value is unchanged.

**What this changes in custody:** dependency bytes from outside the Candidate can now take part in its tests. That is deliberate: tests that import an installed package could not pass otherwise, and the model cannot install anything. They come from the starting checkout, and they are not part of the Candidate's tree or digest. A receipt therefore says the tests passed with those dependencies, not that the dependencies are in the Candidate.

- **Checked by:** `test/auto-candidate.test.mjs` (a test run by the gates keeps its receipt shape and a run that cannot stand runs as before; a Candidate that stops ignoring its dependency folder is not called mutated by the copy) and `test/candidate-isolation.test.mjs` (dependencies resolve to Candidate source, and what cannot be shared stays out).

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `candidate-custody` | Test commands run through the gates' kernel; ignored dependency folders copied from the starting checkout; the tree is still compared after the run. | `sha256:262e2465b186372c381224b2f3eb568cefa00968d41a3cccf6fd6a8a1f7d1161` | `sha256:206b5cf73df93351a844d9d7c1c461ad928755092a1480cffd8a04ff28e47a51` |
