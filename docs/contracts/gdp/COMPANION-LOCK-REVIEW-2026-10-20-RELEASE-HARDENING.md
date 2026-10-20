# GDP companion authority review — release hardening — 2026-10-20

Review boundary: `97499663b15243bb0d6a2824476d522f3ced1cea`. The previous review is
`COMPANION-LOCK-REVIEW-2026-10-19-PUBLICATION-CONTEXT.md`.

This is a code-local semantic review, not independent human approval, platform qualification or a
release attestation. The lock remains `contract-only`. Only the two companions described below
change; every other accepted digest is retained.

## Workflow configuration

Commit `ab2155a0` adds exactly one configuration line:
`documents.storage: { allowed: [local], default: local }`. Its parent file hashes to the previously
accepted digest, so no other template change is included in this review.

The new default keeps uploaded document and image bytes on the originating laptop. Shared Story
records and durable prompts retain identity, size, media type and digest, not local paths or file
contents. A different laptop must restore the same existing document identity from the original
file; unavailable evidence is not silently considered present. Explicit legacy Git-stored evidence
remains readable under its retained policy. This changes the default storage selection for new
configuration, not approval authority or the interpretation of already accepted workflow snapshots.

Coverage owners include `test/document-storage.test.mjs`, `test/document-upload-phases.test.mjs`
and `test/planning.test.mjs`. The planning regression now checks that a durable pack contains only
the local document's exact identity while its issued private view route still reads the original.

## Migration registry

Commit `cccf1f04` adds one version-1 `performance-trace` family for private Git-administrative paths
matching `$git/dx/performance/<UUID>[.host].json`. Its parent registry hashes to the previously
accepted digest, so this review includes no other registry or migration change.

This recognizes the opt-in local diagnostic records introduced by the performance collector. It
adds no migration step, lifecycle state, approval group, external provider, execution permission or
GDP rollout authority. The existing private retention and bounded-record validation remain the
collector's responsibility. Coverage owners include `test/performance-trace.test.mjs` and the
schema-upgrade tests. The new family is not one of GDP's deferred authority families.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | Recognize private version-1 performance trace records. | `sha256:b010402f5395514566ae22e7a1d2cc9793588c51f19b305e671ea010e113fcfc` | `sha256:788df5337b1fe8bdae3a156ccb2de80ee4acdf14df08906d337688cb61ec2770` |
| `workflow-configuration` | Default new upload configuration to laptop-local storage. | `sha256:2c1629170aea3e0ae5511cfd021899b35eb7120d2d61d1ca600605afda761b4a` | `sha256:5e28785c9d8b2f52712f4fc15c3688ddc210afe4fecd7367e3843dfea4ebfc8d` |
