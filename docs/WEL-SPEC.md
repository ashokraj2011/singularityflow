# SPEC — Witnessed Engineering Loop (`WEL`) v0.2

**Status:** Observe-only implementation baseline; enforcement remains unavailable pending CAB and SGOS prerequisites

**Baseline:** `main@b38a4621cff378f1e173be84a6552d2a71ca30cb`

**Rewritten:** 2026-08-30

**Supersedes for planning:** `SingularityFlow_Witnessed_Engineering_Loop_SPEC.md` v0.1

**Related authority:** `docs/CAB-ROADMAP.md`, `docs/SGOS-PENDING-WORK.md`

---

## 0. Executive decision

The Witnessed Engineering Loop is approved as a product direction, but it is not a new governance
kernel and it MUST NOT be implemented as a parallel evidence, study, knowledge, approval, or
publication system.

WEL v0.2 is an integration profile over existing Singularity Flow authorities:

| WEL concern | Authoritative SFlow subsystem |
|---|---|
| Witnessed clause structure | Existing specification-quality analyzer and checklist |
| Planned and observed clause mappings | Existing specification claim maps and acceptance evaluation |
| Exact testcase observations | Code Assurance Bridge over the SGOS Candidate, Program, verifier, evidence, and publication boundaries |
| House knowledge | Existing provenance-bound knowledge records and deterministic recall |
| Structural information | Existing optional AST diagnostics or separately registered deterministic quality checks |
| Prompt-variant evaluation | Existing Impact `prompt-set-randomized` studies |
| Lifecycle authority | Existing phase publication, approval, submission, and governed Git transaction |

The first deliverable is a non-blocking, single-ecosystem pilot. Enforcement is a later capability
and is unavailable until the CAB trust, containment, and lifecycle prerequisites are proven.

The intended machine claim is deliberately narrow:

> For one exact candidate and one approved witness mapping, a pinned harness observed a supported
> testcase identity with a qualifying outcome, and the existing lifecycle authority evaluated the
> resulting evidence under the Story's pinned policy.

WEL MUST NOT claim that a requirement is semantically correct merely because a tagged test passed.

---

## 1. Purpose

WEL closes five practical gaps without creating new authority:

1. acceptance clauses can state what behavior, observable outcome, and witness type are expected;
2. reviewers can approve an explicit clause-to-test mapping rather than infer it after delivery;
3. supported test harnesses can report exact observed testcase identities instead of only module
   totals;
4. approved knowledge can be seeded and selected with visible provenance; and
5. teams can measure whether the additional evidence improves delivery using the existing study
   framework.

WEL is deterministic at every authority boundary. Models may draft clauses, tests, explanations,
and review summaries. A model cannot lint authoritatively, approve a semantic mapping, mint a test
result, satisfy a policy obligation, waive a failure, or publish a lifecycle transition.

---

## 2. Scope

### 2.1 In scope

- a structural `Behavior` / `Observable` / `Witness` clause profile;
- human review of semantic witness mappings;
- an observe-only exact-test vertical slice for one ecosystem;
- honest assurance labels and explicit `INCONCLUSIVE` outcomes;
- immutable evidence bound to one exact SGOS Candidate;
- knowledge-seed import into the existing knowledge store;
- Context X-Ray projection of selected and omitted knowledge;
- capability-scoped AST diagnostics that remain optional;
- WEL measurements added to existing Impact studies;
- migration, compatibility, recovery, packaging, and cross-platform tests.

The initial exact-test adapter is Java, JUnit 5, Maven Surefire, one Maven module, and statically
declared non-parameterized test methods. This matches the CAB roadmap and the primary Java/Maven
demonstration path. Additional ecosystems are separate reviewed increments.

### 2.2 Non-goals

WEL v0.2 does not:

- make AST mandatory or allow AST availability to block lifecycle work;
- prove that a testcase adequately represents a requirement without human review;
- treat same-user local output as adversary-resistant or independently attested evidence;
- add a second Candidate, scheduler, checker registry, approval quorum, or publisher;
- create another prompt-study assignment or reporting subsystem;
- create another knowledge store or recall engine;
- support dynamic, generated, retried, parameterized, or ambiguous test identities in the first
  adapter;
- support enforce-grade manual, inspection, runtime, or metric witnesses in the first release;
- use model-based clause judgment, testcase matching, evidence evaluation, or study promotion;
- silently enroll an existing or in-flight Story;
- require repository-hosted CI workflow files;
- infer a repository from the user's home directory or previous chat context.

---

## 3. Terminology

**Clause**  
A stable, fully-qualified requirement or acceptance identifier already indexed by the specification
system, for example `CFA-STORY:AC-001`.

**Witness declaration**  
The structural statement of the expected behavior, observable outcome, and witness type. It is not
execution evidence.

**Witness proposal**  
A deterministic mapping from a clause to one or more logical testcase identities. A source tag is a
proposal, not semantic approval.

**Reviewed witness mapping**  
A witness proposal whose exact digest was accepted through the existing phase review and approval
authority. The review means the human accepted the mapping's relevance; it does not guarantee that
the implementation is correct.

**Logical testcase identity**  
A stable adapter-defined identity, such as repository path, Java package, class, and method. It does
not contain the testcase body hash.

**Testcase body binding**  
The exact declaration byte-range hash plus parser, adapter, framework, and candidate identity used
to detect stale or substituted test bodies.

**Observed testcase occurrence**  
One normalized result occurrence emitted by an approved harness attempt.

**Local-observed evidence**  
Evidence produced under the same local principal as candidate code. It is useful and replayable but
not independently authenticated against a malicious repository.

**Externally-attested evidence**  
Evidence emitted by an isolated runner or remote verifier with an approved identity and a trust root
unavailable to candidate code.

**Declared-witness-passed**  
The deterministic result that a reviewed mapping joined to a qualifying exact testcase observation.
It is the strongest WEL machine verdict. The phrase `clause verified` is not used.

**Inconclusive**  
The system could not establish an exact supported identity or trustworthy qualifying result. An
inconclusive result is never promoted to pass.

---

## 4. Constitutional invariants

[WEL:CON-001] WEL MUST reuse the existing SGOS Candidate identity and MUST NOT define another source
fingerprint as an authority boundary.

[WEL:CON-002] WEL MUST reuse the existing GVM Program or its exact deterministic projection. It
MUST NOT introduce another task scheduler.

[WEL:CON-003] WEL MUST reuse approved operation and verifier manifests. Repository-controlled
commands cannot become authoritative merely because they emitted a correctly shaped report.

[WEL:CON-004] WEL evidence is input to existing phase publication, approval, submission, and Git
transactions. It cannot advance lifecycle state independently.

[WEL:CON-005] AST is always optional. Disabled, unsupported, degraded, missing, or failed AST MUST
produce a diagnostic outcome and MUST NOT block publication, approval, submission, recovery, or
ordinary repository file access.

[WEL:CON-006] A mandatory structural rule MUST run as a registered deterministic quality checker
independent of optional AST. AST may explain or accelerate that checker but cannot be its only
execution path.

[WEL:CON-007] Deterministic structural analysis may prove field presence, syntax, uniqueness,
boundedness, and exact joins. It MUST NOT claim that prose is clear, complete, correct, or
semantically adequate.

[WEL:CON-008] A source tag is a witness proposal only. A passing tagged test becomes
`declared-witness-passed` only after the exact mapping digest has been reviewed under existing
approval authority.

[WEL:CON-009] A testcase PASS is invalid if its containing command or suite failed, timed out, was
cancelled, produced teardown or hook errors, exited nonzero, emitted malformed or truncated output,
changed the candidate, or exceeded a resource bound.

