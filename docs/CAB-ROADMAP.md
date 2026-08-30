# Code Assurance Bridge — corrected roadmap

**Status:** design-only; implementation not authorized

**Roadmap baseline:** `main@40d3f159`

**Created:** 2026-08-30

**Source proposal:** `SFlow_Code_Assurance_Bridge_SPEC.md` draft v0.1

This roadmap preserves the Code Assurance Bridge objective while correcting the draft's architecture,
security, rollout, and estimate risks. It supersedes the delivery sequence in section 24 of the draft
for planning purposes. It does not enable CAB, add an authority path, or change current Story behavior.

## Decision

CAB v0.1 MUST NOT be implemented literally. Work may begin only with a rebased v0.2 design and an
opt-in, non-blocking Java/JUnit pilot.

The intended assurance claim is:

> A trusted, pinned harness observed specified checks and supported testcase identities against one
> exact candidate, and the existing lifecycle authority evaluated the resulting evidence.

CAB MUST NOT claim that an AC is semantically correct merely because a tagged test ran, or that a
self-hashed record authenticates its issuer.

## Architectural invariants

1. **One Candidate identity.** CAB extends the existing SGOS Candidate Snapshot and retained Git
   binding. It MUST NOT create another candidate store, candidate hash domain, or publisher.
2. **One execution plan.** Verification obligations compile to a GVM Program or an exact projection
   bound to `programSha256`. CAB MUST NOT add a second scheduler.
3. **One registry authority.** Checkers use approved SGOS operation/verifier manifests and signed
   Capability Pack authority. A parallel ambient checker registry is forbidden.
4. **One approval authority.** Candidate and bundle references extend the existing phase approval
   decision. Task-local decisions use SGOS Human Request/Response. CAB approval records cannot form
   a competing quorum.
5. **One publication authority.** CAB evidence is an input to the existing lifecycle publication unit
   of work. No `assure submit` path may advance Story or Git authority independently.
6. **Two storage planes.** The immutable subject tree is separate from append-only evidence. Evidence
   written after freeze MUST NOT change the identity of the candidate it describes.
7. **Authentication, not only hashing.** Records that assert a checker, person, kernel, or remote
   decision require an authenticated signer and trust root outside the candidate branch.
8. **Hostile-code containment.** Every code-executing checker runs in a disposable hermetic sandbox;
   a post-run clean-tree comparison is evidence, not a security boundary.
9. **AST remains optional.** Exact-test adapters may use a reviewed parser, but CAB cannot depend on
   AST availability. Unsupported identity remains honest module evidence or `INCONCLUSIVE` according
   to the explicitly selected rollout mode.
10. **No silent upgrade.** In-flight Stories and legacy receipts retain `module-executed` assurance.

## Contract reuse map

| CAB proposal | Required implementation direction |
|---|---|
| Code Assurance Policy | Extend SGOS policy snapshot plus pinned Code Delivery, impact, and approval policy. |
| Verification Plan | Compile to GVM Program/Task Templates, or a deterministic projection bound to the Program. |
| Code Candidate | Reuse Candidate Snapshot; add a MIG-registered repository binding only if existing retained metadata is insufficient. |
| Checker Definition | Use approved operation/verifier manifests referenced by exact manifest hashes. |
| Checker Receipt | Add a typed immutable evidence family referenced by Action Evidence and Task Receipt. |
| Testcase/Coverage/Mutation receipt | Extend existing code-delivery result adapters and test-execution receipts. |
| Verification Finding | Add non-authoritative evidence; close risk through existing human authority. |
| Code Assurance Bundle | Add one deterministic aggregate over existing candidate, Program, policy, and evidence records. |
| Approval Attestation | Extend existing phase approval with review snapshot, candidate, bundle, and scope references. |
| Publication Envelope | Feed exact inputs into the existing Git publication unit of work. |
| Authority Receipt | Reuse the established self-binding transaction/trailer pattern or write a post-publication receipt to a separate authority plane. |

