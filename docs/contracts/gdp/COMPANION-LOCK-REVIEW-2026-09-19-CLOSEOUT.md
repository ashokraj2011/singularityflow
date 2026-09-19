# GDP companion authority closeout review — 2026-09-19

**Review boundary:** `main@b6d059cfd6ffceff90c36454a173cace32efd9fe` plus the bounded
persisted-history activation change reviewed in this working tree.

**M0 baseline retained:** `70db564e59224b03729bab0f9a340807f3086c61`

This review reconciles six exact companion authorities. It does not change the M0 GDP baseline,
add a GDP delivery mode, make an advisory record authoritative, or let migration invent a current
decision. The SGOS and WEL changes distinguish completed code-local boundaries from still-external
signed release evidence; the CAB wording keeps authenticated Candidate/Program/attempt joins
unavailable until their owners exist; and the WMB change consumes already-published exact history
without rebuilding it during Story creation.

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `code-assurance-bridge` | Clarifies that authenticated runner and lifecycle joins remain null until CAB-R2/CAB-R6 provide their authority | `sha256:2bde8058e87c4bb4ceadecb16ea60cec05927de0441f734a5eeb8f81af872235` | `sha256:5fbbe8e7fef0bb5fb0c7cd4df9d1a7d0486e4a72fa63812c0612f4379e0fd1e6` |
| `migration-registry` | Adds Story-workflow v8 and prompt-injection v7 compatibility readers; legacy Stories omit the optional history pin and retain no unproven persisted-grounding authority | `sha256:5cd400375ac96899136649d149da7d7f104ac1d975b70597f40ed563eb102296` | `sha256:b5eb6f0e78ed66c83e1e707987fa62bc6ad1dd1da5dc18fc0a2faa857cd8072f` |
| `sgos-contract` | Documents the implementation-pinned live Operational Store cutover, exact migration, fsck, and retained external qualification boundary | `sha256:d70606dc4c9a87d2776c8f64958178c53ac315f9056004e9496f9552aa35f880` | `sha256:2ad0cb4a68fe523ec865ed694928d10f9c910186fcfcabbb9056c014583e9200` |
| `sgos-delivery-status` | Reconciles completed code-local live-store/meta-tool work while retaining signed platform, broker, certification, and telemetry gates | `sha256:9276736321ccee3800d01428de1a87043c9d62448625ba502ff33be7f5a281e2` | `sha256:a491940d51fece3f7096119555bec896d23b61ed8c24e1c8bfe856c2602be305` |
| `witnessed-engineering-delivery-status` | Makes corpus execution and the unavailable authenticated execution/lifecycle dependencies explicit | `sha256:bdc18dada515fceb72ac300e2413664371f05d1524299de08f68bc6fde7422a8` | `sha256:bd67f0907e4d28636fa9a4c432eb48b4a12949dccd41686cbd2768578448cbe7` |
| `world-model-v4` | Documents lifecycle-owned, read-only exact-history selection and immutable pinning for new registered-v4 Stories, with no hidden build | `sha256:badf17ea209193ed630f93ef42ce239284830586cefd28d8fb97ba486ecc6659` | `sha256:83bdf74bf9b836a46f10a2f49f3440e4927aa8c0cd47553009b050543d192b18` |

The owning migration, SGOS, WEL, CAB, registered-v4, persisted-history, Story activation, prompt
integrity, and GDP lock tests establish these transitions. The repository-wide check and aggregate
suite remain the acceptance gates for the final commit; a digest is not accepted in place of those
owner tests.

## Sanctioned reconciliation procedure

1. Inspect every named path change against its authority owner and closed vocabulary.
2. Run the owner tests before changing any digest.
3. Change only reviewed lock entries and preserve the M0 baseline unless a separate GDP decision
   explicitly supersedes it.
4. Keep release evidence, external authority, and unsupported adapters unavailable rather than
   manufacturing local proof.
