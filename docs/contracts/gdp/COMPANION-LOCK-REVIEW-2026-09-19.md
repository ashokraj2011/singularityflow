# GDP companion authority review — 2026-09-19

**Review boundary:** `main@bd08c29a029f288d7b928cf3e762bf41cc3bef7e`

**M0 baseline retained:** `70db564e59224b03729bab0f9a340807f3086c61`

This review reconciles five exact companion authorities that changed after their previously accepted
digests. The M0 baseline commit is intentionally unchanged: it identifies the original contract
decision, while the companion digests identify the currently reviewed authority bytes. This is not
a bulk hash refresh.

## Reviewed drift

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `workflow-configuration` | Repository readiness policy, fail-closed approved-summary inputs, repaired Spec-Driven Release inputs, Classic Delivery, and bounded spec-code-test/rework workflows through `3268d94635caef25b284a391a01f91d760372eb9` | `sha256:4805991b7ccdf22dd327e25923ee8158443b2eafb7d45a329efa057bed104e8f` | `sha256:6d3aa787490db9b9db23d2b938018776634d2af57734df2c326350894d82db4d` |
| `world-model-v4` | Clarification of registered-v4 versus legacy view selection and state-only refresh behavior through `37f595a43355199410337b257ae2f5697ef9fca4` | `sha256:2a79b554d4243cf2aebc5f0307c26eeaa3319a03ebf6e918e168e33eb3c665ef` | `sha256:badf17ea209193ed630f93ef42ce239284830586cefd28d8fb97ba486ecc6659` |
| `publication-unit-of-work` | Opt-in REV publication attestation and fail-closed uncertain-ref/local recovery handling through `5fca9fc2bd34503ae5e95f263197c294ca4419b3` | `sha256:f44901e77621866bb764155f0ef7aef02b10ef1f5ccdd279e5c429df3d8f08cd` | `sha256:e7431fb02ab8b74699d34f1c840f38f61b86466a1350164014b91fdc3a93316a` |
| `migration-registry` | Story workflow v7 compatibility, repository-readiness, distribution, and frozen REV record families through `dd15ada378c77945887504529ff18ad4a11e9757` | `sha256:6e39e94a36116761ca35151821ff4b7a3f394749626f89839b6a2424ee18ef0d` | `sha256:5cd400375ac96899136649d149da7d7f104ac1d975b70597f40ed563eb102296` |
| `smart-initialization-v1` | Additive pre-Story readiness policy; existing smart-init delivery selection and fixed-policy compatibility remain unchanged through `860bc5aef5cb919bf26d88cffff57d2521bf2a22` | `sha256:cc9d695992ca5971fce6085cfa30e7075bcb8174c01da239eabc30e98c3a89da` | `sha256:ba9b3bb95a0974a42bf42161c26f78f4389a3f2a43343bffb7091af9e868f3a6` |

The workflow changes do not add a GDP delivery mode, change the `workflow | outcome` vocabulary,
or turn a recommendation into authority. The WMB wording retains the rule that Story lifecycle
operations do not trigger a full model rebuild. The publication changes remain inside the shared
publication unit of work instead of creating a GDP-specific writer. The migration additions do not
register a new GDP durable family. The initialization change does not reinterpret existing fixed
delivery selections.

## Validation evidence

The review ran on Node 22.14.0. The focused authority-owner set passed 305 tests across workflow
configuration, Classic Delivery, the spec-code-test loop, Story readiness, registered WMB v4,
publication fault/recovery, linked-worktree publication, REV publication attestations, migration
goldens, smart initialization, and repository readiness. The TypeScript-aware workflow-designer
checks passed 3 tests. The GDP contract-freeze suite, including the reconciled companion lock,
passed 5 tests. No digest was accepted to make a failing owner test green.

## Sanctioned reconciliation procedure

1. Run the companion-lock test and record only the named mismatches.
2. For each mismatch, locate the last commit whose bytes match the accepted digest, inspect the
   complete path diff and every path-affecting commit, and identify the authority boundary affected.
3. Confirm the change does not violate the GDP ownership, vocabulary, storage, migration, or
   recovery decisions in `docs/GDP-CONTRACT-VNEXT.md` and its ADRs.
4. Run the authority owner's tests plus `test/gdp-contract-freeze.test.mjs`. A test failure is never
   resolved by refreshing a digest.
5. Patch only the reviewed companion entries, add a review record like this one, and update
   `lastReview` in the lock. Do not update `baselineCommit` unless the GDP contract baseline itself
   is superseded by a separately accepted decision.

The lock test verifies the current authority bytes, the deterministic reviewed-ID list, and the
presence of each accepted digest in this evidence record. Any subsequent authority change therefore
fails closed until another bounded review is recorded.
