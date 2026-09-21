# CAB-R2 authenticated-runner provider foundation

**Status:** code-local diagnostic foundation; runner integration, authentication, enforcement, and
assurance upgrades are unavailable

This foundation makes the absence of CAB-R2 authority inspectable without pretending that a local
configuration file supplies it. It implements only:

- a closed, credential-free authenticated-runner provider descriptor;
- deterministic validation of that descriptor;
- a read-only doctor projection; and
- inclusion of the same projection in GDP readiness.

It does **not** start a runner, load provider code, verify signatures, ingest evidence, issue or
store keys, access credentials, alter a Story, satisfy a gate, or upgrade an assurance label. A
valid descriptor still reports `status: unavailable`, `authority: none`, `gateEligible: false`,
`consumedByLifecycle: false`, `enforcementAvailable: false`, and
`assuranceUpgradeAvailable: false`.

## Inspect the default

```text
singularity-flow delivery authenticated-runner-status --json
```

The default reports `CAB_RUNNER_PROVIDER_NOT_CONFIGURED` plus the independent integration, trust,
sandbox, platform, pilot, and evidence-storage gaps. Ordinary unenrolled work remains unaffected.

## Inspect a reviewed declaration

Create a repository-relative JSON file conforming to
[`cab-authenticated-runner-provider.schema.json`](../schemas/cab-authenticated-runner-provider.schema.json).
The descriptor contains only stable IDs and SHA-256 policy identities:

```json
{
  "schemaVersion": 1,
  "kind": "cab-authenticated-runner-provider",
  "providerId": "cabp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "providerType": "enterprise-ci",
  "integrationId": "cabi_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "trustRootSha256": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  "runnerProfileSha256": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  "sandboxPolicySha256": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  "trustPolicySha256": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
  "resultIngestionPolicySha256": "sha256:5555555555555555555555555555555555555555555555555555555555555555",
  "evidencePolicySha256": "sha256:6666666666666666666666666666666666666666666666666666666666666666",
  "acceptedIssuerDigests": [
    "sha256:7777777777777777777777777777777777777777777777777777777777777777"
  ],
  "acceptedAudienceDigests": [
    "sha256:8888888888888888888888888888888888888888888888888888888888888888"
  ],
  "enabled": true
}
```

Then inspect it:

```text
singularity-flow delivery authenticated-runner-status \
  --runner-provider-file cab-runner-provider.json --json

singularity-flow delivery readiness \
  --runner-provider-file cab-runner-provider.json --json
```

`providerId` and `integrationId` are role-prefixed opaque 256-bit identifiers (`cabp_` and `cabi_`),
not provider names, account labels, tenant names, paths, or credential fields. All digests and IDs
must be JSON strings; coercible numbers, arrays, and objects are refused.

`enabled` means only that the reviewed declaration intends to use this provider after every
external gate is satisfied. It does not activate anything in this release. Unknown properties—including
tokens, passwords, commands, paths, endpoints, or inline certificates—are refused. Provider secrets
belong in the independently approved external provider and its operating-system or enterprise
secret boundary, never in repository configuration.

## Why this is separate from GDP provenance

GDP provenance names a verifier and a trust-root digest for several provider-neutral envelopes.
That does not prove hostile-code containment, process-tree quiescence, isolated result ingestion,
runner identity, or evidence-store authority. The CAB descriptor therefore remains separate: a
valid provenance descriptor cannot accidentally become authenticated-runner authority.

## What remains external

CAB-R2 still requires an independently operated runner and trust root, supported-platform
containment evidence, signer issuance/rotation/revocation/replay authority, bounded evidence CAS,
provider outage and privacy pilots, and independent security/platform approval. Only a later
reviewed integration may consume authenticated evidence. CAB-R3 enforcement and CAB-R6 lifecycle
consumption remain unavailable.
