# GDP companion authority review — workflow builds — 2026-10-17

Review boundary: `21842018cd8ba2de507ce2d9719aad4d0f1f6b14` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-14-TEAM-IMPORT-SESSIONS.md`.

Four GDP-locked companions differ from their accepted digests at this boundary. One changes in this change (`migration-registry`, a new record family). The other three, and an earlier change to the same registry, came from commits merged after the preceding review without a review of their own; this review covers that drift after the fact. It is not a bulk hash refresh, and it adds no approval authority.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

- New in this change: the `workflow-build` family, version 1 with no migrations, at `$local/workflow-builds/wb_<16 hex>/build.json` (`src/workflow-build/store.mjs`). It is the machine-local record of one progressive workflow build: what it started from, the screened capture manifest, and the items found in it. Writers stamp `currentSchemaVersion`; `readWorkflowBuild` checks an integrity digest and refuses a record changed outside Singularity Flow; the golden fixture carries one v1 record. It never enters a repository, a Story snapshot or a bundle, and it reads as `model: never`.
- Drift from `94b6278d` (CLI vocabulary sweep): the refusal for a record below the readable range says "a republication with recorded lineage" instead of "a governed republication …". Message prose only; the condition, code and readable range are unchanged.

## Reviewed drift in the other companions

| Companion | Commits | What changed | Effect |
| --- | --- | --- | --- |
| `sgos-record-contracts` (`src/sgos/contracts.mjs`) | `94b6278d` | "A governed record must be a plain object." became "A record must be a plain object." | Message prose only. |
| `candidate-custody` (`src/auto/auto-candidate.mjs`) | `94b6278d` | Eleven refusal messages drop the word "governed" (for example "does not reproduce its tree"). | Message prose only; every condition and code is unchanged. |
| `publication-unit-of-work` (`src/publication-unit-of-work.mjs`) | `5be0d63e`, `8b0115e2`, `f6f8eb18`, `94b6278d` | State write, admission, candidate freeze, commit and push are wrapped in `measureCommandSpan`, which reports progress and returns the wrapped call's result unchanged. `branch(root)` and `head(root)` became one `headAndBranch(root)` read (`git rev-parse HEAD --symbolic-full-name HEAD`), which refuses a detached HEAD as before. Two messages drop "governed". | Same order of steps and the same refusals; one Git read instead of two. |

Who approves anything is unchanged. Finishing a build goes through Workflow Studio's reviewed proposal; nothing here activates configuration.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `candidate-custody` | Refusal prose without "governed". | `sha256:3fd036ef47c490f1842eee10ea527b15e30ea839b40aa1d2bef894448b49e8e2` | `sha256:8dca4ae7661c33ea4d4ba4baaa9488243f7457341d5a8e037a9c3ddd3a303443` |
| `migration-registry` | `workflow-build` v1 family; refusal prose without "governed". | `sha256:00321fc2cd686da3e36dc7b2fb4902dda6d64e10929aa2245e116d7a950b0dfc` | `sha256:2ed65ecee765ba3fcec3c7f259f970f51992dd376776b00a94ed8ffc3aa70a1d` |
| `publication-unit-of-work` | Timing spans, one combined HEAD and branch read, refusal prose. | `sha256:91ce95ee66f799798de11264c023a39e05f7c05927bf55b8efa1d235e0c748b4` | `sha256:40c741224e7cc4d89a1b4171b692527bbc1cb89aff8e89ec8a15d875c8d42af0` |
| `sgos-record-contracts` | Refusal prose without "governed". | `sha256:416ffdd49e64d036d01f165d6e495961fff0dff64c3c980ca735e1653a38b081` | `sha256:52fc02fc568712cb87eba5246656535ad255b4b2449a0c68933e513211c407cd` |
