# GDP companion authority review — SKP M2 amendment lineage — 2026-09-26

**Review boundary:** `main@05684f0301931b11706520c9c8b91ca2bb938f8e`. The M0 baseline remains
`70db564e59224b03729bab0f9a340807f3086c61`.

The only changed GDP-locked companion is `src/schema-migrations.mjs`. It registers an immutable
skill-adoption decision, proposal, impact, human-review, and WFA amendment families, advances the WFA manifest reader to v3 and
Story workflow reader to v10, and registers a v2 skill snapshot reference while preserving a
stored v1 template reference. Its v1→v2 and v2→v3 WFA transitions and v9→v10 Story transition
are read projections only: they neither rewrite historical bytes nor invent adoption decisions,
approval, package provenance, host execution, or changed Story policy. The WFA reader must
verify the accepted amendment commit, decision, and chain before a new revision is authoritative.

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `migration-registry` | Registers only versioned, closed skill-adoption and WFA lineage shapes; older template and skill Story bytes retain their original stored authority. | `sha256:9305da921cb259a8c9d447061503b305e35ec0868ccb3112c3df602538211b8d` | `sha256:60aa3f6d85c78619e74ad175c3adfc081a88f173957de9c9bd2dae5d7d03659b` |

Validation: migration goldens, historical and amended WFA snapshot tests, GDP companion-lock,
and Story amendment state tests must pass against this exact digest. Any later registry edit
requires another bounded review.
