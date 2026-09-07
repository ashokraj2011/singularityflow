# Witnessed Engineering Loop pending work

**Status:** P0/P2 observe-only implementation active; P1 remains parked or unavailable

**Observe-only baseline:** `main@7f0581d5`

**Created:** 2026-08-30

**Current reconciliation:** checked through `main@ec1b5c88` on 2026-09-07. Commits `259b76f1`,
`58d9329d`, and `d55229c7` provide the bounded exact-static JUnit identity adapter, immutable
proposal snapshot, human review through the existing phase approval, migration, safe command-shape
fallbacks, the evolving content-free benchmark, and same-process unenrolled delta measurement. Commit
`98750174` aligns the CAB architecture and threat
boundary. The current release increment also makes the isolated npm and VSIX engine smokes load the
WEL adapter and require its packaged Java parser helper. These increments do not satisfy the
authenticated-independent-runner, Candidate/Program/attempt, cross-platform, enforcement, or
release-evidence gates below. Commit `b138ce06` adds the first separately bounded P2 adapter
increment for top-level literal Jest and Vitest tests; commit `676c591e` adds a durable 14-case
synthetic adversarial corpus that proves those closed profiles produce no false exact match for the
enumerated source and report shapes. Those observations inherit the same local, inconclusive
authority ceiling. Commit `d3bebeb0` closes the code-local Node 20 compatibility defects exposed by
the strict aggregate. Commits `ecefa2aa` through `dbff2b86` add the JDK preflight, clean Linux
portable-matrix evidence, real minimum/current VS Code host evidence, enterprise-Git ledger
compatibility, and runner-bound DX baselines. Commit `e2e90e59` normalizes Node 20's synthetic
name-pattern exclusions without permitting a real skip, todo, or cancellation. None changes the
observe-only authority ceiling. Commit `c664d4d8` removes two local release-validation bottlenecks:
the packaged JUnit helper is compiled once in process-private temporary storage and reused without
ever compiling Candidate source, while Auto integration fixtures clone one immutable initialized
seed into independent object databases instead of regenerating the complete configuration for each
scenario. Commit `d677577a` makes every self-closing VS Code panel idempotent before host-disposal
callbacks can re-enter it, restores Comprehension Center navigation through the shared router, and
reconciles the GDP companion lock after the WEL/SGOS/CMP documentation increments. Neither
optimization nor UI repair changes evidence authority or a lifecycle gate. Commit `03825387`
removes an exact-authority publication deadlock by hashing bounded state bytes through a private
temporary file instead of a child-process stdin pipe, and makes an interrupted aggregate terminate
its detached descendant process group before returning an exact retry command. These liveness
repairs change neither evidence identity nor authority.

The shared package boundary was re-exercised at `main@da6338ab`: both the isolated npm package and
the exact VSIX-contained engine still import the WEL adapter and packaged Java helper while running
the new read-only CMP preview, and the portable CMP/WEL matrix passes 65/65 after adding the
privacy-safe real-repository measurement boundary. This is compatibility
evidence only. It closes no WEL item because the remaining gates require independent ratification,
authenticated execution, reviewed real repositories, physical office/platform runs, or signed
release receipts.

