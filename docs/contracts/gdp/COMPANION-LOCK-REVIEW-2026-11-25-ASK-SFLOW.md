# GDP companion authority review — Ask SFlow merged with intent to work — 2026-11-25

Review boundary: `839cdbe996a2500ccfcab483e93d376cefd5fe14` (`codex/spec-ask-r1`, Ask SFlow R1–R5), merged onto `itw-final`. The preceding review is `COMPANION-LOCK-REVIEW-2026-11-25-TASK-CHANGES.md`.

One GDP-locked companion differs from its accepted bytes: `migration-registry` (`src/schema-migrations.mjs`). Ask SFlow keeps saved conversations and hands a task to intent to work; the branch registered the four records that leaves but did not review the lock. This review reads the file as the merge leaves it: the two task-change families of the preceding review plus these four. Every other companion still matches its accepted digest.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

- **Four new record families, nothing else.**
  - `itw-task-admission` (version 1, `$git/task-admissions/itw-<32 hex>.json`): the receipt of a task handed over from Ask SFlow, private to the clone, which keeps one Work ID for that handoff (`src/task-admission.mjs`).
  - `ask-conversation` (version 1, `$local/ask-conversations/v1/<64 hex>/ask-<32 hex>.json`): a saved Ask SFlow conversation on this machine (`src/ask/conversation-store.mjs`).
  - `ask-portable-conversation` (version 1, under the shared provider folder): a conversation shared to resume elsewhere (`src/ask/shared-contract.mjs`).
  - `ask-portable-host` (version 1, `$local/ask-conversations/device-v1/…`): this machine's copy of a shared conversation (`src/ask/shared-conversations.mjs`).
- **What this does not change:** no existing family, version, migration or path changes; no approval group, member, minimum or rule changes. A handed-over task starts through the same Story start, identity, authority and publication checks as `work --start`; the receipt authorizes nothing.
- **Checked by:** `test/ask-r4.test.mjs`, `test/ask-r5.test.mjs`, `test/gdp-contract-freeze.test.mjs`.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | Four new record families for Ask SFlow conversations and its task handoff | `sha256:219ed2a1510129cf99582fdef16886766b9ad947b00e58720a77d7ba11865631` | `sha256:1c707ccb8bfd41611fb27cf883abd51bd8d8c6ba3f2eb830e7eaeb3000d38351` |
