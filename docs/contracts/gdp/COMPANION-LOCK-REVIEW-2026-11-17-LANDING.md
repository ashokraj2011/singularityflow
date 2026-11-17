# GDP companion authority review — the 11-17 landing — 2026-11-17

Review boundary: `d89eedd0dbd56423a356ff49200a564ae597743e` (`land-1117`, the 11-17 landing, at the start of this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-14-AGENTS-HOME.md`.

Two GDP-locked companions differ from their accepted bytes: `publication-unit-of-work` (`src/publication-unit-of-work.mjs`) and `migration-registry` (`src/schema-migrations.mjs`). OSA Stage 3 (`57724229f`) and SPEC-SCF stage 4 (`60f0231d1`) changed them without a review; the landing's full run found the drift. This review records what changed, read from the files. Neither file changes here. It is not a bulk hash refresh, and it adds no approval or publication authority. Every other companion still matches its accepted digest.

## Reviewed in `src/publication-unit-of-work.mjs` (`publication-unit-of-work`)

- **A plain refusal when there is no remote at all** (docs/osa/stage3.md item 10, from Stage 2 finding 13). When a Story's publication is on and neither the remote's configured push authority nor a supplied one has a URL, the unit of work refuses with `PUBLICATION_REMOTE_AUTHORITY_MISSING`: "This checkout has no remote named 'origin' to publish to. Nothing was changed." Its details name the remote, the person as owner, and their own step (`git remote add <remote> <url>`, then the same command again).
- **It was refused before too.** The same case used to end in `PUBLICATION_REMOTE_AUTHORITY_CHANGED` ("changed after its exact push authority was observed") when an authority without a URL was supplied, or in the later `PUBLICATION_REMOTE_AUTHORITY_MISSING` check when none was. Only the words and the route change. The check runs before the subject lock, the commit and the push, as before.
- **What this does not change:** an observed URL that no longer matches still refuses as `PUBLICATION_REMOTE_AUTHORITY_CHANGED`; publication `off` still reads no remote; nothing new is committed, pushed, accepted or approved; no expected-revision, lease or retained-publication rule changes.
- **Checked by:** `test/osa-stage3-continuation.test.mjs`, `test/path-grounding.test.mjs` and `test/gdp-contract-freeze.test.mjs`.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

- **One family's current version moves from 1 to 2:** `skill-configuration-ancestry`, the proof that today's `sflow/config` descends from the commit a Story started from [SCF:REQ-020]. Version 2 holds a chain longer than 128 commits (bounded by size instead) or an approver's adoption without ancestry (D9).
- **The step from 1 to 2 is the identity step** (`identity(2)`, as for other immutable families): a stored version 1 proof reads with its bytes and identity unchanged. The family stays immutable. Version 2 is written only where the repository's minimum build reads it; every build reads version 1.
- **What this does not change:** no other family, path, current version or migration step; no record is rewritten on read; who may record an adoption without ancestry is decided where the proof is written (only an approver refresh), not in the registry.
- **Checked by:** `test/mig-golden.test.mjs` (`test/fixtures/schema-migrations/goldens.json` lists versions 1 and 2), `test/scf-unbounded-ancestry.test.mjs`, `test/skp-amendment-audit.test.mjs` and `test/gdp-contract-freeze.test.mjs`.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | `skill-configuration-ancestry` is version 2, reached from version 1 by the identity step; version 1 proofs read unchanged | `sha256:ae0ec74f0c97e0fc450ddf0be5699f946af25c57458a89eba731d92fed8ce33f` | `sha256:935c0c360faa4e7d208639c35fff3e15a61da77a71aff1f4efd2a0c33b647f25` |
| `publication-unit-of-work` | A publication with no remote to publish to is refused in plain words with the person's `git remote add` step; it was refused before, with the wrong words | `sha256:ef278fb532ff04e216d4d2cac62ebf2199d0ce1b285cb12c3184419048aeb4e8` | `sha256:0445a89dbe58833ffc327624e9a0c77e921dae908ad8051fe2638931f3a8c4c5` |
