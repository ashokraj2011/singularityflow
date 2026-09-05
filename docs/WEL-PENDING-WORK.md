# Witnessed Engineering Loop pending work

**Status:** P0 observe-only implementation active; P1/P2 remain parked or unavailable

**Observe-only baseline:** `main@7f0581d5`

**Created:** 2026-08-30

**Current reconciliation:** checked against `main@6fbcf3bf` on 2026-09-05. Commits `259b76f1`,
`58d9329d`, and `d55229c7` provide the bounded exact-static JUnit identity adapter, immutable
proposal snapshot, human review through the existing phase approval, migration, safe command-shape
fallbacks, and content-free benchmark v2. Commit `98750174` aligns the CAB architecture and threat
boundary. The current release increment also makes the isolated npm and VSIX engine smokes load the
WEL adapter and require its packaged Java parser helper. These increments do not satisfy the
authenticated-independent-runner, Candidate/Program/attempt, cross-platform, enforcement, or
release-evidence gates below.

This document is the durable delivery tracker for Witnessed Engineering Loop work that was
deliberately left out of the observe-only baseline. The governing design remains
[WEL v0.2](WEL-SPEC.md). Cross-cutting execution and assurance prerequisites remain owned by the
[SGOS pending-work backlog](SGOS-PENDING-WORK.md) and the
[Code Assurance Bridge roadmap](CAB-ROADMAP.md).

Nothing in this backlog enables enforcement. The shipped baseline continues to classify local
testcase observations as non-authoritative and `inconclusive` until the trust and lifecycle exit
gates below are proven.

## Status rules

- `[ ]` means parked or unavailable. No implementation branch or rollout may be inferred.
- `[~]` means active work has a named Story or branch, but every acceptance gate is not yet proven.
- `[x]` means implementation, migrations, adversarial tests, documentation, npm/VSIX packaging, and
  release evidence have landed on `main`.
- A prototype, self-hashed receipt, local happy path, or model-generated mapping is not completion.
- Moving an item to `[~]` must record its owner, Story or branch, target release, and dependency
  status. Moving it to `[x]` must record its landing commit and exact verification evidence.
- Acceptance gates may be clarified, but they must not be silently weakened. New scope receives a
  new stable WEL backlog ID.

## Shipped observe-only baseline

### [x] WEL-B0-001 — Structural clauses, bounded knowledge, and diagnostic observations

Landing commit: `7f0581d5`

Delivered:

- strict `witnessed-v1` structural parsing for `Behavior`, `Observable`, and `Witness` fields;
- creation-pinned WEL enrollment with disabled-by-default compatibility for legacy Stories;
- bounded, replay-verified JUnit/Surefire local observations that cannot claim exact assurance;
- reviewed knowledge-seed import and bounded provenance projection into Evidence Packets and
  Context X-Ray;
- schema migrations that preserve historical hashes and do not invent authority;
- CLI and VS Code review projections that label the evidence honestly.

Verification at landing:

- full CLI and VS Code regression suite: 3,430 passed, 0 failed;
- static and conformance checks: 1,035 passed;
- VS Code TypeScript check, no-model boundary tests, package dry run, and diff validation passed.

Deliberate boundary: this baseline does not provide a reviewed semantic clause-to-test mapping,
exact testcase identity, a hermetic runner, authenticated verifier evidence, or lifecycle
enforcement.

## Dependency dashboard

| WEL item | State | External owner or prerequisite | Enforcement impact |
|---|---|---|---|
| `WEL-P0-001` architecture and threat closure | active, code-local boundary documented | CAB-R0 ratification and platform/privacy review | none |
| `WEL-P0-002` exact local JUnit pilot | active, exact-static observation and human review implemented | Candidate/Program/attempt join, corpus and platform proof | observe only |
| `WEL-P0-003` measurement and release proof | active, content-free harness and isolated npm/VSIX engine proof implemented | Flow Impact study and signed package/platform aggregate | none |
| `WEL-P1-001` hermetic authenticated execution | unavailable; developer-local signing is not independent authority | CAB-R2 | required |
| `WEL-P1-002` universal Candidate lifecycle bridge | Candidate code path delivered; WEL integration parked | SGOS-P0-001 release evidence and CAB-R6 | required |
| `WEL-P1-003` opt-in enforcement and recovery | unavailable | all WEL P0/P1 predecessors | enables selected new Stories only |
| `WEL-P2-001` additional adapters | parked | separate reviewed identity contract per adapter | none by default |
| `WEL-P2-002` additional witness evidence | parked | CAB-R4 or a separately approved trust contract | none by default |

