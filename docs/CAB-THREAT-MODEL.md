# Code Assurance Bridge threat, privacy, and recovery model

**Status:** code-local CAB-R0 review candidate; not an enforcement authorization

## Security objective

CAB must prevent untrusted Candidate bytes, checker output, local signers, models, reviewers, and
remote races from fabricating authenticated assurance or moving Git authority. When a required
fact cannot be authenticated and replayed, the result is unavailable, inconclusive, stale, or
tampered—never pass.

## Threat register

| Threat | Required control | Safe result |
|---|---|---|
| Candidate author forges evidence | evidence lives outside Candidate plane and binds retained Candidate | tampered/inconclusive |
| Test reads host secrets or sockets | disposable non-root sandbox, empty home, no host/Git/container sockets | fail/unavailable |
| Test escapes through network | deny by default; exact approved endpoints and captured policy only | fail/unavailable |
| Checker mutates source | read-only Candidate mount plus pre/post identity replay | tampered |
| Parser consumes malicious report | separate bounded parser, no entities/links/traversal, strict schema | inconclusive/tampered |
| Toolchain or rules are substituted | authenticated manifest, digest, policy epoch, and revocation recheck | stale/tampered |
| Local developer signer claims independence | trust matrix labels developer-local issuers non-independent | local observation only |
| Runner key is stolen or revoked | short expiry, audience, nonce ledger, rotation and revocation at use time | stale/tampered |
| Attestation is replayed | Candidate/Program/attempt/nonce binding and one-use consumption | tampered |
| Model claims a checker passed | deterministic evidence cannot be satisfied by model output | inconclusive |
| Author self-approves independent profile | existing separation policy and immutable review epoch | refuse |
| Reviewer signs stale bytes | approval binds exact Candidate, bundle, workflow, epoch, and scope | stale |
| Optional score hides required failure | conjunctive mandatory predicate aggregate | fail/inconclusive |
| Waiver silently weakens policy | human-only, scoped, reasoned, expiring exception remains visible | verified-with-exceptions |
| Evidence is deleted | future replay reports unavailable; historical record is not rewritten | unavailable |
| Evidence store is flooded | per-record, aggregate, artifact, retention, and concurrency ceilings | unavailable |
| Symlink or case collision escapes storage | canonical paths, no-follow opens, ancestor checks, collision refusal | tampered |
| Cancellation leaves a process running | process-tree stop plus verified quiescence before lease release | recovery-required |
| Concurrent checker writers collide | immutable IDs and exact compare-and-swap | conflict/retry |
| Push hook rejects publication | retain exact commit and content-free diagnostic digest | pending publication |
| Remote base moves | re-read target and exact CAS before authority transition | conflict/replan |
| Administrator bypasses local checks | separate required remote verifier and bypass audit; R7 unavailable | local-only claim |
| Legacy record is upgraded | migration preserves original assurance and adds no invented bindings | legacy/inconclusive |

## Trust-root requirements

An enforcement-grade checker trust root must be approved outside the Candidate and must name:

- issuer keys and algorithms;
- allowed checker and verifier manifests;
- audience and repository/capability scope;
- policy epoch and minimum runner/toolchain versions;
- validity period, rotation overlap, revocation source, and maximum freshness;
- nonce issuance and replay-consumption authority;
- evidence storage, retention, and residency rules.

Hashing without an approved trust root is integrity only. Git-trusted configuration authenticates
approved policy bytes through repository authority; it does not authenticate a checker process.

## Privacy matrix

| Data | Typed CAB record | Bounded artifact | Prohibited from telemetry/identity |
|---|---:|---:|---:|
| Candidate, Program, policy, manifest digests | yes | yes | no |
| Result artifact digest and closed outcome | yes | yes | no |
| Repository-relative reviewed path | only when required by adapter | yes | aggregate telemetry |
| Source/test body | no | explicit governed artifact only | yes |
| Raw log/report | no | bounded, encrypted by policy | yes |
| Raw origin URL or credentials | no | no | yes |
| Absolute/temp path and process ID | no | local diagnostic only | yes |
| Human identity and decision | existing approval record | review UI | aggregate productivity data |
| Prompt/model content | no | existing consented prompt audit only | CAB telemetry/evidence |
| Counts, bytes, latency, closed status | content-free only | yes | individual productivity claims |

## Adversarial anchors

The CAB-R0 tests mutate authority ownership, local trust, checker publication, waiver authority,
Candidate mount access, default network access, enrollment, remote enforcement, and Candidate
identity binding. Later milestones must add executable fixtures for sandbox escape, malicious test
process trees, toolchain substitution, signed-envelope replay, result collision, evidence-store
overflow, platform path/encoding behavior, and remote bypass.

## Residual risk and no-go boundary

This repository can validate the architecture and local observation contracts, but it cannot
self-certify an independent runner, enterprise key custody, branch rules, office network behavior,
or supported-platform release evidence. Until those external facts are supplied and reviewed,
`enforce` and remote authorization remain unavailable by construction.