[WEL:CON-010] Local-observed evidence MUST be labeled as such. A hash proves byte identity, not
independent authorship or runner authenticity.

[WEL:CON-011] Externally-attested evidence requires a pinned trust root, signer identity, audience,
candidate, attempt nonce, expiry or freshness policy, verifier manifest, and replay protection.

[WEL:CON-012] Every evidence stage MUST bind to one stable candidate. Catalog extraction, command
execution, report capture, mapping join, and receipt publication cannot observe different working
tree states.

[WEL:CON-013] Durable evidence MUST NOT depend on a machine-local temporary path. Temporary paths
may appear as bounded diagnostics but cannot be required for replay or authority.

[WEL:CON-014] Schema registration, migration, writer, reader, validator, packaging, fixtures, and
goldens for a changed record family MUST land atomically.

[WEL:CON-015] Existing Stories and legacy evidence retain their original assurance. Migration MUST
NOT silently upgrade `module-executed` evidence to testcase-exact evidence.

[WEL:CON-016] WEL defaults to `disabled` or `observe`. `enforce` is available only to explicitly
enrolled new Stories whose repository, workflow, adapter, and trust profile passed
preflight.

[WEL:CON-017] Unavailable infrastructure and failing behavior are different outcomes. Environment,
adapter, identity, policy, and execution failures MUST have distinct stable codes and recovery
instructions.

[WEL:CON-018] Models cannot satisfy, reinterpret, suppress, or waive deterministic WEL outcomes.

[WEL:CON-019] Knowledge is untrusted guidance when injected into a model context. It cannot alter
system instructions, tool permissions, lifecycle policy, or execution authority.

[WEL:CON-020] WEL studies reuse the existing Impact assignment authority and preserve
intention-to-treat reporting. Post-assignment exclusion cannot manufacture a preferred result.

---

## 5. Logical architecture

```text
approved specification bytes ------------ exact SGOS Candidate
        |                                           |
        v                                           v
specification index + structural report    static testcase catalog
        |                                           |
        +--------------------+----------------------+
                             v
              planned/observed witness proposal
                             |
                             v
                 human review of exact proposal
                             |
                             v
                    reviewed witness mapping
                             |
approved verifier manifest -+--------- bounded harness attempt
                             |                    |
                             +----------+---------+
                                        v
                            deterministic exact join
                                        |
                                        v
                          code-delivery evidence aggregate
                                        |
                                        v
                 existing publish / approve / submit / Git transaction
```

The AST, knowledge, and measurement paths are side inputs:

- AST contributes optional diagnostics only;
- selected knowledge contributes bounded, provenance-visible guidance only; and
- Impact/SGOS evaluation observes outcomes without changing lifecycle authority.

### 5.1 Evaluation order

For each generation of an enrolled Story, the runtime evaluates:

1. exact Story, phase, generation, resolved policy, and Candidate identity;
2. witnessed clause structural report;
3. stable static testcase catalog;
4. witness proposal and human review of its exact digest;
5. reviewed mapping coverage plus approved adapter/verifier readiness;
6. bounded harness execution and complete suite outcome;
7. safe result ingestion and normalized occurrences;
8. exact Candidate + proposal + review + test identity + body + occurrence join;
9. code-delivery aggregate; and
10. existing lifecycle gate.

No later step can repair or reinterpret a failed earlier binding.

---

## 6. Rollout modes

### `disabled`

- existing specification and module-level Code Delivery behavior remains unchanged;
- no WEL exact-test obligation is created;
- AST remains optional and knowledge behavior remains unchanged.

### `observe`

- structural reports and supported exact testcase observations are produced;
- comparisons are visible in CLI, VS Code, Context X-Ray, and study metrics;
- lifecycle authority remains the existing module-level assurance;
- missing, ambiguous, unsupported, or tampered exact evidence is shown as `INCONCLUSIVE` or failed
  observation and cannot block publication.

### `enforce`

- available only after CAB hermetic execution and authenticated evidence exit gates pass;
- available only to newly created, explicitly enrolled Stories and supported adapters;
- requires `Witness: test` and a reviewed witness mapping;
- a missing or inconclusive mandatory exact witness blocks only that enrolled generation;
- AST unavailability never blocks, even in this mode;
- an explicit governed policy change is required to enroll or withdraw future Stories.

Switching an existing Story from `disabled` or `observe` to `enforce` is forbidden in v0.2. The
pilot enrolls only a new Story created after the reviewed configuration takes effect. A future
in-place re-resolution mechanism requires its own policy-hash, approval, migration, and recovery
design; this specification does not assume that mechanism exists.

---

# PART I — Witnessed clause profile

## 7. Clause structure

WEL extends the existing specification-quality analyzer. It does not add `spec.clauseQuality`, a
second analyzer, or a second approval checklist.

The preferred acceptance clause is:

```markdown
### [CFA-STORY:AC-001]

- Behavior: When an authenticated user requests the balance, the service returns that user's balance.
- Observable: The response is HTTP 200 and the amount and currency equal the persisted account values.
- Witness: test
```

The existing clause ID remains authoritative. WEL does not invent a second WEL-specific ID.

### 7.1 Deterministic structural checks

[WEL:REQ-001] The analyzer MUST read the exact approved specification artifact bytes already bound
by the specification index.

[WEL:REQ-002] For each enrolled acceptance clause, it MUST require exactly one non-empty `Behavior`,
`Observable`, and `Witness` field.

[WEL:REQ-003] Field names are case-insensitive ASCII after trimming. Duplicate fields, duplicate
clause IDs under case folding, malformed headings, and unknown witness values are errors in
`enforce` mode and findings in `observe` mode.

[WEL:REQ-004] The initial allowed witness values are `test`, `inspection`, `metric`, `runtime`, and
`manual`. Only `test` can become enforce-grade in v0.2. Other values remain record-only until their
own typed evidence and authority contracts are approved.

[WEL:REQ-005] The analyzer MUST enforce configured bounds on clauses, bytes per field, total bytes,
and findings, with explicit truncation disclosure.

[WEL:REQ-006] The analyzer MAY emit advisory lexical hints, but those hints MUST use a fully
specified portable tokenizer and MUST NOT be described as proof of clarity, completeness,
measurability, or correctness.

[WEL:REQ-007] A clean structural report MUST carry the existing specification-quality disclaimer:
deterministic analysis makes no claim that the specification is complete, clear, consistent, or
correct.

[WEL:REQ-008] Repository-owned bootstrap commands MAY be run as ordinary record-only quality
commands. They cannot satisfy the authoritative witnessed-clause check. Enforcement uses the native
runtime analyzer or a separately approved verifier manifest.

### 7.2 Proposed policy extension

The policy is added beneath the existing phase-level `specificationQuality` object:

```yaml
specificationQuality:
  mode: warn
  checklist: requirements-quality-v1
  witnessedClauses:
    profile: witnessed-v1
    clauseTypes: [acceptance]
    enforceableWitnessTypes: [test]
    lexicalHints: advisory
    limits:
      maxClauses: 500
      maxFieldBytes: 4096
      maxReportBytes: 262144
```

Before this profile is enabled, the configuration normalizer MUST retain these fields, reject every
unknown nested key, and pin the normalized result through the existing phase policy mechanism. The
current release does not yet accept this extension.

### 7.3 Report projection

The structural report extends the existing specification-quality result. At minimum it shows:

