# GDP-M9 local hermetic observation profile

GDP-M9 now has a deliberately non-authoritative local evaluator for digest-only evidence. It lets
teams exercise the high-assurance record shapes before an authenticated hermetic runner, signer,
and trust root are approved.

Run it from the governed repository:

```text
singularity-flow delivery assurance-evaluate --evidence-file <repository-relative.json> --json
```

The input identifies the Work ID, Proof Subject, Candidate, changed executable regions, test
executions, witnesses, and mutation observations only by SHA-256. Paths, source bytes, credentials,
and raw identities are not accepted. The evaluator executes no product code, invokes no model,
writes no record, and makes no network request.

The result contains an Executable Change Map, Changed Region Coverage, Witness Independence, and
non-authoritative Mutation Observations. Even a complete observation reports `authority: none`,
`mode: observe`, `gateEligible: false`, and the gap `RUNNER_AUTHENTICATION_UNAVAILABLE`. No existing
lifecycle, approval, gate, recovery service, or publisher consumes it.

The Proof Gap Acceptance schema and pure builder require a human authority digest, exact Proof
Subject and gap digests, a reason digest, and an expiry. There is intentionally no CLI writer yet:
accepting a gap becomes authoritative only after the existing approval system and an authenticated
provider are bound in a later, separately reviewed increment.

This is not evidence that arbitrary application code ran in a sandbox. It is a safe compatibility
profile for local evaluation. Enforcement remains unavailable until runner isolation, signer
identity, trust roots, revocation, recovery, and platform evidence have been approved.

For a stronger local-only option, the
[`developer-local signed runner`](GDP-LOCAL-SIGNED-RUNNER.md) can execute one approved argv-form,
model-free phase quality command and retain a tamper-evident receipt. It still has no independent
or enterprise authority and is never consumed by lifecycle gates.
