# GDP companion authority review — independent evidence foundations — 2026-09-21

**Review boundary:** `main@2577c98303f3dfab85e1360eabd7138d3a8eca61` plus the bounded
independent-evidence changes reviewed in this working tree.

**M0 baseline retained:** `70db564e59224b03729bab0f9a340807f3086c61`

This review accepts three exact companion-authority documentation changes. It does not install an
authenticated runner, approve a provider or trust root, execute a private corpus, manufacture
physical-platform evidence, or grant lifecycle authority. The accepted changes document the
fail-closed CAB provider/readiness foundation and require independently signed, content-free WEL
corpus review evidence in current release receipts while keeping all external evidence obligations
visible.

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `code-assurance-bridge` | Records the credential-free CAB-R2 provider descriptor and read-only readiness projection while retaining the missing integration, trust, sandbox, platform, pilot, storage, and lifecycle-consumption boundaries | `sha256:5fbbe8e7fef0bb5fb0c7cd4df9d1a7d0486e4a72fa63812c0612f4379e0fd1e6` | `sha256:b02db4dcf74192d0d33a6e34af0dbd696f831802ff395e67757b4fde8ecbc392` |
| `witnessed-engineering-delivery-status` | Records the reviewed-manifest corpus comparison and signed WEL review-receipt release binding without claiming that the private corpus, independent disposition, or physical release matrix has run | `sha256:bd67f0907e4d28636fa9a4c432eb48b4a12949dccd41686cbd2768578448cbe7` | `sha256:278cca06ddbeb92d034990558187f68871654a6c25bdc43574a3ccf531201eed` |
| `world-model-v4` | Adds the separately trusted WEL corpus-reviewer receipt and key to the existing build-once, verify-many release handoff; it does not make World Model generation a release verifier | `sha256:ef6898bada60e1ec02c4accc1a14b4b2042958dea7233943ead948c3a8b87c56` | `sha256:fb19e89523dddf37fa11dcf8b13305d6c128de0deefeea7b3e4ce2df5f710098` |

Focused CMP, WEL, CAB/GDP, release, packaging, schema, and backwards-compatibility tests establish
these exact transitions. Repository-wide checks and the aggregate suite remain final acceptance
gates. Any future change to these authorities requires another explicit digest review.