- exact artifact path and SHA-256;
- phase and generation;
- resolved policy digest;
- clause IDs and declared witness types;
- missing, duplicate, malformed, unknown, and boundedness findings;
- advisory lexical hints separately from gate findings;
- truncation disclosure; and
- the deterministic-analysis disclaimer.

The report is evidence and presentation data, not a new lifecycle event.

---

## 8. Witness mapping and semantic review

WEL reuses the existing `specification-claim-map` family and the existing phase approval authority.

[WEL:REQ-009] A planned mapping names a clause ID, witness type, expected execution profile, and one
or more logical testcase proposals. An observed mapping names the actual supported logical testcase
identities found in the candidate.

[WEL:REQ-010] A source annotation can propose a mapping, but it MUST NOT mark that mapping reviewed
or semantically adequate.

[WEL:REQ-011] A human review form MUST show the exact clause text, Behavior, Observable, proposed
test identity, source location, declaration hash, and mapping digest.

[WEL:REQ-012] The reviewer records one of:

- `satisfied` — the proposed test meaningfully witnesses the declared behavior and observable;
- `exception` — the mapping is accepted with a scoped, expiring reason; or
- `not-applicable` — the clause does not require this witness, with a reason.

[WEL:REQ-013] The exact proposal, review decision, scope, reason, and expiry are stored in the
immutable `story-submission-packet` v2 review snapshot. The existing `phase-approval` decision
references that packet. WEL MUST NOT create a second approval record or quorum.

[WEL:REQ-014] Self-approval remains governed by the existing repository policy and MUST be visibly
labeled. WEL does not silently convert self-approval into independent review.

[WEL:REQ-015] A change to clause bytes, mapping bytes, testcase logical identity, testcase
declaration bytes, execution profile, Candidate, or resolved policy makes the prior join stale.

[WEL:REQ-016] The strongest deterministic claim without a reviewed mapping is
`unreviewed-witness-observed`, never `declared-witness-passed`.

---

# PART II — Exact testcase observations

## 9. CAB and SGOS boundary

Exact testcase work is a CAB increment. It reuses:

- the SGOS Candidate Snapshot as source identity;
- the GVM Program or exact deterministic projection as the execution plan;
- approved operation and verifier manifests;
- the existing Code Delivery result adapters and evidence aggregate;
- the existing evidence plane and publication unit of work; and
- the existing phase approval and submission authority.

No `wel run`, `witness submit`, or alternative publisher is permitted.

### 9.1 Evidence handoff

The adapter writes one immutable CAB exact-test observation with a canonical hash projection. SGOS
Action Evidence references that digest together with `candidateSha256`, `programSha256`, task
contract, policy, verifier, and attempt. A success Task Receipt may reference it only after the
existing deterministic verifier derives a qualifying PASS. FAIL or INCONCLUSIVE evidence cannot
produce a success Task Receipt. Code Delivery references the verified evidence; only the existing
lifecycle transaction may publish or advance the Story.

An execution profile is always a deterministic projection bound to `programSha256`; a free-standing
profile digest cannot substitute for the Program. WEL adds no second exact-execution receipt family.

### 9.2 Assurance tiers

| Tier | Meaning | Lifecycle use |
|---|---|---|
| `module-executed` | Existing aggregate command/module evidence | Existing behavior |
| `testcase-local-observed` | Exact identity observed under the local candidate principal | Observe only |
| `testcase-externally-attested` | Exact identity observed by an approved isolated signer | Eligible for opt-in enforcement |
| `inconclusive` | Exact supported identity or qualifying result was not established | Never pass |

The system MUST NOT silently relabel one tier as another. The tier is derived by the evidence
validator after trust-envelope verification; it is never trusted from a producer-supplied field. A
local signature, candidate-controlled signature, or sandbox self-assertion cannot produce
`testcase-externally-attested`.

---

## 10. Initial JUnit identity contract

The first adapter supports only:

- Java source compiled as one Maven module;
- JUnit 5 test methods declared statically in tracked UTF-8 source;
- Maven Surefire XML produced by a pinned supported version;
- a unique package + class + method identity;
- non-parameterized, non-dynamic, non-retried tests; and
- one approved execution profile.

Nested, inherited, generated, dynamic, parameterized, repeated, retried, or colliding identities are
`INCONCLUSIVE` until a later adapter contract explicitly supports them.

### 10.1 Source declaration

A testcase declares a fully-qualified clause proposal inside the executable declaration, for
example:

```java
@Test
@Tag("sflow-ac:CFA-STORY:AC-001")
void returnsPersistedBalanceForAuthenticatedUser() {
    // assertions
}
```

Bare `AC-001` tags are not sufficient when multiple work items or namespaces could match.

### 10.2 Identity fields

[WEL:REQ-017] The logical identity MUST include:

- repository identifier;
- normalized repository-relative source path;
- Java package;
- declaring class;
- method name and supported static signature;
- identity-schema ID; and
- framework identity independent of a particular adapter implementation version.

Repository identity uses the existing canonical repository binding rather than an absolute clone
path. A compatible adapter upgrade preserves the logical ID; a deliberate identity-schema change
changes it. Adapter and parser manifests remain separate evidence bindings.

[WEL:REQ-018] The declaration binding MUST include both:

- an exact Git-blob byte-range SHA-256 for the executable declaration; and
- the exact parser/extractor manifest SHA-256.

Parser-normalized body hashing is not authoritative in the first release. A later canonicalizer may
add a second semantic-body digest only after versioned conformance fixtures prove its behavior.

[WEL:REQ-019] The catalog MUST record ambiguity, unsupported constructs, duplicate identities,
invalid tags, untracked sources, parser failures, and truncated analysis as explicit outcomes.
Configured maxima cover catalog entries, nesting depth, mappings per clause, clauses per test,
occurrences, and join cardinality. Hitting a limit is disclosed and makes affected obligations
inconclusive; truncation never produces pass.

[WEL:REQ-020] Test extraction MUST use a pinned production parser packaged with the adapter. It MUST
NOT depend on optional AST packs.

---

## 11. Harness attempt and safe result capture

[WEL:REQ-021] Each attempt receives a durable attempt ID and a cryptographically random nonce before
execution. Retry creates a new attempt; it does not overwrite a prior result. Every retry references
the predecessor and reason. The latest terminal eligible attempt in that lineage is authoritative;
concurrent attempts or an unclosed predecessor are inconclusive. A caller cannot select an older
PASS after a later authoritative FAIL. Framework-level retries are unsupported in the first adapter.

[WEL:REQ-022] The attempt is bound to:

- SGOS Candidate identity and retained Git commit/tree;
- `programSha256` and any execution-profile projection bound to it;
- resolved executable and arguments;
- working directory;
- approved verifier and adapter manifests;
- JDK, Maven Wrapper/Maven, Surefire, and JUnit identities;
- effective relevant build configuration and POM hierarchy digests;
- dependency/toolchain provenance available to the selected assurance tier;
- filters, shards, retries, and environment-policy digest;
- resource limits, timeout, cancellation state, exit code, and signal; and
- a unique initially empty output directory.

[WEL:REQ-023] A generic repository command is not exact-test authority unless an approved operation
manifest and adapter define its result contract.

[WEL:REQ-024] The local-observe pilot treats candidate-controlled reports as local observations and
never as independent evidence. It performs pre/post Candidate checks but does not describe those
checks as containment. Externally attested enforcement requires CAB's disposable hermetic runner,
read-only Candidate mount, protected runner-owned event channel that candidate code cannot forge or
write, separate result volume, empty home, non-root identity, denied host/Git/Docker sockets,
deny-by-default network, and resource limits.

