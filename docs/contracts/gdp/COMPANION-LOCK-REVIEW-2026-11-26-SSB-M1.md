# GDP companion authority review — Story record patterns through the path resolver (SSB M1) — 2026-11-26

Review boundary: `353a292123b56542113fe899f5b7dade9013c23e` (`ssb-m1`, SSB M1 batches B0 to B9). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-25-ASK-SFLOW.md`.

One GDP-locked companion differs from its accepted bytes: `migration-registry` (`src/schema-migrations.mjs`). SSB M1 (docs/SPEC-SSB-STORY-STATE-BRANCH-v1.md, REQ-009; docs/plans/SSB-M1-PLAN.md, batch B10) makes one resolver, `src/story-paths.mjs`, the only place that spells a Story's folder. This review reads the file as B10 leaves it on that boundary. Every other companion still matches its accepted digest.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

- **Each record path pattern that spelled the Stories folder drops it.** The 95 patterns of the form `^singularity/work-items/[^/]+/<rest>$` become `insideStory(/^<rest>$/)`: the pattern is tested on the path inside the Story that the resolver's `storyRecordOf` returns for the default folder. A path matches exactly when it matched before: the folder, a non-empty ID without `/`, then `/` and `<rest>`. `familyForStoredPath` still adds its canonical alias for a configured `workItemRoot`, now named through `storiesRoot()`.
- **What this does not change:** no family, version, migration step, immutability, readable range or migration policy changes; no pattern outside a Story's folder (`$git/…`, `$local/…`, `.sflow/…`, Epic paths) changes; no approval group, member, minimum or rule changes. The registry snapshot (`migrationRegistrySnapshot`) is the same.
- **Checked by:** `test/gdp-contract-freeze.test.mjs`, `test/schema-upgrade-all.test.mjs`, `test/schema-upgrade-cli.test.mjs`, `test/world-model-history-schema-census.test.mjs`, and a comparison of `familyForStoredPath` before and after on paths generated from each old pattern under the default and a configured folder (520 lookups, no difference).

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | Story record patterns tested on the path inside the Story, through the resolver | `sha256:1c707ccb8bfd41611fb27cf883abd51bd8d8c6ba3f2eb830e7eaeb3000d38351` | `sha256:650b37c011a3e2a29ce0c11ef9b52c2a5a69b3574581dba811942c9230c63f1f` |
