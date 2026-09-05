# Code Assurance Bridge v0.2 — authority-safe design

**Status:** reviewed code-local design candidate; enforcement and remote authorization unavailable

**Rebased on:** SGOS Candidate and GVM Program authority, the existing Code Delivery receipt,
phase approval, and lifecycle publication unit of work

**Machine-readable contract:**
[`contracts/cab/architecture-v0.2.json`](contracts/cab/architecture-v0.2.json)

## Purpose and claim

CAB joins one exact code Candidate to an approved verification Program, authenticated checker
attempts, an immutable review snapshot, and the existing lifecycle publication. CAB does not prove
that software is universally correct. Its strongest planned claim is:

> An approved independent harness observed the declared checks against one exact Candidate, the
> existing approval authority evaluated that exact evidence, and the existing lifecycle publisher
> published the unchanged Candidate.

Before an authenticated independent runner exists, CAB may expose only `disabled` and `observe`.
Local observations remain non-authoritative and cannot strengthen Code Delivery assurance.

## Authority flow

```text
approved Story inputs + pinned policy
             |
             v
       GVM Program (existing scheduler authority)
             |
             v
  SGOS Candidate Snapshot (immutable subject plane)
             |
             +----------> approved operation/verifier manifests
             |                         |
             v                         v
        checker attempt ------> append-only evidence plane
                                      |
                                      v
                           deterministic assurance bundle
                                      |
                                      v
                         existing phase approval snapshot
                                      |
                                      v
                    existing lifecycle publication unit of work
                                      |
                                      v
                              exact Git CAS result
```

CAB cannot create or move any authority in this graph. It contributes typed evidence and a pure
aggregate only. The authoritative mapping is frozen in the machine-readable architecture contract.

## Existing primitives and sole owners

| Fact | Existing owner | CAB use |
|---|---|---|
| Candidate bytes | SGOS `CandidateSnapshot` and retained Candidate lifecycle | exact proof subject |
| Verification plan | GVM `Program` | immutable ordered checks and resource ceilings |
| Operation/verifier identity | approved SGOS Capability Pack | checker admission |
| Attempt and task outcome | SGOS Task Attempt and Task Receipt | execution lineage |
| Module test result | Code Delivery `test-execution` receipt | compatibility and raw-result binding |
| Clause/test mapping decision | existing phase approval | human semantic judgment |
| Publication | lifecycle publication unit of work | only Git authority transition |

There is no CAB Candidate store, scheduler, operation registry, approval quorum, or publisher.

## Two storage planes

The **Candidate plane** is immutable and content-addressed. It contains the exact Git tree and every
declared input that can affect verification: source, tests, dependency manifests, build
configuration, generated-source inputs, and pinned policy. Evidence created later never changes
the Candidate identity.

The **evidence plane** is append-only. It contains bounded checker attempts, result-artifact
digests, findings, bundles, and review references. It may refer to a Candidate but the Candidate
must never refer to a future evidence record. This removes candidate/evidence circularity.

Raw logs and reports remain separately bounded artifacts. Durable identities contain their digest,
not their unrestricted contents or machine-local path.

## Canonical identity projections

All semantic records use canonical JSON, closed vocabularies, explicit schema versions, SHA-256,
and one self-hash field excluded from its own projection. Operational clocks, local paths, process
IDs, raw remotes, credentials, prompts, and model prose never enter semantic identity.

The checker-attempt identity must bind:

- Candidate and Program;
- SGOS task attempt;
- operation and verifier manifests;
- toolchain and effective configuration;
- raw result artifact;
- one unpredictable attempt nonce.

The bundle binds the Candidate, Program, policy, sorted checker-attempt IDs, sorted finding IDs,
and closed outcome. The approval snapshot binds that bundle, workflow revision, authority epoch,
and exact decision scope. The publication receipt binds the Candidate, bundle, approval snapshot,
lifecycle event, and resulting Git commit/tree without referring backwards from an earlier record.

## Authentication and trust

A SHA-256 self-hash proves integrity, not issuer identity. The trust classes are deliberately
separate:

| Claim | Issuer | Required authentication | Can enforce? | Can publish? |
|---|---|---|---:|---:|
| Local observation | developer machine | none | no | no |
| Checker attestation | approved independent runner | externally pinned trust root | yes, after R2 | no |
| Human decision | existing authority group | runtime-observed Git identity and pinned membership | yes | no |
| Publication | existing lifecycle kernel | exact Git compare-and-swap | no | yes |