[WEL:REQ-025] Result ingestion MUST open files through descriptor-based no-follow semantics where
supported, validate containment, reject links, `fstat` before and after bounded streaming, enforce
aggregate byte and file limits, and refuse inode, type, size, or content changes during capture. XML
parsing disables DTDs, external entities, entity expansion, network resolution, and unbounded depth.

[WEL:REQ-026] Symlinks, hard links outside the private result root, devices, sockets, path traversal,
unexpected files, duplicate reports,
oversized output, malformed XML, and output written before the attempt are refused.

[WEL:REQ-027] Normalized durable evidence stores the qualifying occurrences, report digest, and an
immutable evidence-plane artifact reference to the exact bounded report bytes or authenticated
runner event stream. A local temporary report path is diagnostic metadata only. Raw artifacts are
encrypted, access-audited, quota-bound, and retained under evidence policy; expiry makes replay
unavailable and cannot leave an enforce-grade PASS. Candidate `system-out`, `system-err`, absolute
paths, environment dumps, and secrets are never copied into ordinary receipts or telemetry.

[WEL:REQ-028] Cancellation, timeout, process-tree escape, parser crash, runner crash, lock loss, and
host shutdown cannot produce passing evidence. Recovery either resumes safe post-processing of an
immutable captured result or starts a new attempt.

---

## 12. Normalized occurrence contract

Each supported occurrence contains at least:

```json
{
  "logicalTestId": "sha256:<stable-identity-digest>",
  "sourceDeclarationSha256": "sha256:<exact-byte-range-digest>",
  "status": "passed",
  "durationMs": 31,
  "suiteIdentity": "com.example.BalanceServiceTest",
  "testIdentity": "returnsPersistedBalanceForAuthenticatedUser",
  "attemptId": "attempt-...",
  "candidateSha256": "sha256:...",
  "adapterManifestSha256": "sha256:...",
  "reportSha256": "sha256:..."
}
```

Allowed normalized statuses are `passed`, `failed`, `skipped`, `aborted`, and `inconclusive`.

[WEL:REQ-029] A `passed` occurrence qualifies only when the command, containing suite, parser,
capture, candidate recheck, and post-run integrity checks all qualify.

The initial verdict lattice is deterministic:

| Evidence condition | Observation verdict |
|---|---|
| Unique current identity, exact `passed` occurrence, and clean completed attempt | `passed` |
| Trusted exact failed occurrence, or required test skipped/disabled by candidate configuration | `failed` |
| Cancellation, timeout, aborted attempt, unavailable adapter/toolchain, unsupported or ambiguous identity, missing occurrence, stale bytes, malformed/tampered evidence, untrusted attestation, or unexplained nonzero exit | `inconclusive` |
| Nominal pass plus suite/hook/teardown failure, report-integrity failure, Candidate mutation, or incomplete output | `inconclusive` |

A nonzero exit attributable to an exact trusted test failure does not erase the `failed` observation;
it prevents only a passing attempt. Invalid evidence never becomes either `passed` or `failed`.

[WEL:REQ-030] Focused execution, exclusions, filters, or sharding MUST be recorded. A filtered pass
cannot imply an unexecuted mapped witness passed.

[WEL:REQ-031] `.only`-equivalent focus, unsupported parameterization, ambiguous names, result
collisions, missing source declarations, stale declaration hashes, and unmapped reports yield
`inconclusive` in the first adapter.

[WEL:REQ-032] A report occurrence cannot be joined by display name alone. The adapter must reconcile
its framework identity with the exact static catalog under a versioned conformance contract.

---

## 13. Exact join and verdicts

The deterministic join key contains:

1. fully-qualified clause ID;
2. witness-proposal mapping digest;
3. optional mapping-review decision digest and disposition;
4. logical testcase ID;
5. source declaration SHA-256;
6. adapter and parser manifests;
7. `programSha256`, with any execution-profile projection bound to it;
8. Candidate SHA-256;
9. attempt ID, lineage, report SHA-256, and immutable artifact/event reference; and
10. qualifying occurrence status plus complete-suite outcome.

The join always contains a three-valued `verdict` (`passed`, `failed`, or `inconclusive`) and a more
specific `disposition`, one of:

- `declared-witness-passed`;
- `declared-witness-failed`;
- `witness-skipped`;
- `witness-stale`;
- `witness-unreviewed`;
- `witness-unsupported`;
- `witness-ambiguous`;
- `witness-environment-unavailable`; or
- `witness-inconclusive`.

[WEL:REQ-033] No missing or ambiguous field is inferred from nearby tests, filenames, suite totals,
model output, or a previous attempt.

[WEL:REQ-034] Multiple required witnesses use the explicitly pinned `all` or `any` aggregation rule.
The default is `all`. Empty witness sets never pass.

The three-valued aggregation is exact:

| Rule | Result |
|---|---|
| `all` | `failed` if any primary witness failed; otherwise `inconclusive` if any primary witness is not a qualifying pass; otherwise `passed` |
| `any` | `passed` if any primary witness passed; otherwise `inconclusive` if any primary witness is inconclusive; otherwise `failed` |

Supporting witnesses are visible evidence but never satisfy a primary-witness obligation.

[WEL:REQ-035] The aggregate keeps structural completeness, semantic mapping review, execution
observation, assurance tier, self- versus independent approval, and lifecycle decision as separate
facts.

An `exception` or `not-applicable` review never fabricates testcase PASS. It produces a separately
visible `obligation-accepted-with-exception` or `obligation-not-applicable` disposition only when the
existing authority validates actor, scope, reason, Candidate/policy binding, and expiry. Stale,
expired, unauthorized, or wrong-scope decisions are inconclusive.

[WEL:REQ-036] The receipt says `declared-witness-passed`; it MUST NOT say `requirement proven`,
`behavior verified`, or `code correct`.

---

# PART III — Knowledge seeding

## 14. Reuse the existing knowledge store

WEL adds an importer and presentation changes only. Knowledge remains append-only,
content-addressed, provenance-bound, scoped, revocable, and deterministically recalled by the
existing knowledge implementation.

### 14.1 Seed manifest

A reviewed seed manifest MAY describe entries using existing knowledge types:

- `insight`;
- `decision`;
- `gotcha`;
- `constraint`; and
- `uncertainty`.

Each entry MUST provide:

- non-empty bounded text;
- one or more existing supported scopes: capability, repository, path, or environment;
- approved artifact provenance, or an exact governed configuration-change approval that can be
  projected into the same provenance contract;
- status and optional validity interval; and
- optional superseded-record digest.

Phase and work-type may be selection hints in the importer or Context X-Ray. They are not written as
new record scope dimensions without a real `knowledge-record` migration.

[WEL:REQ-037] Import calls the existing knowledge writer after verifying provenance. It MUST NOT set
`approvedSourceVerified` merely because a file exists on a branch.

[WEL:REQ-038] Re-importing an unchanged claim is idempotent. Changed text, provenance, scope, or
validity creates a new content-addressed record and uses the existing supersession mechanism where
appropriate.

[WEL:REQ-039] Selected knowledge is injected as bounded, clearly delimited untrusted guidance.
Control characters are rejected and entry count and byte limits are enforced.

[WEL:REQ-040] Context X-Ray shows selected entries, omitted entries with deterministic reasons,
provenance, validity, scope match, byte cost, and supersession status.

[WEL:REQ-041] Knowledge cannot change model permissions, tool lists, phase policy, AST policy,
quality checks, approval authority, or publication behavior.

---

# PART IV — Capability structural diagnostics

