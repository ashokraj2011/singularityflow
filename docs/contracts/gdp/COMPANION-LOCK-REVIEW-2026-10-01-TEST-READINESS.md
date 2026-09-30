# GDP companion authority review — pre-Story test readiness — 2026-10-01

Review boundary: `c40848cf810a8324b6a5e585984d0c9a2e8f285d` plus this lock review. The preceding review is `COMPANION-LOCK-REVIEW-2026-09-30-SPEC-DRIVEN-DOCUMENTS.md`.

One GDP-locked companion changed. `migration-registry` registers two version-1, immutable, Git-private repository-readiness records: the exact pre-Story test baseline and the local human test-risk acknowledgement. Each registration is restricted to its own private Git path. It adds no migration step, GDP proof family, approval authority, or permission to publish a failing test result. In particular, a local risk acknowledgement does not bypass Story-start or phase-publication gates.

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `migration-registry` | Register `repository-test-baseline` and `preexisting-test-risk-acceptance` as immutable version-1 records at closed Git-private paths. | `sha256:6a4b948ffeca3e73d6ad0205d3f93b3b5097c3841cbd5aa82f087589a9206d78` | `sha256:6d363036f77021acfba5cccae8174fcc1e177da27a63d4ac8bdbdb12e0916f75` |

The accepted digest is calculated from the reviewed source bytes. The GDP contract and the other companion digests remain unchanged. The migration and GDP companion-lock tests must pass against this exact source.
