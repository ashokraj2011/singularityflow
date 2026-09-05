# GDP-M10 provider-neutral provenance contracts

GDP-M10 defines provider-neutral envelopes for build, environment, deployment, runtime identity,
and production observations. It does not install a CI system, trust root, signing key, verifier, or
credential broker.

Check readiness from a governed repository:

```text
singularity-flow delivery provenance-status --json
singularity-flow delivery provenance-status --provider-file <repository-relative-provider.json> --json
```

Without a descriptor the result is `PROVENANCE_PROVIDER_NOT_CONFIGURED`. With a valid descriptor,
the shipped CLI still reports `PROVENANCE_VERIFIER_NOT_INSTALLED`, `authority: none`, and an empty
accepted-family list. Naming a provider or a trust-root digest is not proof that the verifier exists
or that an attestation is authentic.

The descriptor contains provider/verifier IDs, a trust-root digest, accepted issuer and audience
digests, and an enabled flag. It cannot contain credentials. The signed envelopes bind issuer,
audience, Proof Subject, Candidate, nonce, issue/expiry times, policy epoch, signer key, a public
detached signature, and the family-specific artifact/deployment/runtime identities. The signature
bytes are public evidence, not a secret; their digest is verified before the envelope is admitted.

The reusable contract evaluator rejects provider, issuer, audience, nonce, expiry, revocation, and
signature failures before consulting an injected verifier. No verifier is silently selected. An
approved integration must supply the verifier and its protected credential access outside prompts
and ordinary evidence.

The older M4 `environment-attestation` remains a local observation. GDP-M10 uses the distinct
`provider-environment-attestation` family so an upgrade cannot silently give old evidence stronger
authority.

Production pilot, provider-outage, revocation, residency, legal-hold, and deletion exercises are
still required. These contracts therefore do not make GDP-M10 complete or GA-ready.

The [`developer-local signed runner`](GDP-LOCAL-SIGNED-RUNNER.md) is intentionally separate from
these provider contracts. Its key authenticates a same-user local process; it does not satisfy the
approved issuer, independent verifier, enterprise trust-root, revocation, or production controls
required by GDP-M10.