## 15. AST remains optional

Capability-scoped predicates may be resolved and pinned for repeatable diagnostics, but the
predicate evaluator remains outside lifecycle authority.

[WEL:REQ-042] Capability AST evaluation returns `passed`, `failed`, `unavailable`, `degraded`, or
`inconclusive` diagnostics.

[WEL:REQ-043] `unavailable`, `degraded`, `inconclusive`, AST mode `off`, missing packs, unsupported
languages, incomplete project binding, cache failures, and evaluator errors MUST NOT block any
lifecycle action.

[WEL:REQ-044] A capability that requires a mandatory structural restriction must reference a
separately registered deterministic quality checker with a non-AST fallback and readiness preflight.

[WEL:REQ-045] The first capability predicate profile uses normalized repository-relative path
prefixes, not an unspecified glob language.

[WEL:REQ-046] Same-ID inheritance permits only byte-identical reuse or formally ordered changes to
mode and minimum assurance. A path, language, target, predicate type, or scope change requires a new
rule ID.

[WEL:REQ-047] `changed-files` is evaluated against the exact generation-start Candidate baseline.
`capability-cone` is unavailable until its multi-repository boundary is formally defined.

[WEL:REQ-048] Negative structural conclusions require complete scoped coverage. Partial coverage
cannot produce `passed` for an absence claim.

No AST receipt version is bumped solely for WEL v0.2 diagnostics.

---

# PART V — Evaluation studies

## 16. Extend Impact; do not create STU

WEL does not define `study-assignment`, `study-report`, a new salt algorithm, or a new study root.

Existing `prompt-set-randomized` Impact studies remain the only assignment authority. SGOS
evaluation records remain the read-only comparison authority.

[WEL:REQ-049] WEL MAY add content-free metrics such as:

- witnessed clause structural finding count;
- reviewed witness coverage;
- exact identity supported / unsupported / ambiguous counts;
- local-observed versus externally-attested evidence count;
- first-pass approval;
- rework generations;
- gate refusal category;
- elapsed time; and
- exact provider usage when available.

[WEL:REQ-050] Metrics cannot include raw prompts, clause text, test bodies, paths, work IDs, actor
identities, or model-generated content.

[WEL:REQ-051] Assignment uses the existing immutable Story-local Impact plan. Manual authorship,
non-adherence, interruption, and fallback are reported, not removed after assignment.

[WEL:REQ-052] Reports use minimum aggregation thresholds, suppress small cells, document censoring
and missingness, show guardrails, and remain descriptive unless a reviewed statistical plan supports
stronger inference.

[WEL:REQ-053] Study results cannot automatically promote WEL to `enforce`, change an adapter, select
a model, or alter lifecycle policy.

---

# PART VI — Configuration, state, and schemas

## 17. Proposed configuration

The following is illustrative until its parser, schema, and UI land atomically:

```yaml
phases:
  specification:
    specificationQuality:
      mode: warn
      witnessedClauses:
        profile: witnessed-v1
        clauseTypes: [acceptance]
        enforceableWitnessTypes: [test]

  implementation:
    codeDelivery:
      tests:
        executionAssurance: module
        testcaseExact:
          mode: observe
          adapter: junit5-surefire-v1
          requiredWitnessTypes: [test]
          evidenceTier: testcase-local-observed
```

These keys are not accepted by the current release. Before activation, every configuration
normalizer MUST either retain and validate the complete WEL shape or reject it as unknown. Silently
discarding `witnessedClauses`, `testcaseExact`, or any nested WEL key would create an unpinned policy
downgrade and is forbidden.

Defaults preserve current behavior:

- witnessed clause extension absent: existing specification-quality behavior;
- `executionAssurance: module`;
- testcase exact mode `disabled`;
- AST optional and non-blocking;
- existing knowledge and Impact behavior.

The UI MUST present simple presets:

- **Current behavior** — no WEL exact observations;
- **Observe exact tests** — non-blocking pilot;
- **Enforce attested exact tests** — shown only after repository readiness proves support.

Advanced fields remain behind an expert disclosure.

### 17.1 Creation-time enrollment pin

When `story-workflow` v3 is activated, the resolver writes a creation-pinned `resolution.wel`
projection for newly created Stories. It is built only from fully normalized approved configuration
before the existing resolution `policySha256` is calculated and contains:

- mode: `disabled`, `observe`, or `enforce`;
- witnessed-clause profile and policy digest;
- exact-test evidence profile and required assurance tier;
- approved adapter/verifier manifest references when selected;
- specification claim-map contract version;
- CAB/SGOS profile references; and
- an enrollment cutoff/version identifying the reviewed rollout.

It contains references and digests, not duplicate policy bodies. Its `mode` is enrollment state, not
a second policy authority, and MUST agree with every normalized component mode. Any mismatch refuses
Story creation. AST diagnostic policy, knowledge
selection, and Impact assignment continue to use their existing pinned authorities and are not
copied into `resolution.wel`.

A v2 Story read through a v3 in-memory migration has no enrollment pin and remains legacy. A new v3
Story with `mode: disabled` explicitly preserves current behavior.

The policy hash proves integrity of the complete resolved policy bytes, excluding only the existing
`policySha256` field; it does not prove authorization. `observe` and `enforce` additionally bind the
approved configuration-source repository, commit, and asset hashes plus an approved CAB rollout and
profile identity. The existing resolution hash projection and canonicalization remain byte-for-byte
unchanged.

---

## 18. Schema plan

Schema work is feature-atomic, not a version-first increment.

| Family | Current | Planned change | Migration rule |
|---|---:|---|---|
| `specification-claim-map` | 1 | v2 only when typed witness mappings land | retain v1 claims and paths; add empty/null witness fields with review and assurance `unavailable`; old test paths are proposals only |
| `test-execution` | 1 | CAB-owned v2 when normalized exact occurrences land | retain every v1 adapter, command, summary, and report field; add nullable Candidate/Program/attempt/adapter bindings, empty occurrences, and `testcaseAssurance: unavailable`; preserve module assurance |
| `code-delivery` | 2 | v3 when it references exact evidence | verify the raw v2 digest before migration; add null exact-evidence references and retain original assurance |
| `phase-approval` | 2 | remain v2 | mapping and observation identities belong in the immutable submission review snapshot referenced by approval |
| `story-submission-packet` | 1 | v2 if its review snapshot gains mapping/observation identities | verify raw v1 `packetSha256` before additive semantic migration |
| `story-workflow` | 2 | v3 only when explicit creation-time WEL enrollment lands | v2→v3 changes only top-level `schemaVersion`; it injects no resolution defaults and grants no enrollment |
| `knowledge-record` | 2 | no pilot bump | seed importer uses existing types and scopes |
| `ast-gate-receipt` | 3 | no WEL pilot bump | AST remains diagnostic-only |
| Impact families | existing | extend only if current metric envelope cannot represent content-free fields | retain original assignment and generation |

[WEL:REQ-054] A version bump cannot merge until every writer emits the complete current shape using
`currentSchemaVersion(family)`, every durable read routes through the migration registry, every
semantic verifier version literal is removed or intentionally version-specific, and every digest
stored or signed elsewhere is checked against the raw stored projection before migration.

[WEL:REQ-055] Each bumped family includes previous-version goldens, current-version goldens, pure
deterministic migration tests, repeated reads that never rewrite stored bytes, oldest-readable
fixtures, unknown-future refusal, path routing tests, package tests, and VSIX tests. A new v1 family
does not pretend to have a previous-version golden.