The code-local WEL boundary and signed-evidence contract were revalidated on both supported Node
runtimes on macOS arm64. A clean strict Node 22 aggregate at `main@60e37936` completed all 457
selected files under run
`ef2adfc807f1380ad2a1c85f`: 4,645 tests passed with zero failures, cancellations, skips, or todo.
Its machine-local receipt binds commit `60e379365bfd2674d7f43b307f54ea396f91b67f`, tree
`d9471c4545524bec57f641b7f5e68d15cf699317`, source digest, runtime identity, and all eight shard
receipt digests. A second clean strict aggregate at `main@d3bebeb0`, run
`b3e0136ed4c8a03598192402`, completed all 458 selected files under Node 20.20.2: 4,648 tests passed
with the same zero-outcome counters. Its receipt binds commit
`d3bebeb0f4919dc9bfd262d524af97c682a1f91d`, tree
`f90b332e5dd5362e34825505f6d96caf46108cb5`, source digest, macOS arm64 runtime identity, and all
eight shard receipt digests. The benchmark's exact content-free report is retained privately during
the release gate, validated against the invoking host/runtime, and embedded with its canonical
digest in each signed release-matrix cell. These unsigned local receipts fill no signed
release-matrix cell. No WEL item is marked complete by either run. Independent ratification,
authenticated execution, reviewed real-corpus evidence, office-network/cross-platform receipts,
and signed package proof remain external acceptance gates and are not fabricated by
repository-local tests.

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
| `WEL-P2-001` additional adapters | active; bounded Jest/Vitest observe adapters landed | independent contract review, real corpus, platform proof; other adapters remain parked | none by default |
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

An ordinary Story does not currently create an SGOS Program or task attempt. Its local
test-execution receipt must therefore keep `candidate`, `program`, and `attempt` null and disclose
the corresponding binding gaps. Adding plausible-looking identifiers at publication time would
fabricate authority and is expressly out of scope. The join becomes implementable only when the
Story is executed through the reviewed universal Candidate lifecycle named by `WEL-P1-002`.

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
- benchmark v3 separately measures static catalog time, raw-report ingestion, receipt projection,
  process CPU, raw/catalog/receipt bytes, and estimated durable bytes per execution;
- the same-process unenrolled receipt baseline is measured beside the witnessed receipt, exposing
  incremental projection latency, receipt bytes, and estimated durable bytes without presenting
  noisy signed timing deltas as an enforced budget;
- the bounded synthetic fixture reports exact/inexact/false-exact counters without recording a
  developer identity, repository, prompt, source body, or individual productivity;
- the benchmark degrades to `unavailable` rather than treating a missing JDK as product failure;
- benchmark v3 measures the real read-only Context X-Ray projection and its serialized byte size
  from content-free machine-local telemetry; the measured projection performs no model or network
  request and does not expose its fixture Work ID or repository path;
- benchmark v3 also measures the real governed Story-start transaction against a disposable local
  configuration authority. It includes the local publication commits, disables application push,
  model grounding, and AST warming, defaults to three bounded samples, and emits only timing and
  resulting workflow-byte counts. `--story-samples=1..30` permits a larger reviewed local run;
- benchmark v4 induces one post-preflight local push rejection, retains the exact governed Story
  commit, recovers it through the public `sync` path, and proves the remote ref equals that retained
  SHA. It records only failure/recovery duration, stable failure class, and the equality result, and
  labels the exercise synthetic local evidence rather than office-network proof;
- benchmark v5 adds a synthetic post-preflight authority outage, exact public `sync` recovery, and
  a clean fresh-clone equality check; it also hard-exits a publication after its state write and
  proves public recovery restores the exact pre-transaction commit and bytes;
- the exact-static parser now uses the bounded asynchronous process-tree runner. Cancellation
  yields `JUNIT_SOURCE_PARSER_CANCELLED`, no catalog, and no mapping proposal; a caller-owned abort
  reason is never retained. The benchmark records only safe-cancellation latency and closed outcome
  facts;
- repeated observations in one process compile the packaged Java helper once into private temporary
  storage, reuse only those helper class files, and remove them on ordinary process exit. Candidate
  source remains staged separately and parsed as data; it is never compiled, loaded, or retained in
  the helper cache. A toolchain without a separately resolvable `javac` retains the prior bounded
  source-file fallback;
- the release gate installs the exact npm tarball into an isolated prefix and extracts the exact
  VSIX engine under a loader that refuses source-tree module access; both artifacts must contain the
  Java parser helper, import the WEL adapter, and return the admitted Maven/Surefire command shape;
- `npm run test:platform:cmp-wel` preflights a full JDK with the `jdk.compiler` module before it
  provides one explicit, bounded matrix command for the reviewed WEL
  identity and fail-safe fallback corpus, deterministic CMP corpus, and no-model CMP command; the
  same suites are mandatory in the release gate rather than relying on the broad test suite to find
  them indirectly;
