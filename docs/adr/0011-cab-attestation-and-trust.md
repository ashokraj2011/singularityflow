# ADR 0011 — CAB authentication is external to the Candidate

- **Status:** Proposed for independent CAB-R0 review
- **Date:** 2026-09-05
- **Scope:** checker attestations, human decisions, and publication identity

## Decision

Self-hashes establish integrity only. An enforcement-grade checker receipt requires an approved
external trust root and a signed envelope binding the Candidate, Program, task attempt, operation,
verifier, toolchain, effective configuration, result, audience, policy epoch, nonce, and validity
window.

Trust is separated by claim:

- developer-local observations are unauthenticated and non-enforcing;
- an approved independent runner may authenticate checker evidence but cannot approve or publish;
- existing human authority groups decide reviews and exceptions;
- the existing lifecycle kernel alone publishes through exact Git compare-and-swap.

Verification rechecks key status, revocation, audience, expiry, policy epoch, and nonce consumption
when evidence is used, not only when it is issued.

## Consequences

- the existing developer-local signer remains useful test evidence but never becomes independent;
- Git-trusted policy transport does not authenticate the runner process;
- stale or revoked evidence becomes unavailable/tampered rather than pass;
- key issuance, custody, rotation, revocation, and replay service remain external CAB-R2 inputs.

## Rejected alternatives

- trusting any record because its SHA-256 matches;
- storing a private verifier key in the Candidate or repository configuration;
- letting the runner approve its own output;
- accepting an attestation without an audience, expiry, nonce, or policy epoch.