[WEL:REQ-056] New WEL hash fields use the shared canonical utilities and define their exact
projection, excluded identity field, prefix, and domain. Existing published hash fields retain their
current algorithm exactly. Changing an existing projection or adding domain separation requires a
new field/version and raw-identity compatibility.

[WEL:REQ-057] Active Stories are never rewritten merely to add empty WEL fields. A Story is enrolled
only when the first Git commit that added its `workflow.json` used `story-workflow` v3 or later and
its creation-time resolution contains an explicit WEL enrollment pin bound by a valid existing
`policySha256` plus approved rollout authority. An absent or malformed creation anchor, v1/v2 or
unversioned creation, missing WEL pin, or unapproved rollout is legacy. Classification never uses the
migrated working-tree record.

[WEL:REQ-058] Legacy AST receipts with no policy binding cannot satisfy any future mandatory quality
checker. They remain diagnostic history.

[WEL:REQ-059] For every record whose digest is stored or signed elsewhere, integrity MUST be checked
against the raw stored-version projection before migration. The migrated in-memory shape cannot be
hashed with the new projection and compared to a digest created for the old shape. This applies
explicitly to `test-execution`, `code-delivery`, and `story-submission-packet` before their planned
version changes.

---

## 19. Publication and stable-snapshot protocol

[WEL:REQ-060] WEL evaluation runs under the existing subject lease and exact-SHA transaction
boundary.

[WEL:REQ-061] Before every external process, after result capture, and immediately before
publication, the runtime recomputes the current resolution hash using the existing projection,
compares it with the creation-commit anchor, and verifies `workflow.resolution.policySha256`, the
approved configuration source, `resolution.wel`, Candidate, `programSha256`/profile projection,
attempt, retained Git binding, and expected clean or declared output roots.

[WEL:REQ-062] Evidence writes are immutable or exclusive content-addressed writes in the evidence
plane. Keys bind family, schema version, digest projection/domain, Candidate, and attempt so distinct
schema projections cannot alias. Concurrent attempts cannot overwrite each other.

[WEL:REQ-063] The existing publication journal and publication unit of work record enough
information to distinguish:

- candidate changed;
- mapping changed;
- test declaration changed;
- runner unavailable;
- result invalid;
- evidence written but publication not committed;
- commit recorded but push failed; and
- remote ref advanced.

[WEL:REQ-064] Recovery pushes or completes only the exact recorded governed commit. It never adopts
ambient HEAD or a later test result.

[WEL:REQ-065] An external attestation is a separate signature envelope over the raw stored immutable
observation digest plus its family, schema version, and hash projection. The envelope binds issuer,
key, audience, Candidate, Program, exact Story `policySha256`, WEL enrollment/profile digest,
approved configuration authority, mapping, attempt nonce, verifier and sandbox manifests,
issue/expiry times, and replay state without creating a self-referential record hash. Verification
derives the assurance tier only after trust, signature, revocation, freshness, audience, and replay
checks, then migrates a separate semantic projection.

---

# PART VII — Interfaces

## 20. CLI

WEL extends existing commands and avoids a new top-level command family.

### Specification and witnesses

```text
singularity-flow spec analyze [--phase PHASE] [--json]
singularity-flow spec claims planned --file MAP [--phase PHASE]
singularity-flow spec claims observed --file MAP [--phase PHASE]
singularity-flow spec trace [--phase PHASE] [--json]
singularity-flow spec acceptance [--phase PHASE] [--json]
```

`spec analyze` includes witnessed structural findings when configured. `spec trace` adds the declared
witness type, proposal, review status, exact observation status, and stale reason.

### Existing adjacent commands

```text
singularity-flow knowledge ...
singularity-flow impact study ...
singularity-flow wm ast doctor
singularity-flow wm ast status
singularity-flow status --json
singularity-flow recover WORK-ID --phase PHASE
```

No WEL command may approve, publish, or execute a mutation without the existing lifecycle ceremony.

### 20.1 Stable refusal vocabulary

The first adapter defines stable error codes, including:

- `WEL_CLAUSE_STRUCTURE_INVALID`;
- `WEL_WITNESS_MAPPING_MISSING`;
- `WEL_WITNESS_MAPPING_UNREVIEWED`;
- `WEL_WITNESS_MAPPING_STALE`;
- `WEL_TEST_IDENTITY_UNSUPPORTED`;
- `WEL_TEST_IDENTITY_AMBIGUOUS`;
- `WEL_TEST_BODY_STALE`;
- `WEL_RUNNER_UNAVAILABLE`;
- `WEL_RUNNER_TIMEOUT`;
- `WEL_SUITE_FAILED`;
- `WEL_RESULT_MALFORMED`;
- `WEL_RESULT_TAMPERED`;
- `WEL_CANDIDATE_CHANGED`;
- `WEL_EVIDENCE_INCONCLUSIVE`; and
- `WEL_ATTESTATION_UNTRUSTED`.

These are error/result codes, not lifecycle event types. Every code includes bounded metadata and a
read-only explanation plus the exact safe recovery command when one exists.

---

## 21. VS Code experience

WEL reuses existing surfaces:

### Specification Trace

For each clause, show:

- Behavior, Observable, and Witness structural status;
- planned and observed testcase identities;
- semantic mapping review status;
- body and Candidate freshness;
- latest exact observation and assurance tier;
- suite outcome; and
- a plain-language reason when the result is inconclusive.

Approval uses the existing review form. The mapping review is presented as explicit checklist
articles; no decision is defaulted.

### Context X-Ray

Show knowledge selected, omitted, stale, superseded, or over budget, with provenance and byte cost.
Show exact-test evidence inputs separately from prompt inputs.

### Lifecycle and recovery

Status cards distinguish:

- application behavior failure;
- unsupported identity;
- local toolchain unavailability;
- untrusted or missing attestation;
- stale mapping or Candidate; and
- interrupted publication.

Each card provides **Explain**, **Open evidence**, and **Prepare recovery command**. Preparation never
executes or submits the command automatically.

### AST

AST diagnostics show pass/fail/unavailable/degraded status and explicitly say **Advisory — lifecycle
continues**. No red blocking state is used for AST unavailability.

---

# PART VIII — Security and privacy

## 22. Threat model requirements

Before `enforce` exists, the CAB threat model MUST cover:

- candidate authors and malicious tests;
- forged, copied, stale, malformed, oversized, and symlinked reports;
- compromised runners, parsers, dependencies, and verifier manifests;
- hostile build scripts and plugins;
- repository-controlled configuration attempting to weaken evidence;
- result replay across Candidates, attempts, repositories, or audiences;
- concurrent publication and ref advancement;
- compromised reviewers and self-approval;
- knowledge prompt injection; and
- small-cohort study re-identification.

### 22.1 Trust labels

The UI and durable receipt MUST separately disclose:

- evidence tier;
- runner and signer;
- candidate and verifier identities;
- mapping reviewer and independent/self status as allowed by existing identity policy;
- waivers or exceptions;
- freshness; and
- unsupported or omitted evidence.

### 22.2 Privacy

- raw clause text and test bodies remain in governed repository artifacts, not study telemetry;
- raw prompts remain governed by the separate prompt-audit consent policy;
- study records contain no actor, path, work ID, prompt, response, source, or artifact content;
- retention and access follow existing Impact and evidence-store policies; and
- cohorts below the configured privacy threshold are suppressed.

---

# PART IX — Test strategy

## 23. Required tests

### 23.1 Structural clause analysis