- the full 12-sample `npm run benchmark:wel` measurement is a mandatory release-gate stage. The
  benchmark writes its exact report only to a private runner-owned temporary location; receipt schema
  v5 validates and embeds the content-free report plus its canonical digest, and aggregate schema v6
  retains that independently signed report in every platform/Node matrix cell. A missing, unavailable,
  incomplete, host-mismatched, content-bearing, false-exact, or digest-mismatched report refuses the
  receipt rather than relying on an optional developer run or a pass-only stage label.

Implementation checkpoints: `d55229c7` (content-free benchmark v2), `6fbcf3bf` (isolated npm and
VSIX engine proof), `d960e928` (portable deterministic corpus command), `396ccb73` (mandatory
release-gate benchmark), `e3330e80` (same-process incremental observation cost), and `723099fc`
(content-free Context X-Ray projection latency and byte measurement), `150b6326` (bounded
model-free governed Story-start transaction latency and workflow-byte measurement), and `116d6f43`
(content-free post-preflight push-failure and exact-sync recovery measurement), and `9ea94aac`
(offline/fresh-clone/interrupted-write recovery plus cancellable parser boundary), and `921bc790`
(strict private benchmark retention and signed single-host/matrix evidence binding).

Local verification checkpoint on `main@e8edf155`:

- `npm run test:platform:cmp-wel`: 27 passed, 0 failed;
- `npm run benchmark:wel`: 12 content-free samples completed, including exact-static/inexact
  classification, zero false-exact matches, exact retained-commit push recovery, offline recovery,
  fresh-clone equality, interrupted-write restoration, and cancellation with zero proposals;
- all results remain local macOS arm64/Node 25 observe-only evidence. They do not replace the
  independent review, authenticated runner, real-repository corpus, office-network, Windows/Linux,
  or signed package/platform receipts required below.

Signed-evidence regression checkpoint on `main@921bc790`:

- 39 focused WEL and release-evidence tests passed with zero failures, skips, cancellations, or todo;
- a real one-sample macOS arm64/Node 25 benchmark was privately retained, replay-validated, and
  canonical-digest-bound with `falseExact: 0`; this unsupported release runtime is local diagnostic
  evidence only and fills no Node 20/22 matrix cell;
- repository conformance passed 1,334 checks and the npm package dry run included the new validator.

Strict local release-aggregate checkpoint on `main@60e37936`:

- `npm run test:release:aggregate` completed run `ef2adfc807f1380ad2a1c85f` across 457 files and
  eight exact-tree shards: 4,645 passed with zero failures, cancellations, skips, or todo;
- the aggregate receipt binds Node 22.14.0, macOS arm64, exact commit/tree/source identities, and
  every shard receipt digest, with `failOnSkipped: true` and a clean checkout;
- the same baseline includes the guarded migration-golden completeness check, so every registered
  durable family and readable version must have a frozen golden before conformance can pass;
- this receipt is unsigned, local development evidence. It does not satisfy Windows/Linux, Node 20,
  npm/VSIX artifact-signing, office-network, independent-review, or authenticated-runner gates.

Strict Node 20 compatibility checkpoint on `main@d3bebeb0`:

- the runtime boundary now selects native type stripping on Node 22 and the bounded repository
  TypeScript loader on Node 20, including nested CLI, VS Code, and visual-fixture child processes;
- `npx --yes node@20 scripts/run-test-aggregate.mjs all --require-clean --fail-on-skipped`
  completed run `b3e0136ed4c8a03598192402` across 458 files and eight exact-tree shards;
- Node 20.20.2/macOS arm64 passed all 4,648 tests with zero failures, cancellations, skips, or todo;
- the receipt binds commit `d3bebeb0f4919dc9bfd262d524af97c682a1f91d`, tree
  `f90b332e5dd5362e34825505f6d96caf46108cb5`, source digest, clean-checkout status, runtime, and
  every shard receipt digest;
