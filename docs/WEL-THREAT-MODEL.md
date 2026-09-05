# Witnessed Engineering Loop threat and privacy model

**Status:** Reviewed code-local model for the observe-only pilot. It does not authorize enforcement
or certify an independent runner.

## Protected claims

WEL must preserve four separations:

1. repository-controlled bytes are not trusted evidence merely because they exist;
2. exact static identity is not proof that a testcase executed;
3. a passing testcase is not proof that a requirement is semantically correct;
4. a local developer observation is not independent or externally attested evidence.

## Threat register

| Threat | Required control | Failure classification |
|---|---|---|
| Malicious production or test code | Parser never loads or executes Candidate classes; execution stays in existing Code Delivery boundary | unavailable/inconclusive |
| Parser confusion or crash | Narrow grammar contract, exact source ranges, bounded helper, fail-closed catalog validation | unsupported/inconclusive |
| Toolchain substitution | Parser manifest and runtime family recorded; authenticated toolchain remains a CAB prerequisite | local-observed only |
| Forged or stale XML | Existing no-follow bounded raw-report ingestion; report digest and replay; suite/command failures disqualify passes | tampered/inconclusive |
| Display-name or report collision | Join requires one exact qualified class and method; duplicates never match | ambiguous |
| Source mutation after parsing | Tracked-source digest, declaration byte digest, receipt replay, and Git Candidate checks | stale/tampered |
| Link/path substitution | Repository-relative canonical paths, symlink refusal, no-follow raw-report reads, no absolute durable paths | unavailable/tampered |
| Model-created semantic authority | Source tags are proposals; every proposal requires explicit human review | unreviewed |
| Reviewer mistake or self-approval | Exact clause and test identities displayed; decision, reason, expiry, actor, and existing self-approval policy retained | governed human decision |
| Expired exception | Exception requires a future expiry; subsequent readers must reject an expired decision | stale |
| Remote or credential leakage | No network in parser; raw origin and credentials excluded; only normalized origin digest persists | unavailable if identity absent |
| Replay across Story/clause/test | Review mapping binds clause bytes, proposal, declaration, logical test, and parser; later Candidate/Program join remains required | stale |
| Hash collision | SHA-256 canonical projections, strict field validation, family versions, and raw-byte checks before migration | refuse on mismatch |
| Evidence growth or denial of service | File, byte, declaration, output, timeout, and mapping-count ceilings | unavailable |
| Historical authority inflation | In-memory migration sets exact false and never rewrites durable records | legacy/inconclusive |
| Interrupted write or push | Existing subject lease, atomic records, exact-SHA journal, pending-publication recovery | recover exact recorded subject |

## Privacy matrix

| Data | Durable WEL record | Presentation only | Prohibited |
|---|---:|---:|---:|
| Clause ID and clause-body digest | yes | yes | no |
| Clause text, Behavior, Observable | no | yes, loaded from immutable reviewed artifact | telemetry/metrics |
| Logical test digest and declaration digest | yes | yes | no |
| Repository-relative test path | yes for local review evidence | yes | telemetry/aggregate metrics |
| Raw test body | no | no | evidence/telemetry |
| Raw Surefire XML | existing Code Delivery evidence only | explicit artifact inspection | prompt/telemetry |
| Normalized origin digest | yes | diagnostic if needed | no |
| Raw origin URL or credentials | no | no | all WEL records/logs/prompts |
| Absolute or temporary path | no | transient local diagnostic only | durable identity |
| Reviewer identity and decision | existing approval record | yes | anonymous authority claim |
| Prompt/model content | no | no | WEL metrics/evidence |

Content-free measurement may include counts, status categories, byte totals, and bounded latency.
It must not include clause text, test bodies, paths, work IDs, Git identities, or individual
productivity measures.

## Platform and release boundary

Unit fixtures cover deterministic parsing, migration, replay, mutation, ambiguity, and review
decisions. Release eligibility still requires reviewed macOS, Linux, and Windows exercises for JDK
availability/version, path encoding, cancellation, timeout, office proxy isolation, npm/VSIX
packaging, and fresh-clone replay. Until those receipts and the CAB/SGOS trust boundary are approved,
the strongest WEL result remains local, observe-only, and inconclusive.