## Required design corrections before code

The CAB v0.2 design must resolve all of the following:

- a threat model covering candidate authors, malicious tests, compromised checkers, reviewers,
  remote providers, artifact stores, and administrators;
- a signer and trust matrix for checker receipts, human decisions, kernel receipts, and remote checks;
- key issuance, rotation, revocation, expiry, audience, nonce, policy epoch, and replay consumption;
- a two-plane candidate/evidence model without Git commit self-reference;
- an immutable review snapshot so multiple approval votes do not invalidate one another merely by
  advancing workflow state;
- a hermetic runner with read-only candidate input, separate result volume, empty home, non-root
  identity, no host/Git/Docker sockets, deny-by-default network, and CPU/memory/disk/PID/time limits;
- checker supply-chain provenance for runner, parser, toolchain, image, ruleset/database, effective
  configuration, dependency mirror, and suppressions;
- evidence classification, minimization, encryption, retention, residency, legal hold, and deletion;
- an office-compatible remote verification protocol that does not require repository-hosted workflow
  files;
- canonical serialization and identity projections, including treatment of timestamps and creator
  metadata;
- a risk-profile lattice aligned with existing Code Delivery, impact, and approval policies;
- explicit waiver contracts and a `VERIFIED_WITH_EXCEPTIONS` outcome;
- evidence freshness rules for target branch, vulnerability database, policy, identity membership,
  keys, certificates, and external contracts;
- honest terminology: `POLICY_CHECKS_PASSED` and `HARNESS_OBSERVED_TESTCASE`, not universal behavior,
  security, or AC correctness claims.

R4 MUST remain unavailable until remote enforcement and production/canary evidence are implemented.

## Rollout policy

Planned rollout modes are:

| Mode | Behavior |
|---|---|
| `disabled` | Current Code Delivery behavior only. This remains the default before an approved pilot. |
| `observe` | Produce CAB observations and comparisons, but never block publication or strengthen the authoritative assurance label. |
| `enforce` | Block only newly enrolled Stories whose approved repository policy names a supported adapter and profile. |

Rules:

- no in-flight Story is silently enrolled;
- unsupported languages/frameworks continue with honest module evidence in `disabled` or `observe`;
- an unavailable mandatory adapter blocks only an explicitly enrolled `enforce` profile;
- switching to `enforce` requires a governed configuration review and a proven rollback to the prior
  policy for future generations;
- CAB work is resumable/background work in UI surfaces; it cannot rely on one short synchronous VS
  Code command timeout.

## Delivery roadmap

### [ ] CAB-R0 — Rebase and security architecture

**Planning range:** 2–4 person-weeks
**Mutation:** documentation, ADRs, fixtures, and threat-model tests only

Deliver:

- CAB v0.2 rebased onto current SGOS Candidate, Program, evidence, approval, and publication models;
- authority-flow ADR naming the exact target ref and lifecycle transition;
- two-plane storage ADR;
- signed-attestation/trust ADR;
- checker sandbox and supply-chain ADR;
- risk-profile and waiver matrix;
- migration and rollout ADR.

Exit gates:

- every CAB record maps to one existing authority primitive or is justified as new evidence;
- no duplicate Candidate, scheduler, registry, approval, or publisher remains in the design;
- candidate/evidence circularity and authority-receipt self-reference are removed;
- the security threat model has adversarial test anchors;
- R4 and remote enforcement are explicitly unavailable.

### [ ] CAB-R1 — JUnit 5/Surefire shadow pilot

**Planning range:** 3–6 person-weeks
**Rollout:** `observe` only

Deliver:

- extend the existing JUnit result adapter rather than creating a second runner stack;
- support one Maven module and stable, non-dynamic, non-parameterized JUnit 5 test methods;
- require namespace-qualified AC tags inside the exact executable test declaration;
- bind source declaration hash, normalized path, class, method, framework/adapter version, checker
  attempt, suite outcome, result artifact, and candidate;