- this second local receipt remains unsigned. It proves the local Node 20 runtime cell but does not
  satisfy Linux/Windows, npm/VSIX artifact-signing, office-network, independent-review, or
  authenticated-runner gates.

Linux portable-matrix checkpoint on `main@3b998d05`:

- clean Docker clones on Linux arm64 ran the unchanged portable CMP/WEL matrix with the JDK compiler
  module available;
- Node 20.20.2 (`node:20-bookworm` digest
  `sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5`) passed 32/32;
- Node 22.23.2 (`node:22-bookworm` digest
  `sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d`) passed 32/32;
- both runs had zero failures, skips, cancellations, or todo. These are real Linux runtime exercises,
  but are unsigned, containerized, and do not replace physical installed-host, office-network,
  Windows, authenticated-runner, independent-review, or package-binding evidence.

Linux x64 compatibility checkpoint on `main@30b13291`:

- clean, read-only source clones ran inside `linux/amd64` Docker containers under emulation, with
  OpenJDK 17 installed and `jdk.compiler` available;
- Node 20.20.2 and Node 22.23.2 each passed the unchanged `test:platform:cmp-wel` matrix 32/32;
- both executions reported zero failures, skips, cancellations, or todo, including the bounded
  Java parser, JavaScript identity corpus, CMP exact-resource corpus, and cancellation boundary;
- this revalidates the unchanged matrix after the daily Token Ledger schema migration and roadmap
  reconciliation; neither runtime acquired a model or network authority during the matrix;
- this adds unsigned Linux x64 portability evidence. Because the containers were emulated and did
  not exercise a physical installed VS Code host, office network, credential helper, authenticated
  runner, or reviewer signature, it fills no governed release-matrix cell.

Linux packaged-release checkpoint through `main@e2e90e59`:

- a clean Node 22.23.2/JDK 17/Git 2.39.5 Docker clone at `main@dbff2b86` completed all ten
  `poc:release-gate` stages, including 148/148 strict POC/CMP/WEL tests, the isolated npm install,
  the VSIX-contained engine, and the 12-sample WEL benchmark;
- that WEL run produced one exact-static case, zero false exact matches, safe parser cancellation,
  exact retained-commit push/offline recovery, fresh-clone equality, and interrupted-write
  restoration. The content-free release log digest was
  `sha256:2db3c0bd70ec1660ddf6aa7da28b0410a277b88beaac6ab4f83ae751254fb8e0`;
- the contained engine digest was
  `sha256:8c9e9bf7e5da922204a87bad4810e141651435052d61ca7d222b6853ebca3e90`; the generated VSIX digest
  was `sha256:baf18f8fc8dbdfd7debe216e203c4140cf0e77d18169fb3e4d52de2eccc5f9e6`;
- Node 20.20.2 exposed a runtime-only reporting difference: 93 tests excluded by the release
  stage's exact name pattern were labeled as skips. `e2e90e59` now recognizes only Node's exact
  selection reason under an active matching pattern, removes those synthetic events from the
  release projection, and still refuses authored skips, todo, and cancellation. The real packaged
  POC journey then passed 1/1 with zero projected skips after a clean container rebuilt the
  2,244-file VSIX; its machine-local log digest was
  `sha256:aae977583d22d92042ae43b02be8e8a7aad440ffe29ba770a835ba7907b6c44b`;
- these runs are unsigned Linux arm64 container evidence. They close the code-local Linux artifact
  exercise, not the physical-host, office-network, Windows, independent-review, or signed-matrix
  gates.

Still required before completion: reviewed real-repository corpus metrics, office-network remote
Story publication latency measurements, an approved Flow Impact design, live office/offline and
cross-platform cancellation/process-tree exercises, execution of the isolated artifact proof on a
physical Windows host, and one signed release receipt binding npm, VSIX, schemas, source, and the
full supported-platform matrix. The container evidence is code evidence for those paths, not a
substitute for the external host receipts.

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

