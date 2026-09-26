# GDP companion authority review — SKP M2 retained evidence — 2026-09-26

**Review boundary:** `main@23e38d41f5b6ffc32e67e6bea678cb4f866aa85b`. The M0 baseline remains
`70db564e59224b03729bab0f9a340807f3086c61`.

The only changed GDP-locked companion is `src/schema-migrations.mjs`. Its new registrations are
closed readers for Story workflow v9, WFA snapshot v2, phase-input record v2, and Story submission
packet v3, plus an embedded SKP phase-evidence v1 family. The Story and input migrations are
identity projections; a v1 WFA snapshot keeps its original stored bytes and hash domain. The
embedded evidence has no independent storage path. None of these registrations grants skill
execution, host containment, approval, or publication authority. Skill phases remain refused at
the host boundary until separate qualification.

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `migration-registry` | Registers only the versioned SKP retention and evidence shapes above, preserving historical template Story interpretation. | `sha256:e0ca2a388d3a00bc3475928ae7774bd75c6b93e3d5e6dff53558535b00ea4027` | `sha256:9305da921cb259a8c9d447061503b305e35ec0868ccb3112c3df602538211b8d` |

Validation: migration goldens, historical Story snapshot tests, SKP accepted-package and evidence
tests, and the GDP companion-lock test must pass against this exact digest. Any later change to the
migration registry requires another bounded review.