Authenticated runner evidence requires a signed envelope binding issuer, audience, nonce, policy
epoch, issued/expiry times, Candidate, Program, attempt, toolchain, configuration, and result. The
trust root must be approved outside the Candidate branch. Verification must recheck expiry,
revocation, audience, nonce consumption, and policy epoch at use time. A developer-local signer is
useful test evidence but is not an independent runner.

## Hermetic checker boundary

No CAB `enforce` profile can exist until the checker environment proves all of these controls:

- immutable read-only Candidate input and a different bounded result volume;
- empty private home and non-root execution identity;
- no host, Git, credential-agent, container, or orchestration sockets;
- deny-by-default network with exact approved dependency endpoints only when required;
- CPU, memory, disk, PID, wall-clock, output, and artifact-count ceilings;
- process-tree cancellation and verified quiescence on success, failure, timeout, and user stop;
- pinned runner, parser, toolchain, rules, dependency mirror, configuration, and suppressions;
- result ingestion that refuses links, traversal, collisions, partial output, mutation, and overflow.

A clean worktree after execution is supporting evidence, not containment.

## Outcomes and aggregation

The closed evidence outcomes are `pass`, `fail`, `unavailable`, `inconclusive`, `not-run`, `stale`,
and `tampered`. A human exception may yield `verified-with-exceptions` only when it is separately
authorized, scoped, reasoned, expiring, and bound to the same Candidate and bundle.

Mandatory predicates are conjunctive. Optional scores cannot hide a required failure or an
unproven result. `unavailable`, `inconclusive`, `not-run`, `stale`, and `tampered` never normalize to
`pass`.

Models may explain evidence or propose findings. A model cannot execute a deterministic checker,
authenticate evidence, decide a waiver, approve, or publish.

## Risk profiles and waivers

The planned monotone profiles are:

| Profile | Minimum evidence | Availability |
|---|---|---|
| `standard` | existing Code Delivery module evidence | current behavior, outside CAB enforcement |
| `exact-test-observe` | local exact-static identity plus module evidence | observe only |
| `exact-test-enforce` | authenticated exact attempt plus existing approval | unavailable until CAB-R2/R3 |
| `high-assurance` | exact test, coverage/security predicates, independent review | unavailable |
| `regulated` | high-assurance plus approved remote authorization and retention | unavailable |

Child capability policy may tighten but never weaken its parent. A waiver is not a lower profile:
it is an explicit existing-authority decision over one exact failed/unavailable predicate, with a
reason, expiry, scope, and review visibility. It never turns the underlying predicate into `pass`.

## Migration and rollout

- `disabled` remains the default.
- `observe` may be enabled for a newly created Story without changing authoritative assurance.
- `enforce` is absent from the available mode list until the authenticated runner and release gates
  pass.
- Legacy and in-flight Stories never auto-enroll.
- Existing `module-executed` receipts remain exactly that after migration.
- New runtime record families, if later approved, must enter the migration registry before a writer
  can persist them.
- Rollback changes policy for future generations; it cannot erase prior evidence or rewrite a
  Candidate, bundle, approval, or publication receipt.

## Recovery

Every mutating transition remains plan-first, confirmation-bound, subject-locked, and exact-CAS.
An interrupted checker can only resume or retry from its recorded Candidate, Program, attempt, and
nonce policy. A changed Candidate creates a new cycle. Push failure retains the exact governed
commit and publication receipt; recovery may publish only that commit.

Stale approval, policy, membership, toolchain, configuration, result, target branch, or remote state
is a refusal with a bounded remediation plan. Recovery never discards candidate bytes, invents
success, or silently downgrades a required profile.

## Remote and regulated boundary

Local CAB evidence cannot prevent a contributor, administrator, or webhook from moving a remote
branch outside SFlow. Remote enforcement therefore remains a separate no-go milestone. It requires
a provider-neutral service that authenticates the exact prospective merge commit and current base,
is required by repository rules, detects bypass, rotates and revokes trust, and records a separate
post-publication receipt. Repository-hosted workflow files alone are not sufficient authority.

## Privacy and retention

Evidence stores only the minimum typed result needed for replay. Raw source bodies, test bodies,
prompts, credentials, absolute paths, raw remote URLs, employee productivity measures, and
unbounded logs are prohibited from CAB record identities and telemetry. Artifact handles must be
opaque and subject to explicit classification, encryption, access audit, residency, retention,
legal hold, and deletion policy. Deleting retained evidence cannot convert an old result to `pass`;
it becomes unavailable for future revalidation.

## Acceptance boundary

This document completes a code-local v0.2 design candidate. CAB-R0 remains active until independent
security, privacy, platform, and ownership reviewers approve the design and its adversarial anchors.
It does not activate a runner, create runtime record writers, change lifecycle gates, or make
`enforce` available.