The unchanged portable CMP/WEL matrix was re-run on macOS arm64 with Node 25.5.0 at
`main@a2baa584`: 43/43 tests passed with zero failures, skips, cancellations, or todo. This proves
the current code-local adapter, cancellation, replay, and integration boundaries still compose.
It is unsupported-runtime local evidence only; it does not fill an independent-review, supported
Node, physical Windows/Linux, office-network, authenticated-runner, or signed-package matrix cell.

The expanded portable CMP/WEL matrix was re-run on macOS arm64 with Node 25.5.0 at
`main@a76a8922`: 55/55 tests passed with zero failures, skips, cancellations, or todo. The WEL v5
benchmark also completed all 12 exact-static samples and all three model-free local Story-start
samples, with zero false exact matches, exact retained-commit recovery for synthetic push and
offline failures, exact clean fresh-clone equality, exact interrupted-write restoration, and safe
adapter cancellation with zero mapping proposals. This refresh proves that the current WEL
observe-only boundary still composes with the newer CMP projections. It remains unsigned,
unsupported-runtime, same-developer local evidence and fills none of the external gates below.

Local performance/reliability checkpoint at `main@c664d4d8`:

- the full Auto integration file completed 59/59 tests in 636.6 seconds, inside the unchanged
  30-minute process-heavy shard deadline that the repeated-initialization fixture had exceeded;
- the reviewed JUnit corpus completed in 2.1 seconds after a loaded-host run had taken 59.5 seconds
  and degraded its final safe-mismatch case to parser-unavailable;
- `npm run test:platform:cmp-wel` completed 55/55 tests in 6.4 seconds with zero failures, skips,
  cancellations, or todo; 60 focused delivery, runner, receipt, benchmark, and WEL tests also passed;
- repository conformance passed all 1,360 checks. These are unsigned local performance and
  regression observations only; they fill no independent-review, authenticated-runner, physical
  platform, office-network, or signed-package evidence cell.

Current clean release-aggregate checkpoint at `main@d677577a`:

- `npx --yes node@22 scripts/run-test-aggregate.mjs all --require-clean --fail-on-skipped
  --shards=8 --workers=2 --deadline-ms=7200000` completed run
  `be71c5a094d878bde7f1cfce` across all 469 selected files on macOS arm64/Node 22.23.2;
- all 4,707 tests passed with zero failures, cancellations, skips, or todo. The aggregate receipt
  binds commit `d677577a75bb704a1607f144951f4b3feb323e24`, tree
  `fe9f7550c2aa656872cadb27bd60b9544af042d5`, the exact selected-source digest, strict-skip policy,
  runtime identity, and all eight shard-receipt digests;
- the initial cold run exposed one isolated transient Story-start fixture failure and exhausted the
  30-minute ceiling in one broad shard. The exact failing test passed alone, and the aggregate then
  reused six exact passing receipts and reran only the two incomplete shards under the bounded
  two-hour ceiling; both passed completely. No dependency, workflow, or product failure repeated;
- this is unsigned same-developer local evidence. It strengthens the current macOS/Node 22
  regression and recovery record but fills no independent-review, authenticated-runner, reviewed
  real-corpus, physical Windows/Linux, office-network, or signed-package matrix cell.

Current strict Node 20 liveness checkpoint at `main@03825387`:

- `npx --yes node@20 scripts/run-test-aggregate.mjs all --require-clean --fail-on-skipped
  --shards=8 --workers=2 --deadline-ms=7200000` completed run
  `658a7530de082ce517cf5042` across all 469 selected files on macOS arm64/Node 20.20.2;
- all 4,708 tests passed with zero failures, cancellations, skips, or todo. The aggregate receipt
  binds commit `03825387abc6856bb2e234bf60c94297bb85938a`, tree
  `a626942bfdd07d1bb98cc634b87ad61e51257c70`, strict-skip policy, runtime identity, and all eight
  shard-receipt digests;
