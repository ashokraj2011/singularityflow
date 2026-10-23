# GDP companion authority review — Verification steps run the repository's tests — 2026-10-23

Review boundary: `f26e2e384f4bf81e8eeb9a0fd4bbd26c6741227f` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-21-AUTO-RETENTION-DIAGNOSTICS.md`.

One GDP-locked companion changes in this change: `workflow-configuration`. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

## Reviewed in `templates/workflow.yml` (`workflow-configuration`)

- **What changed:** the shared `verification` and `testing` steps gain `repositoryTests: run`, with a comment saying what it does and how to turn it off. Both kept `qualityCommands: []`, so until now neither step ran anything. Their test evidence was only what the author wrote. No other key changes.
- **What the setting does** (`src/verification/repository-tests.mjs`, wired into submission in `src/state.mjs`):
  - When a non-code step with the setting is submitted, it also runs the repository's own test suite. That is the command `inferRepositoryTestCommands` finds from the build files, such as `npm test`, `mvn test` or `go test`.
  - It is the same inference the code steps and `tests run` already use. Nothing new is executed that a code step of the same repository would not run.
  - The commands are argv arrays with `modelPolicy: never`.
- **It cannot hold a Story where no route leads on:**
  - A failing run does not refuse the submission. The step waits for its reviewer, and the reviewer cannot approve it: approval refuses with `PHASE_VALIDATION_FAILED` and the existing "Reject it to an allowed repair phase" route. The template's verification and testing steps both list the code step in `rejectTo`.
  - This is the existing reviewable-failure path that `repairBudget` steps use. It is now also taken when every failed check is one of these runs and the step has an approval.
  - A repository with no test command sflow can find gets an advisory note naming how to add one. So does a run whose launcher is not installed. A note never refuses.
  - Nothing is run when:
    - the Story accepted known test failures (`accept-pre-existing`, or the test recovery pilot);
    - the step's code source did not pass its own tests (an accepted test-run risk).

    A note says why instead. Running them again could not pass, and a rework could not fix it.
  - Nothing is added when the step names its own test command, or when it reviews one code step's committed receipt (`testEvidenceFrom`: the classic-delivery and spec-code-test-loop testing reviews). Those steps behave exactly as before.
- **Only new Stories change.** The engine reads the setting only from a Story's pinned `resolution.phases`, and `resolveWorkType` drops an absent or `off` value. So:
  - every Story started before this change keeps its contract;
  - a workflow that asks for nothing resolves, and hashes, as before.
- **Existing repositories.** A repository's own `singularity/workflow.yml` is never rewritten. It gets the setting only when someone adds it, or when a configuration refresh merges the packaged step into a step the repository has not edited.
- **Validation.** `validateDefinition` and `resolveWorkType` accept only `run` or `off`, and `schemas/workflow-definition.schema.json` describes the key on phases and on `phaseOverrides`.

Who approves anything is unchanged. Approval authorities, minimums, `rejectTo` lists, sequence gates and code-delivery policy are untouched.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `workflow-configuration` | `repositoryTests: run` on the shared `verification` and `testing` steps. | `sha256:5e28785c9d8b2f52712f4fc15c3688ddc210afe4fecd7367e3843dfea4ebfc8d` | `sha256:d4dbe8be1e512262ac89b52e5b3e27b28d8a89401464611e71398c9ff0fec64f` |
