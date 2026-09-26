# GDP companion authority review — frozen view-contract version — 2026-09-26

**Review boundary:** `main@ab9f5623fa3616d921f7159211c69f126d7e3df7`. The M0 baseline remains
`70db564e59224b03729bab0f9a340807f3086c61`.

Since the previous accepted lock at `b51bb17e788f70fda1c6fa180dc3c939aa42d575`, the only
change to a locked companion is in `src/schema-migrations.mjs`. Commit `ab9f5623` imports
`WORLD_MODEL_VIEW_CONTRACT_SCHEMA_VERSION` from the new
`src/world-model/view-contract-schema-version.mjs` and uses it as the
`world-model-view-contract` family's `currentVersion` instead of the literal `1`. The shared
constant is exactly `1`. The family remains immutable with `frozen-identity` migration policy;
no family, version, migration, storage path, writer, or GDP authority is added or removed. The
view registry now uses the same constant to avoid loading the full migration table in VS Code
panels. Every other locked companion retains its accepted digest.

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `migration-registry` | Sources the frozen view-contract schema version from a shared constant whose value is still `1`; registration and migration policy are unchanged. | `sha256:da01db0874d1f7998d25d83407de00a8eab0d7b248abd0798dbd9a12c6728668` | `sha256:e0ca2a388d3a00bc3475928ae7774bd75c6b93e3d5e6dff53558535b00ea4027` |

Validation: the migration golden and persisted-contract tests passed (17/17); the migration lint,
model-owner, and persisted-overview view tests passed (22/22). The GDP companion-lock suite passed
after this bounded reconciliation (5/5). Any later migration-registry byte change requires a new
review.