- the run exercised the formerly blocking exact Git state publication under aggregate load and
  completed after reusing only exact successful shard receipts. A separate concurrent `npm ci`
  interrupted dependency installation during the first attempt; restoring the locked dependencies
  and resuming the same run reran only the incomplete shards, which all passed;
- this is unsigned same-developer local evidence. It closes the code-local liveness regression but
  fills no independent-review, authenticated-runner, reviewed real-corpus, physical Windows/Linux,
  office-network, or signed-package matrix cell.

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

### [~] WEL-P2-001 — Additional framework adapters

Owner: repository maintainers. Branch: `main`. Started: 2026-09-06. Target: next observe-only
release. Dependencies: the existing local-observation authority and approval review are reused;
independent identity-contract review and supported-platform evidence remain open.

Implemented in `b138ce06` and `676c591e`:

- closed `jest-static-v1` and `vitest-static-v1` profiles use the matching structured JSON result
  adapter and one shared registry rather than adding framework branches throughout the lifecycle;
- only Git-tracked, regular, bounded JavaScript/TypeScript test sources are read; Candidate modules
  are never imported, transpiled, loaded, or executed by the observer;
- one narrow top-level literal grammar binds `// @sflow-ac:<WORK-ID>:AC-NNN` to a unique top-level
  reporter occurrence; suites, dynamic titles, modifiers, focus, retries, shards, collisions, and
  lexical ambiguity fail safely to inexact evidence;
- the JSON aggregate, normalized occurrences, exact source range, mapping proposal, and
  content-addressed raw report are replayed during Code Delivery verification;
- the existing human approval authority accepts the two closed profiles while Candidate, Program,
  attempt, nonce, and independent attestation remain explicitly unavailable;
- the portable CMP/WEL matrix, release gate, isolated npm install, and VSIX-contained engine smoke
  load and exercise the packaged JavaScript adapter registry.
- a checked-in 14-case synthetic adversarial corpus covers exact Jest/Vitest literals, multiple
  qualified clauses, dynamic and non-literal titles, focus, suites, conditional declarations,
  source/report collisions, report/source mismatch, comment ambiguity, and unqualified tags. Its
  executable assertion requires zero false exact matches while preserving safe degradation.

Verification at landing:

- 86 focused WEL, Code Delivery, policy, review, benchmark, receipt, and release-contract tests
  passed;
- the 32-test portable CMP/WEL matrix passed with zero failures, skips, cancellations, or todo;
- repository conformance passed 1,337 checks;
- isolated npm installation and VSIX-contained engine smokes loaded the new packaged modules.

Still required before this item can be complete: independent review of
[ADR 0015](adr/0015-wel-javascript-local-identity.md), a reviewed real-repository Jest/Vitest
corpus with zero false exact matches, Windows/Linux/macOS receipts on supported Node runtimes,
signed package-matrix evidence, and a separately approved contract for every additional framework
or test shape.

Add one framework at a time, each with its own exact identity, parser, reconciliation, trust,
freshness, migration, recovery, performance, and platform contract.

Remaining candidate increments:

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
5. finish independent review and platform/corpus evidence for the bounded Jest/Vitest increment;
   add any further P2 adapter only after the first ecosystem has stable production evidence.

There is no additional code-local WEL increment that can honestly close a current `[~]` item on a
single developer machine. Independent ratification, authenticated execution, reviewed real-repo
measurements, and signed supported-platform/package receipts are evidence inputs, not values the
product or its author may synthesize.

## Maintenance

- Review this file whenever `WEL-SPEC.md`, `CAB-ROADMAP.md`, or `SGOS-PENDING-WORK.md` changes.
- Update the dependency dashboard and the affected detailed item in the same commit.
- Keep observe-only behavior, enforcement availability, and assurance labels independently visible.
- Record completed work with exact commits and verification receipts; do not replace history with a
  summary that cannot be audited.
- Keep this document linked from the repository documentation index and covered by package and
  release validation so stale links or missing content are detected.
