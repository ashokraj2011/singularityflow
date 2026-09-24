# GDP companion authority review — onboarding cleanup — 2026-09-25

**Review boundary:** `main@b51bb17e788f70fda1c6fa180dc3c939aa42d575`, which added one
local migration-family registration. The M0 baseline remains
`70db564e59224b03729bab0f9a340807f3086c61`.

The reviewed change registers `repository-onboarding-cleanup` schema version 1 only for
`$local/repository-onboarding-cleanup-v1/<sha256>.json`. It admits the local cleanup record to
the existing migration boundary; it does not grant a workflow, approval, publication, or remote
Git authority. No other locked companion changed its digest in this review.

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `migration-registry` | Registers the bounded local onboarding-cleanup record family, without lifecycle or publication authority. | `sha256:fd37771b0786e026a2354acbb12987f443c385986236dd20b38a4db0df3a4c61` | `sha256:da01db0874d1f7998d25d83407de00a8eab0d7b248abd0798dbd9a12c6728668` |

The GDP companion-lock test continues to compare every listed file against its exact digest. Any
later byte change to the migration registry requires another explicit review.
