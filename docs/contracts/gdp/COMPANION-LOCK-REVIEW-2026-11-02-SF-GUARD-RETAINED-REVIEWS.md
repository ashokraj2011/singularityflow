# GDP companion authority review — SF Guard, retained review decisions — 2026-11-02

Review boundary: `97966e04f267de646cca25b3789b6eedd67258c4` (`main` at the start of this change, with SF Guard's remaining person steps). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-02-SF-GUARD-PERSON-STEPS.md`.

Two GDP-locked companions change in this change: `action-authorization` and `migration-registry`. No other companion differs from its accepted digest at this boundary.

## Reviewed in `src/action-authorization.mjs` (`action-authorization`)

- Changed: `captureTerminalActionAuthorization` takes an option, `presenceInRecord`. A review whose decision record keeps its own presence signature (a quality risk decision or revocation, an appeal decision) passes it, and the card-only touch is skipped there: the same person, in the same process, gives one touch where the decision record is written, over that exact record (SPEC-PSS-v1 §10.7). Without the option the review is exactly as before, card-only touch included.
- Unchanged: the typed confirmation, the identity check, the authorization record's shape, storage, expiry and consumption, and every existing refusal. Where SF Guard does not apply, no touch is asked for either way.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

- `phase-appeal-decision` goes to v2 (`migration(1, 2, identity(2))`): a decision on a Story with an SF Guard pin, which may keep its approver's presence block. It is written only on a pinned Story, so a repository that never opted in keeps writing v1 that older builds read. A v1 decision never carries a presence block (the schema refuses one).
- `source-review-decision` goes to v2 the same way, on the same rule.
- Unchanged: every other family, path pattern and immutability flag.

The authority reads as `model: never`. Nothing here lets an agent decide anything: a retained review decision on a Story SF Guard requires now counts only when its signature verifies against the approver's pinned key, and nothing changes where SF Guard does not apply.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `action-authorization` | One touch where a review's decision record is written (`presenceInRecord`). | `sha256:8b28870ccf750d54cb91cb62cc4045e7802a310542ab41394c6484ac445807e2` | `sha256:9b62f5d1749d94a97223844181b893e32fe0b07c228fde74ad0d703c1b2eb44e` |
| `migration-registry` | `phase-appeal-decision` and `source-review-decision` v2, written only on a Story with an SF Guard pin. | `sha256:b57907f1650030733319e8502c9a6d37c0e77f81017e4d20619ecefc8b19ed0c` | `sha256:76bad0ffb369fa4dea7fbb97c252346e57644d06054ab83136ed81a953f812c8` |
