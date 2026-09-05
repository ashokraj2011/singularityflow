# ADR 0012 — CAB checker execution requires attested hermetic isolation

- **Status:** Proposed for independent CAB-R0 review
- **Date:** 2026-09-05
- **Scope:** every CAB checker that executes Candidate-controlled code

## Decision

Enforcement-grade checking requires a disposable non-root environment with immutable Candidate
input, a separate bounded result volume, an empty private home, no host/Git/container sockets, and
deny-by-default network. CPU, memory, disk, PID, wall-time, output, and artifact counts are hard
limits. Cancellation must terminate the process tree and prove quiescence before releasing its
lease.

The attestation binds the runner image or host profile, parser, toolchain, rules/database,
dependency mirror, effective configuration, suppressions, and sandbox policy. Result ingestion is
a separate strict parser boundary. A clean post-run worktree is evidence, not containment.

## Consequences

- current in-process and developer-local commands cannot support CAB enforcement;
- unsupported operating-system containment reports unavailable;
- dependencies may use only policy-approved mirrors/endpoints;
- parser and artifact attacks need their own cross-platform adversarial fixtures;
- CAB-R2 cannot complete without an independently operated runner and trust root.

## Rejected alternatives

- executing hostile tests in the developer checkout;
- treating a temporary directory as a sandbox;
- mounting Git common directories or credential agents read-only;
- allowing unrestricted network and attempting to redact afterward;
- assuming child-process cancellation proves descendant quiescence.
