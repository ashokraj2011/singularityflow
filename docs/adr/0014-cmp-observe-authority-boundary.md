# ADR 0014 — CMP observe-only authority boundary

**Status:** Accepted for the P0 observe-only tranche

**Date:** 2026-09-05

## Context

Governed Comprehension and Explanation Completeness (CMP) needs stable identities and closed
diagnostics before it can safely record or enforce cause-to-change claims. The current Story
lifecycle still has its own exact repository change-set subject, while SGOS supplies the future
universal Candidate boundary. Creating a CMP-specific Candidate, approval, or publisher now would
introduce a second publication authority.

## Decision

The P0 CMP surface is read-only and non-authoritative:

- `comprehension regions` projects the existing verified repository change set into conservative
  resource regions;
- `comprehension check` evaluates caller-supplied evidence as an unverified observation;
- outputs are schema-transient and are never durable CMP records;
- the command invokes no model, AST builder, lifecycle mutation, approval, or publisher;
- exact `--phase` selection requires `--work-id` or an attached Story; repository-only inspection
  uses `--base` without `--phase`;
- cause, relationship, disposition, assurance, availability, refusal, and diagnostic values come
  from closed registries;
- missing structure is reported as unavailable and falls back to exact resource-level source
  representation rather than blocking ordinary work.

P1 must decide storage, retention, privacy, migrations, and rollout before any record mode exists.
P5 may enforce completeness only after every lifecycle publication uses the single universal SGOS
Candidate and CMP reuses the existing review, approval, transaction, and recovery authorities.

## Consequences

The current pilot can reveal incomplete or contradictory explanations without granting or denying
publication authority. A locally self-consistent input bundle cannot mint a governed decision.
Future durable CMP records require migration-registry schemas and a separate reviewed ADR; future
enforcement requires the universal Candidate dependency and the every-workflow lifecycle matrix.

