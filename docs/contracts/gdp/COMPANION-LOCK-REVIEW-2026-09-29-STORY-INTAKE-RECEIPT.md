# GDP companion authority review — Story intake receipt family — 2026-09-29

**Review boundary:** `perf/fast-intake-form@b2b12cdef49ae68b3859c4d1e71373328370a0eb`, the fast Story intake form, on which the intake receipt change was reviewed. The previous review is `COMPANION-LOCK-REVIEW-2026-09-29-STORY-START-PUBLICATION.md`.

Exactly one GDP-locked companion changed. `migration-registry` registers one new durable record family. No existing family, version, migration step, stored path or read policy changed. This is not a bulk hash refresh or a new approval authority.

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `migration-registry` | Registers `story-intake-receipt` v1 (no predecessor, no migration steps) at `$git/intake-receipts/sir_<32 hex>.json`, including the name a claimed receipt takes while one Story start uses it. A receipt is machine-local and short-lived: what a passing Story readiness preview observed, sealed with the repository's machine-local integrity key, so Story start can verify those inputs in one concurrent observation instead of rediscovering them. It authorizes nothing: start re-observes every governed input, runs a fresh publication dry run and recomputes readiness, and any mismatch takes the ordinary path. | `sha256:9a7053f60e73b4dfe6dfbc587880745fdf489ce376d9900bf80f65fa30fbbac3` | `sha256:8f25019c22c71699c165a2dbc4a53d743cbf0cd020f9d3b2ac1f859d5035587b` |

The family carries no shared, governed or published bytes. Receipts live beside the existing pending-publication records in the Git common directory, are created exclusively with owner-only permissions, expire after fifteen minutes and are consumed by the first start that presents them. They record credential-free remote URLs, fingerprints and commit identities, never a checkout path or intake content; the request is bound by digest. Both digests were computed from the file bytes at the boundary and after the change, not copied from a failing assertion.

Validation at this boundary: the schema golden corpus (with the new family's frozen v1 record), the intake receipt unit tests, the Story intake start integration tests and the approved-configuration object-cache tests passed. The GDP companion-lock suite must pass against this exact accepted digest.