- complete fields;
- missing and duplicate fields;
- case-folded duplicate clause IDs;
- unknown witness types;
- bounds and truncation disclosure;
- advisory lexical hints never becoming semantic pass/fail;
- exact artifact and policy binding;
- parity across CLI and VS Code.

### 23.2 Mapping and review

- source tag creates proposal only;
- exact mapping digest review;
- changed clause, mapping, body, Candidate, profile, or policy becomes stale;
- all checklist decisions required;
- exception reason and expiry required;
- self-approval disclosed;
- no parallel approval authority.
- an observation created before review remains immutable when the mapping is later reviewed;
- final approval refuses a missing, stale, unauthorized, expired, or wrong-scope mapping review;
- exception and not-applicable dispositions never fabricate testcase PASS.

### 23.3 JUnit static identity

- package/class/method identity;
- exact declaration byte-range hash;
- overloaded or colliding identities;
- nested, inherited, parameterized, dynamic, repeated, retried, generated, and ambiguous tests;
- fully-qualified tags and ambiguous bare tags;
- parser and adapter version changes;
- compatible adapter upgrades preserve logical identity while identity-schema changes deliberately
  change it;
- canonical repository identity is stable across clones and operating systems;
- UTF-8 and line-ending fixtures;
- Windows, macOS, and Linux path normalization.

### 23.4 Harness and result ingestion

- successful complete suite;
- testcase failure, skip, abort, hook failure, teardown failure, timeout, cancellation, and nonzero
  exit;
- malformed, truncated, duplicate, stale, oversized, and unexpected reports;
- DTD, XXE, entity expansion, parser network, excessive depth, and cardinality bombs;
- symlink, hard-link where relevant, device, socket, traversal, inode swap, and grow-after-check
  attacks;
- unique empty result roots and attempt nonces;
- bounded streaming and aggregate quotas;
- process-tree termination;
- candidate mutation and undeclared output;
- malicious candidate code that fabricates a current-attempt passing XML and suppresses the real
  event cannot produce externally-attested evidence;
- externally attested execution cannot access host credentials, Git common directories, unrelated
  workspaces, Docker sockets, or undeclared network targets;
- replay succeeds from the immutable evidence artifact after the temporary directory is deleted and
  fails after artifact tampering;
- `system-out`, `system-err`, secrets, usernames, absolute paths, and environment dumps do not enter
  ordinary receipts or telemetry;
- crash and resume behavior.

### 23.5 Exact joins

- reviewed matching pass;
- unreviewed observation;
- stale body;
- wrong Candidate, attempt, adapter, parser, profile, report, or suite;
- `all` and `any` aggregation;
- empty set refusal;
- module evidence never satisfying testcase-exact enrollment;
- local-observed never presented as externally-attested;
- machine verdict never claiming semantic correctness;
- fail→retry→pass, pass→retry→fail, concurrent attempts, stale prior PASS selection, and
  framework-level retries follow the attempt-lineage rule;
- every observation status and join disposition maps to the documented three-valued verdict;
- a valid PASS is the only exact result eligible for a success Task Receipt; FAIL, INCONCLUSIVE,
  Program/profile mismatch, and invalid Action Evidence cannot produce one.

### 23.6 External attestations

- producer-declared tiers, local signatures, and sandbox self-assertions cannot elevate assurance;
- invalid signature, wrong or untrusted key, audience mismatch, Candidate/Program/policy/mapping
  mismatch, nonce replay, concurrent replay consumption, expiry, clock rollback, key rotation, and
  revocation are refused;
- a valid external signature does not change mapping-review status or convert FAIL to PASS;
- attestation verification uses the raw stored observation identity before semantic migration;
- a changed approval, base, target, rollout profile, or configuration authority is stale.

### 23.7 Knowledge

- approved provenance;
- governed configuration provenance;
- idempotent import;
- supersession and validity;
- scope selection and omission reasons;
- control-character and budget refusal;
- prompt-boundary escaping;
- no authority or permission effect.

### 23.8 AST diagnostics

- off, missing pack, unsupported language, incomplete binding, timeout, cache failure, and evaluator
  exception never block lifecycle;
- advisory predicate findings remain visible;
- mandatory registered quality checker works without AST;
- same-ID change rules and baseline definition;
- incomplete coverage never proves an absence claim.

### 23.9 Impact measurements

- existing deterministic assignment remains unchanged;
- no duplicate assignment authority;
- intention-to-treat includes non-adherence;
- exact-or-unavailable token evidence;
- small-cell suppression and no raw content;
- study cannot mutate rollout policy.

### 23.10 Migrations and packaging

- each bumped family migrates from every supported version;
- migration is idempotent and unknown future versions fail closed;
- legacy evidence remains module-level and unenrolled;
- active Story hashes remain valid;
- fresh install, existing workspace refresh, npm package, and VSIX include the parser and adapters;
- source-tree absence does not break packaged resolution;
- no version writer emits an older shape.
- legacy `test-execution`, `code-delivery`, and `story-submission-packet` digests validate against raw
  stored bytes before migration.

### 23.11 End-to-end and recovery

- disabled Story remains byte-for-byte compatible;
- observe Story records exact evidence without blocking;
- enrolled enforcement Story uses externally attested evidence only;
- interrupted execution, evidence write, commit, and push recover to the exact recorded state;
- mutation of Candidate, mapping, policy, report, attestation, approval, base, or target between
  evaluation and compare-and-swap prevents ref advancement and leaves no false success;
- unavailable AST never blocks any of the three modes;
- no home-directory artifact discovery;
- office proxy/CA/offline cache scenarios on Windows;
- representative Java/Maven repositories on Windows, macOS, and Linux.

---

# PART X — Acceptance criteria

## 24. Product acceptance criteria

[WEL:AC-001] An existing non-enrolled Story behaves exactly as before WEL.

[WEL:AC-002] Missing or failed AST never blocks lifecycle work.

[WEL:AC-003] A witnessed clause report proves only structural facts and carries the semantic
disclaimer.

[WEL:AC-004] A source tag cannot become a reviewed mapping without a human decision under existing
approval authority.

[WEL:AC-005] A passing testcase cannot qualify when its suite or command fails, times out, is
cancelled, or has teardown/hook errors.

[WEL:AC-006] Dynamic, parameterized, retried, generated, colliding, or unsupported JUnit identities
are inconclusive in the first adapter.

[WEL:AC-007] Every exact observation binds one Candidate, mapping, declaration, verifier, execution
profile, attempt, report, and suite outcome.

[WEL:AC-008] Local-observed evidence is never represented as independent or externally attested.

[WEL:AC-009] Module-level legacy evidence never satisfies an enrolled testcase-exact obligation.

[WEL:AC-010] Changing any joined identity makes the prior evidence stale.

[WEL:AC-011] Durable replay does not require a machine-local temporary report path.

[WEL:AC-012] Knowledge seeds enter the existing store only after provenance verification.

[WEL:AC-013] Selected knowledge cannot alter tools, prompts above its untrusted-data boundary,
policy, approvals, or lifecycle authority.

[WEL:AC-014] WEL measurement reuses existing Impact assignment and contains no raw content or actor
identity.

[WEL:AC-015] No schema bump can land while a durable writer still emits the older shape.

[WEL:AC-016] Active Stories are not rewritten or silently enrolled by migration or configuration
refresh.

[WEL:AC-017] CLI and VS Code show the same structural, mapping, observation, assurance, and recovery
facts.

[WEL:AC-018] Every refusal distinguishes a behavior failure from an environment or evidence
availability failure and gives an actionable recovery path.

[WEL:AC-019] WEL creates no second Candidate, scheduler, registry, approval quorum, study assignment,
knowledge store, or publisher.