- use a unique empty result directory and attempt nonce;
- return `INCONCLUSIVE` for nested/dynamic/parameterized/retried/colliding identities outside the
  supported subset;
- expose comparisons against existing `module-executed` evidence without changing authority.

Explicitly excluded:

- coverage, mutation, model verification, approval changes, SGOS material-task rules, remote checks,
  production evidence, and non-JUnit adapters.

Exit gates:

- zero false testcase matches across the reviewed corpus;
- no testcase PASS survives suite failure, timeout, skipped status, teardown failure, nonzero exit,
  malformed report, collision, or result tampering;
- measured false-`INCONCLUSIVE`, wall-clock, CPU, and disk rates are accepted;
- interrupted runs cleanly resume or rerun without producing passing authority;
- representative office Java/Maven repositories pass on Windows, macOS, and Linux with approved
  proxy, CA, and offline-cache configurations.

### [ ] CAB-R2 — Hermetic runner and authenticated evidence

**Planning range:** 6–10 person-weeks

Deliver:

- disposable sandbox controller and separate parser boundary;
- signed checker registry and attestations using externally pinned trust roots;
- declared non-overlapping output roots and immutable artifact ingestion;
- evidence CAS/ref with quotas, encryption, retention, access audit, and safe opaque handles;
- freshness, revocation, replay, crash recovery, and concurrent-writer handling;
- toolchain doctor that reports unavailable sandbox, binaries, CA/proxy, caches, and signing authority
  before work begins.

Exit gates:

- malicious candidate tests cannot access host credentials, Git common directories, unrelated
  workspaces, Docker sockets, or undeclared network targets;
- parser/artifact attacks, symlink escape, output overflow, process escape, and cancellation are
  covered on every supported OS;
- receipts authenticate the exact runner, parser, toolchain, configuration, candidate, and attempt.

### [ ] CAB-R3 — Opt-in JUnit enforcement

**Planning range:** 4–8 person-weeks
**Rollout:** selected new R2 Stories only

Deliver:

- deterministic assurance aggregate over candidate, plan, checker attempt, suite, and testcase
  evidence;
- exact refusal/remediation packets;
- VS Code review/status views and terminal recovery commands;
- migration cutoff proving which generations may use compatibility evidence;
- policy-controlled enrollment and rollback for future generations.

Exit gates:

- `module-executed` evidence can never satisfy an enrolled testcase-exact obligation;
- unsupported or ambiguous identities never become PASS;
- ordinary non-enrolled Stories are unaffected;
- customer repositories meet agreed latency, disk, stability, and recovery budgets.

### [ ] CAB-R4 — Adequacy and independent findings

**Planning range:** 8–14 person-weeks

Deliver incrementally:

- changed-line/branch coverage with reviewed exclusion evidence;
- mutation testing for a bounded supported Java subset;
- typed findings and cross-candidate closure lineage;
- immutable review snapshot and independent approval policy;
- optional bounded model-assisted findings through the existing model boundary.

Exit gates:

- coverage and mutation cannot be gamed through candidate-owned configuration or result files;
- accepted risk is signed, scoped, expiring, separately authorized, and visible as
  `VERIFIED_WITH_EXCEPTIONS`;
- a model cannot satisfy a deterministic obligation, approve, waive, or publish;
- source-changing closure always creates a new Candidate cycle while retaining the original finding.

### [ ] CAB-R5 — Additional adapters, one ecosystem at a time

**Planning range:** 2–5 person-weeks per framework after the runner is stable

Order:

1. Jest;
2. Vitest;
3. pytest;
4. Go test;
5. Playwright;
6. .NET TRX;
7. other ecosystems only after a reviewed stable identity exists.

Each adapter requires its own framework-version matrix, collision corpus, parameter/retry/shard
semantics, OS coverage, malformed-result suite, and performance budget. Shipping one adapter does
not imply support for another.

