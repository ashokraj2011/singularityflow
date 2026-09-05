# ADR 0008 — WEL authority and two-plane storage

- **Status:** Accepted for the observe-only pilot
- **Date:** 2026-09-05
- **Scope:** Witnessed Engineering Loop (WEL) local observations and human mapping review

## Decision

WEL is an integration profile over existing Singularity Flow authorities. It does not create a
runner, scheduler, approval quorum, publisher, or source identity.

| Durable fact | Sole authority | Durable location |
|---|---|---|
| Candidate source identity | SGOS Candidate snapshot | Existing Candidate record and publication transaction |
| Program and allowed operation | GVM/SGOS program | Existing Program and operation registry records |
| Module test result and raw report identity | Code Delivery test receipt | Story delivery evidence |
| Static JUnit declaration identity | WEL JUnit adapter observation | `test-execution` receipt v3 |
| Clause-to-test proposal | WEL JUnit adapter observation | `test-execution` receipt v3, status `unreviewed` |
| Proposal plus current clause-byte binding | Story submission review snapshot | `story-submission-packet` v2 |
| Human semantic decision | Existing phase approval authority | Existing `phase-approval` decision |
| Governed publication | Existing exact-SHA Git transaction | Existing publication journal/commit |

The submission packet must be immutable before approval. It therefore stores the exact proposal
and the current clause, declaration, parser, and logical-test digests. The later phase approval
stores the human decision, reason, and optional expiry and references the already immutable
submission packet. This temporal ordering corrects the earlier wording of WEL REQ-013; putting a
future approval decision inside a pre-approval packet is impossible without mutating the packet.

WEL uses two storage planes:

1. The **Candidate plane** contains repository-controlled source, tests, configuration, and the raw
   result files produced by the configured command. These bytes are hostile input.
2. The **evidence plane** contains bounded normalized records, content digests, review decisions,
   and publication receipts. Evidence is admitted only after containment, link, bounds, parser,
   and identity checks.

No absolute path, temporary directory, Git credential, raw origin URL, prompt, clause body, or test
body is part of a durable WEL identity. The repository identity uses a one-way digest of the
normalized origin. If the origin is unavailable, exact identity is unavailable.

## Assurance ceiling

The JUnit pilot can establish an exact **static local identity** and can collect a human semantic
mapping decision. It still reports `inconclusive` and `testcaseExecutionProven: false` because it
does not yet have an authenticated independent runner, universal Candidate/Program/attempt join, or
trusted toolchain attestation. Existing module-level Code Delivery evidence remains authoritative;
WEL neither upgrades nor blocks it.

## Compatibility and migration

`test-execution` v2 records migrate in memory to v3 with `exact: false`, no catalog, and no mapping
proposals. Historical bytes are never rewritten and historical observations never gain authority.
Stories with WEL disabled, absent, or legacy enrollment retain their original behavior.

## Consequences

- One approval form can review the phase checklist and each exact WEL proposal without creating a
  second approval or quorum.
- A clause, source declaration, logical test, parser manifest, or proposal change makes the review
  join stale.
- Local parsing, missing JDK tooling, unsupported test shapes, or a missing origin degrade to an
  unavailable/inconclusive diagnostic and never block ordinary lifecycle work.
- `enforce` remains unavailable until CAB/SGOS trust and release gates are independently complete.