## P0 — finish the observe-only pilot

### [~] WEL-P0-001 — Architecture, schema, privacy, and threat-model closure

Owner: repository maintainers. Branch: `main`. Started: 2026-09-05. Target: next observe-only
release. Dependencies: the CAB-R0 code-local design is present; independent ratification remains
open and enforcement is unavailable.

Implemented in the current increment:

- [ADR 0008](adr/0008-wel-authority-and-storage.md) assigns each Candidate, Program, observation,
  proposal, review, and publication fact to one existing authority and defines the two storage
  planes;
- [ADR 0009](adr/0009-wel-junit5-local-identity.md) pins the initial Java/JUnit identity subset,
  bounds, reconciliation, and fail-safe fallback;
- the [WEL threat and privacy model](WEL-THREAT-MODEL.md) covers the code-local attack and data
  surfaces and states the platform/release boundary;
- `test-execution` v3 migration preserves old bytes and gives earlier records empty, inexact WEL
  fields rather than invented assurance.
- [CAB v0.2](CAB-V0.2.md), its trust/sandbox/rollout ADRs, closed architecture contract, and
  adversarial design tests now align WEL with the current SGOS owners without activating CAB.

Implementation checkpoints: `259b76f1` (exact-static pilot) and `98750174` (CAB v0.2 authority
architecture and adversarial contract).

Still required before completion: independent CAB/SGOS design ratification, approved privacy and
trust review, and the Windows/macOS/Linux release fixtures named below. The repository now supplies
the exact review candidate but cannot self-approve these external decisions.

Close the design work that must precede any exact or authenticated testcase claim.

Acceptance gates:

- authority-flow and two-plane storage ADRs identify one owner for every durable fact;
- the threat model covers malicious candidate code, tests, parsers, toolchains, reviewers, remote
  providers, replay, link substitution, report collisions, and evidence retention;
- the signer/trust matrix and canonical hash projections agree with CAB and SGOS;
- schema migration fixtures prove old records remain readable without gaining assurance;
- knowledge, prompt, test-output, identity, path, and telemetry privacy reviews are approved;
- Windows, macOS, and Linux fixtures cover path, encoding, cancellation, timeout, and office proxy
  constraints;
- enforcement remains unavailable.

Depends on: CAB-R0 design alignment. It does not depend on a model or AST availability.

### [~] WEL-P0-002 — Reviewed exact JUnit 5/Surefire local observation pilot

Owner: repository maintainers. Branch: `main`. Started: 2026-09-05. Target: next observe-only
release. Dependencies: CAB-R1 contract alignment is partial; AST remains optional.

Implemented in the current increment:

- a packaged JDK compiler-tree parser reads only Git-tracked Java test source, never loads
  Candidate classes, and emits a bounded exact declaration catalog;
- exact literal JUnit Jupiter tags join one supported source method to one qualified Surefire
  occurrence; parameterized, dynamic, inherited, overloaded, generated, and ambiguous identities
  remain inexact;
- source declarations, catalog, logical identities, proposal digests, and raw report projections
  are replay-verified;
- the Story submission packet binds an unreviewed proposal to current clause bytes;
- the existing CLI and VS Code phase approval require one explicit human decision per proposal,
  with reasons and future expiry for exceptions; no second approval authority is created;
- a reviewed 12-case local corpus proves exact identity for the supported literal forms and zero
  false exact matches across decoy, dynamic, parameterized, repeated, nested, wildcard,
  non-literal, duplicate-report, and class-mismatch cases;
- explicit Maven testcase/group/include/exclude/engine focus, Surefire rerun properties, and
  non-Surefire JUnit producers now fail safely to an inexact observation without suppressing the
  ordinary module test receipt;
- missing Java/JDK/parser support is non-blocking and existing module Code Delivery evidence keeps
  its existing authority.

Implementation checkpoints: `259b76f1` (pilot) and `58d9329d` (focused/filter/retry and
non-Surefire fail-safe classification).