### [ ] CAB-R6 — SGOS and Story lifecycle bridge

**Planning range:** 4–8 person-weeks
**Hard dependency:** `SGOS-P0-001 — Universal Candidate publication` completed

Deliver:

- typed assurance-bundle evidence reference from SGOS material task receipts;
- candidate/bundle references in the existing phase approval review snapshot;
- publication-time replay through the existing lifecycle publication unit of work;
- one authority receipt binding Program/task evidence, candidate, bundle, approval epoch, workflow
  revision, commit, and tree without self-reference;
- compatibility projection that cannot invent CAB or SGOS success.

Exit gates:

- all hashes agree at the single existing publication boundary;
- SGOS success still cannot advance Story authority directly;
- stale candidate, evidence, approval, workflow, base, or remote state is refused before mutation;
- exactly one concurrent publication wins and recovery never publishes a different candidate.

### [ ] CAB-R7 — Remote and regulated enforcement

**Planning range:** 8–16 person-weeks plus organizational lead time
**Status:** no-go until an office-supported verifier and branch-control policy exist

Deliver:

- provider-neutral signed pre-publication authorization for the exact prospective commit;
- trusted external verifier identity pinned by repository rules;
- merge-result/base revalidation, bypass auditing, key rotation, and revocation;
- separate post-publication receipt;
- production smoke/canary/rollback/reconciliation evidence before R4 is enabled.

Exit gates:

- an unverified commit cannot enter the protected authority branch through direct push, merge,
  administrator bypass, stale status, or a candidate-controlled workflow;
- remote checks bind the final merge commit and current target parent;
- R3/R4 profiles contain no optional wording for mandatory controls;
- production evidence is exact, recoverable, and linked to the published authority receipt.

## Risk register

| Risk | Level | Planned control |
|---|---:|---|
| Parallel Candidate or publisher | Critical | R0 reuse map and completion of SGOS-P0-001 before lifecycle integration. |
| Forged self-hashed authority | Critical | Signed attestations with external trust roots, expiry, revocation, and replay ledger. |
| Host compromise by candidate tests | Critical | Hermetic disposable runner before any enforcing mode. |
| False exact-test or AC claim | Critical | Narrow harness-observation vocabulary, trusted attempt channel, supported-subset refusal. |
| Candidate/evidence self-reference | Critical | Separate subject-tree and evidence planes. |
| Evidence privacy/retention failure | High | Classification, encrypted CAS, opaque handles, RBAC, audit, retention and deletion policy. |
| Unsupported tools block work | High | `observe` pilot, preflight doctor, explicit enrollment, no silent upgrade. |
| Verification latency/disk growth | High | One reusable candidate workspace, budgets, background execution, measurement before enforcement. |
| Reviewer/identity policy cannot complete | High | Capacity preflight and immutable review epoch before R3/R4 enrollment. |
| Office remote controls unavailable | High | Provider-neutral external service; R7 remains disabled. |
| Scope and estimate expansion | High | One adapter per milestone and evidence-backed exit gates. |

## Planning estimate

The draft's 7–12 week total is suitable only for a narrow pilot. The production-grade multi-language
bridge is provisionally **30–50 person-weeks**, plus organizational lead time for signing, artifact
storage, branch controls, and production environments. Estimates must be replaced with measured
throughput after CAB-R1 and CAB-R2.

## Change control

- This roadmap does not authorize implementation.
- Change an item to `[~]` only after explicit implementation approval and creation of a governed
  Story or branch for that item.
- Mark an item `[x]` only after its exit gates, adversarial tests, migrations, documentation,
  packaging, supported-platform matrix, and release receipt land on `main`.
- New scope receives a new stable CAB roadmap ID; it must not be hidden inside an existing item.
- Update `docs/SGOS-PENDING-WORK.md` whenever CAB-R6 or another CAB item changes an SGOS dependency.
