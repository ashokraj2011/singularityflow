# GDP companion authority review — WEL lifecycle — 2026-09-22

**Review boundary:** `main@dc2146c99abfdb9cb910c5612844507356c85913`

**M0 baseline retained:** `70db564e59224b03729bab0f9a340807f3086c61`

This bounded review reconciles the three exact companion authorities changed by the fail-closed WEL
lifecycle projection. The M0 baseline remains unchanged. None of these changes supplies an
authenticated runner, approval authority, cross-authority lifecycle verification, or enforcement
eligibility.

## Reviewed drift

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `migration-registry` | Advances `test-execution` from v3 to v4 with a closed lifecycle-unavailable projection and registers the immutable approved-runner supplement envelopes at their real private-store paths; migration preserves historical observations and cannot invent Candidate, Program, retry, approval, publication, or runner authority. | `sha256:f5bc636a3191eb67bf786cf5260ded5b0d664cb6dc9b1eeddcd0e2a8bc8b8652` | `sha256:6261e5fcc1335cc4e12e9663c334c28fedbba1b25eba93524e962f0529cc8f6e` |
| `witnessed-engineering-delivery-status` | Records the repository-local lifecycle join and fail-closed readiness foundation while retaining every external runner, trust, platform, release, and independent-review gate. | `sha256:278cca06ddbeb92d034990558187f68871654a6c25bdc43574a3ccf531201eed` | `sha256:3c95a71cfccda8654fb3287ac41d997889109680a4b8f57a29df638837da222b` |
| `witnessed-engineering-loop` | Updates the schema inventory to `test-execution` v4 and documents that the added lifecycle projection records absence only and grants no execution or publication authority. | `sha256:386d3dab9b68e268069f489a0db97ecce67bfb49e16f76273192941778c863ef` | `sha256:cdbcf42d94286c30a12381074d6df4aac7008a5cddf41da500ce7add7716542d` |

## Validation boundary

The migration goldens, closed lifecycle and readiness schemas, owner-binding regressions, public
read-only doctor, and GDP companion-lock test cover this transition. Enforcement remains
unavailable; future changes to any accepted digest require another bounded companion review.