[WEL:AC-020] The strongest successful machine disposition is `declared-witness-passed`; every
non-pass state remains explicit, and no disposition claims universal correctness.

---

# PART XI — Delivery roadmap

## 25. Increment sequence

### WEL-R0 — Architecture consolidation and threat model

**Planning range:** 2–4 person-weeks  
**Mutation:** documentation, ADRs, fixtures, and threat-model tests only

Deliver:

- rebase WEL onto current SGOS, CAB, specification, knowledge, AST, Impact, approval, and publication
  contracts;
- authority-flow and two-plane storage ADRs;
- JUnit identity and Surefire reconciliation contract;
- signer, trust, containment, replay, and privacy threat model;
- exact schema and migration diff;
- benchmark corpus and cross-platform fixtures.

Exit gates:

- no duplicate authority remains;
- AST optionality is mechanically tested;
- every durable field has an owner and hash projection;
- enforcement remains unavailable.

### WEL-R1 — Witnessed clause and knowledge projection

**Planning range:** 1–2 person-weeks  
**Rollout:** warning/record only

Deliver:

- witnessed-v1 structural extension to the existing analyzer;
- existing review-form and Specification Trace extensions;
- reviewed knowledge seed importer;
- Context X-Ray selection/omission projection;
- packaged CLI and VSIX parity.

Exit gates:

- zero semantic-quality overclaims;
- no new approval or knowledge authority;
- no existing Story behavior change.

### WEL-R2 — JUnit/Surefire local observation pilot

**Planning range:** 3–6 person-weeks  
**Rollout:** observe only

Deliver:

- pinned production parser and static JUnit identity catalog;
- one-module Surefire normalized result adapter;
- exact source-tag proposal, mapping review, and deterministic join;
- immutable local-observed evidence;
- stable refusal/recovery UX;
- performance and false-inconclusive measurement.

Exit gates:

- zero false testcase matches in the reviewed corpus;
- no pass survives any incomplete-suite or tampering condition;
- all supported platforms and office constraints pass;
- current module behavior remains authoritative.

### WEL-R3 — Hermetic runner and authenticated evidence

**Planning range:** inherited from CAB-R2, 6–10 person-weeks  
**Rollout:** observe only

Deliver and exit through the CAB-R2 sandbox, trust, evidence, and supply-chain gates. WEL does not
build a separate runner.

### WEL-R4 — Opt-in JUnit enforcement

**Planning range:** 4–8 person-weeks  
**Rollout:** selected newly created Stories only

Deliver:

- externally-attested exact evidence as a Code Delivery obligation;
- repository readiness preflight;
- governed enrollment and rollback for future Stories;
- complete VS Code review and recovery journey;
- migration cutoff and release evidence.

Exit gates:

- unsupported evidence never becomes pass;
- non-enrolled work remains unaffected;
- enforcement has production/canary evidence and an approved rollback.

### WEL-R5 — Additional evidence types and adapters

Each framework or non-test witness type is a separately scoped increment with its own identity,
trust, freshness, and recovery contract. None is implied by completion of the JUnit adapter.

Potential later increments:

- static Jest/Vitest;
- additional JUnit identities;
- inspection evidence;
- runtime and metric observations;
- signed remote office verifier; and
- independent adequacy or mutation findings through CAB.

### 25.1 Estimate summary

- WEL structural/knowledge record pilot: **1–2 engineer-weeks after R0**;
- local-observed JUnit vertical slice: **3–6 engineer-weeks after R0**;
- opt-in enforce-grade path: **depends on CAB hermetic/authenticated work; not a 13–22 day feature**;
- broader multi-framework WEL: **multiple separately reviewed releases**.

These are planning ranges, not commitments. Exit evidence, not elapsed time, advances the roadmap.

---

## 26. Minimum release checklist

Before any WEL code ships:

- [ ] current baseline and dependency roadmaps are reconciled;
- [ ] no duplicate authority is introduced;
- [ ] AST-optional tests remain green;
- [ ] mode defaults preserve existing behavior;
- [ ] one exact schema/writer/reader/migration unit is reviewed;
- [ ] native and packaged parser resolution is proven;
- [ ] stable error and recovery vocabulary is documented;
- [ ] Windows, macOS, and Linux fixtures pass;
- [ ] performance and boundedness budgets are measured;
- [ ] prompt, knowledge, test, and telemetry privacy reviews pass;
- [ ] CLI, VS Code, npm package, and VSIX show the same facts;
- [ ] interrupted work and push failure recover to exact recorded state;
- [ ] no release claim exceeds the evidence tier actually produced.

Before `enforce` is exposed:

- [ ] CAB hermetic runner exit gates pass;
- [ ] authenticated verifier trust and revocation pass;
- [ ] candidate/evidence two-plane publication is complete;
- [ ] SGOS universal Candidate publication prerequisite is complete;
- [ ] production/canary and office-environment evidence is approved;
- [ ] enrollment and rollback are exercised;
- [ ] independent security review is approved.

---

## 27. Final product statement

WEL makes engineering intent, declared witnesses, exact observations, provenance, and uncertainty
visible in one governed flow. It strengthens traceability without pretending that syntax proves
meaning, that a local report authenticates its producer, or that AST availability should control a
developer's ability to work.

The design succeeds when Singularity Flow can say exactly what it observed, exactly which approved
mapping it used, exactly which Candidate and harness produced the evidence, and exactly what it still
does not know—while retaining one lifecycle authority and a safe path for every existing Story.

---

## Appendix A — Decisions required in WEL-R0

Implementation cannot begin until the architecture review records decisions for:

1. the exact existing phase-review snapshot field that binds a witness-mapping digest, or the
   minimal backward-compatible `phase-approval` migration if no such field exists;
2. the production Java parser, its package/license/provenance, and its exact declaration-range
   algorithm;
3. the supported JDK, JUnit 5, Maven, Maven Wrapper, and Surefire version matrix;
4. the canonical mapping between supported static source identities and Surefire XML identities;
5. the evidence-plane object layout, retention, quota, encryption, and opaque-handle contract;
6. the CAB sandbox and signing architecture used for externally-attested enforcement;
7. acceptable false-`INCONCLUSIVE`, latency, CPU, memory, disk, and result-size budgets;
8. the exact `resolution.wel` projection and raw creation-version compatibility test; and
9. the office-compatible proxy, CA, dependency cache, and remote-verifier operating model.

Each decision requires an ADR and adversarial test anchors. Choosing a library or producing a happy
path prototype does not close the decision.

## Appendix B — Material corrections from v0.1

- mandatory AST gating was removed; AST is permanently diagnostic and optional;
- exact testcase evidence moved under CAB and SGOS instead of creating a parallel authority;
- the first adapter changed from Jest/Vitest to the CAB-aligned JUnit 5/Surefire pilot;
- a source tag now creates only a proposal, with semantic mapping review kept human;
- `clause verified` was replaced by the narrower `declared-witness-passed` claim;
- local-observed and externally-attested evidence are distinct assurance tiers;
- non-test witnesses remain record-only until typed evidence adapters exist;
- WCL extends the existing specification-quality system;
- KNW imports into the existing knowledge store;
- STU was removed in favor of the existing Impact study authority;
- Story enrollment is creation-pinned and legacy Stories are never auto-enrolled;
- schema bumps are atomic with readers, writers, migration, fixtures, and packaging;
- durable evidence no longer depends on temporary report paths; and
- day-scale estimates were replaced with dependency-aware person-week ranges and exit gates.