Still required before completion: universal Candidate/Program/attempt binding, reviewed adversarial
real-repository corpus measurements, durable attempt-lineage retry semantics, cross-platform
packaging receipts, and the authenticated execution contract. Until then every exact-static outcome
is still `inconclusive`.

Replace the current name-only diagnostic projection with a reviewed, still non-blocking exact local
identity experiment for one Maven module.

Acceptance gates:

- a pinned production parser builds a static catalog for the explicitly supported JUnit identity
  subset;
- source identity, normalized Surefire occurrences, retries, skipped/aborted outcomes, suite errors,
  and duplicate display names reconcile deterministically;
- human review approves the exact clause-to-test mapping; a model may propose but cannot approve it;
- Candidate, Program, attempt, adapter, toolchain, configuration, and raw-report identities are
  present or the result is `inconclusive`;
- malformed XML, DTD/entity content, partial suites, missing occurrences, ambiguous identities,
  report mutation, and worktree drift can never produce a pass;
- the reviewed corpus demonstrates zero false testcase matches;
- existing module-level Code Delivery evidence remains authoritative and publication remains
  non-blocking.

Depends on: `WEL-P0-001` and alignment with CAB-R1. AST remains optional.

### [~] WEL-P0-003 — Measurement, performance, and observe-only release proof

Owner: repository maintainers. Branch: `main`. Started: 2026-09-05. Target: next observe-only
release. Dependencies: the local P0-002 slice is present; Flow Impact and signed release aggregation
remain open.

Implemented in the current increment:

- `npm run benchmark:wel` exercises the packaged parser and receipt projection with bounded sample
  counts and reports platform, parser latency, catalog bytes, and receipt bytes;
- benchmark output explicitly excludes repository paths, origin URLs, Work IDs, Git identities,
  clause text, and test bodies;
- benchmark v2 separately measures static catalog time, raw-report ingestion, receipt projection,
  process CPU, raw/catalog/receipt bytes, and estimated durable bytes per execution;
- the bounded synthetic fixture reports exact/inexact/false-exact counters without recording a
  developer identity, repository, prompt, source body, or individual productivity;
- the benchmark degrades to `unavailable` rather than treating a missing JDK as product failure;
- the release gate installs the exact npm tarball into an isolated prefix and extracts the exact
  VSIX engine under a loader that refuses source-tree module access; both artifacts must contain the
  Java parser helper, import the WEL adapter, and return the admitted Maven/Surefire command shape;
- `npm run test:platform:cmp-wel` provides one explicit, bounded matrix command for the reviewed WEL
  identity and fail-safe fallback corpus, deterministic CMP corpus, and no-model CMP command; the
  same suites are mandatory in the release gate rather than relying on the broad test suite to find
  them indirectly.

Implementation checkpoints: `d55229c7` (content-free benchmark v2) and `6fbcf3bf` (isolated npm and
VSIX engine proof).

Still required before completion: reviewed real-repository corpus metrics, Context X-Ray and Story
latency measurements, an approved Flow Impact design, office/offline/recovery exercises, execution
of the isolated artifact proof on Windows and Linux, and one signed release receipt binding npm,
VSIX, schemas, source, and the full supported-platform matrix.

Measure whether WEL improves traceability without creating unacceptable latency, noise, or false
confidence.

Acceptance gates:

- reproducible baselines cover parser time, report ingestion, Evidence Packet size, Context X-Ray
  size, storage growth, and Story start/publication latency;
- false-match, false-inconclusive, unsupported, and recovery rates are measured on a reviewed corpus;
- Flow Impact uses an existing approved study design and never records individual productivity;
- comparisons distinguish exact provider facts, estimates, unavailable values, and quality
  guardrails;
- CLI, VS Code, npm package, and VSIX expose the same labels and recovery guidance;
- office, offline, cancellation, push-failure, interrupted-write, and fresh-clone exercises pass;
- a release receipt binds source, packages, schemas, tests, platform results, and the observe-only
  assurance ceiling.

Depends on: `WEL-P0-001` and `WEL-P0-002`.

## P1 — trust and enforcement prerequisites

### [ ] WEL-P1-001 — Hermetic runner and authenticated verifier evidence

Consume CAB's reviewed execution boundary rather than creating a WEL runner.

Acceptance gates:

- candidate input is read-only and separated from result storage;
- the runner has an empty private home, non-root identity, no host/Git/container sockets,
  deny-by-default network, and explicit CPU, memory, disk, PID, and time ceilings;
- parser, runner, image, toolchain, dependency mirror, configuration, rules, and suppressions have
  authenticated supply-chain provenance;
- signer issuance, audience, expiry, nonce, rotation, revocation, and replay consumption are proven;
- timeout, cancellation, compromise, partial upload, stale authority, and post-effect failure remain
  recoverable without fabricating a pass.

Depends on: CAB-R2. WEL must not implement a parallel sandbox or trust store.

### [ ] WEL-P1-002 — Universal Candidate publication and Story lifecycle bridge

Bind exact observations to the same Candidate and publication authority used by every governed
Story.

Acceptance gates:

- SGOS-P0-001 routes lifecycle publication through one universal Candidate boundary;
- CAB-R6 supplies typed assurance evidence from SGOS material-task receipts;
- the reviewed mapping, Candidate, Program, policy, verifier evidence, approval snapshot, and
  publication transaction join without a second scheduler or publisher;
- stale approvals, changed candidate bytes, ref races, push failures, and recovery retries remain
  bound to the exact recorded subject;
- compatibility projections cannot invent CAB, SGOS, or WEL success for legacy Stories.

Depends on: `SGOS-P0-001`, CAB-R6, and `WEL-P1-001`.

### [ ] WEL-P1-003 — Opt-in enforcement, recovery journey, and controlled rollout

Expose enforcement only for explicitly enrolled newly created Stories after all trust prerequisites
are complete.

Acceptance gates:

- repository readiness proves the selected adapter, sandbox, signer, trust root, policy, and recovery
  path before enrollment;
- no legacy or in-flight Story is silently enrolled or reclassified;
- unavailable, unsupported, ambiguous, stale, incomplete, or unauthenticated evidence never becomes
  pass;
- VS Code provides reviewed mapping, evidence inspection, refusal explanation, retry, rollback, and
  disable-for-future-Stories journeys without bypassing CLI authority;
- enrollment and withdrawal are governed configuration changes with an exercised rollback;
- office-compatible remote verification, production/canary evidence, and an independent security
  review are approved;
- enforcement failure never prevents ordinary non-enrolled file-based work.

Depends on: every WEL P0 item, `WEL-P1-001`, `WEL-P1-002`, and the relevant CAB remote-enforcement
exit gates.

## P2 — separately reviewed expansion

### [ ] WEL-P2-001 — Additional framework adapters

Add one framework at a time, each with its own exact identity, parser, reconciliation, trust,
freshness, migration, recovery, performance, and platform contract.

Candidate increments:

- static Jest/Vitest;
- additional JUnit identities such as parameterized and dynamic tests;
- other language/framework adapters selected from real demand.

Completion of the JUnit pilot does not authorize any of these adapters.

### [ ] WEL-P2-002 — Additional witness and adequacy evidence

Add non-test witnesses only through separately reviewed evidence contracts.

Candidate increments:

- inspection evidence;
- runtime or metric observations;
- signed remote office verification;
- mutation or independent adequacy findings through CAB.

No additional witness type may claim semantic correctness or lifecycle authority merely because it
is present.

## Recommended pickup order

When this roadmap is resumed:

1. finish CAB/SGOS ratification and platform/privacy review for `WEL-P0-001`;
2. finish the Candidate/Program/attempt join and reviewed corpus for `WEL-P0-002`;
3. collect the remaining `WEL-P0-003` Flow Impact and signed release evidence;
4. wait for CAB-R2 and SGOS-P0-001/CAB-R6 before starting the P1 enforcement path;
5. add P2 adapters only after the first ecosystem has stable production evidence.

## Maintenance

- Review this file whenever `WEL-SPEC.md`, `CAB-ROADMAP.md`, or `SGOS-PENDING-WORK.md` changes.
- Update the dependency dashboard and the affected detailed item in the same commit.
- Keep observe-only behavior, enforcement availability, and assurance labels independently visible.
- Record completed work with exact commits and verification receipts; do not replace history with a
  summary that cannot be audited.
- Keep this document linked from the repository documentation index and covered by package and
  release validation so stale links or missing content are detected.
