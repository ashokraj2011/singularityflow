# Governed Comprehension and Explanation Completeness roadmap

**Status:** corrected implementation roadmap; CMP enforcement is not available

**Design source:** CMP v1 — Governed Comprehension and Explanation Completeness

**Original design baseline:** `main@1cc36d6e`

**Last implementation audit:** `main@3b5d79e6` on 2026-08-31; the observe-only foundation
described below is the only implemented CMP tranche

**Current reconciliation:** checked against `main@7935d2db` on 2026-09-05; later SGOS and GDP
delivery did not implement CMP P1–P6 or turn CMP diagnostics into lifecycle authority

**Current delivery boundary:** observe-only foundation; no publication gate, approval authority, or
new publisher

**Related roadmaps:** [SGOS pending work](SGOS-PENDING-WORK.md) and
[Witnessed Engineering Loop pending work](WEL-PENDING-WORK.md)

## Executive verdict

CMP identifies a real product problem: a large generated diff is difficult to review when its
material changes cannot be traced to governed intent, a repair, a decision, or typed evidence. The
specification's core separation is sound:

- deterministic code decides identity, coverage, freshness, and structural existence;
- an authorized person decides whether a proposed causal relationship is acceptable;
- a model may draft a proposal or narrative, but cannot create authority;
- source and exact diff access remain available even when structural extraction is unavailable;
- no record claims to prove that a reviewer understood or remembered the code.

The submitted CMP v1 document is nevertheless **not implementation-ready as a single feature**.
It proposes 17 schema families, four command families, a second graph, replay, model-authored
walkthroughs, a new packet/decision/receipt chain, lifecycle enforcement, and a substantial VS Code
surface without resolving several ownership conflicts with the current product. Its 24–38 day
estimate also excludes the universal lifecycle Candidate bridge, authority/store decisions,
cross-platform determinism work, migration evidence, security review, packaging, and controlled
rollout required for enforcement.

The safe decision is:

1. ship a conservative, model-free, read-only foundation first;
2. pilot it in `off` mode through explicit commands;
3. allow `record` mode only after the pilot proves deterministic identity, acceptable noise, bounded
   cost, and safe migrations;
4. do not expose `enforce` until `SGOS-P0-001` routes every governed lifecycle publication through
   one universal Candidate boundary and CMP reuses the existing approval/publication transaction;
5. never auto-enrol an existing or in-flight Story into enforcement.

The phrase "code that cannot explain why it exists does not publish" remains a target law, not a
truth about the current release.

## Current observe-only foundation

The first CMP increment is deliberately smaller than the submitted v1 scope. It provides a useful
inspection boundary while preserving every existing lifecycle behavior.

### Present on main (P0 acceptance still in progress)

- `singularity-flow comprehension regions [--base REVISION] [--json]` computes a deterministic,
  read-only region manifest from the existing exact repository change-set implementation.
- `singularity-flow comprehension check [--base REVISION] [--bindings FILE]
  [--dispositions FILE] [--json]` evaluates supplied cause bindings and dispositions without
  persisting or authorizing them.
- Baseline precedence is explicit `--base`, generation intent, current work interval, delivery
  evidence, Story base, then `HEAD`; the selected source is reported. When `--base` is combined
  with Story/phase selection, that context must still resolve and is not silently discarded.
- Initial fallback granularity is intentionally conservative: one exact resource-level region per
  repository change-set entry. It does not claim symbol or semantic segmentation.
- Region identity is bound to the exact repository-change-set compatibility subject and exact path,
  operation, mode, object/content identity available from that change set.
- All changed resources are conservatively in scope and material by default; ownership is not
  inferred. The foundation does not silently dismiss formatting, generated files, tests,
  configuration, documents, or binaries as nonmaterial.
- Cause kinds, relationship kinds, and dispositions are closed vocabularies. Assurance,
  availability, and diagnostic-code registries remain P0 work.
- Coverage evaluation is pure and deterministic. Missing, stale, mismatched, invalid, or
  unconfirmed cause data remains unresolved.
- AST is not invoked and no model is invoked. Unsupported source remains exactly represented by
  the repository change set at resource granularity; source expansion uses ordinary repository
  tools.

### Explicitly not implemented by the foundation

- no cause, disposition, graph, packet, walkthrough, replay, decision, or receipt is written;
- no phase publication, submission, approval, gate, or Git transaction is changed;
- no record is promoted to authority merely because it came from `--bindings` or `--dispositions`;
- no `bind`, `deviate`, `split`, `packet`, or CMP-specific `approve` mutation exists;
- no region is classified as a deterministic transformation without a reviewed receipt protocol;
- no symbol-level, hunk-level, semantic, dependency-edge, or AST-derived completeness is claimed;
- no cause-to-code graph, canonical Story replay, model walkthrough, selective invalidation, or
  comprehension receipt exists;
- no legacy repository is backfilled and no existing Story is enrolled;
- no failure from this foundation can block ordinary file-based work or governed publication.

Until cross-platform determinism, packaged npm/VSIX loading, oversized/escaped-input refusal, and
explicit zero-model/zero-AST tripwires pass, treat this as an in-progress implementation tranche,
not a shipped product claim.

## Verified implementation status

The 2026-08-31 audit compared the complete 2,952-line CMP v1 specification with the executable
runtime, command registry, schema registry, gateway, packaged skills, VS Code extension, and tests.
Its conclusion is intentionally unambiguous:

> **CMP v1 is not complete. The current release contains a credible read-only diagnostic pilot,
> not governed comprehension authority or explanation-completeness enforcement.**

The pilot may calculate a `complete` diagnostic result from a self-consistent caller-supplied
bundle, but that result always remains `authoritative: false`, `lifecycleGate: false`, and
`authority: unverified-observation`. No lifecycle consumer may treat the diagnostic `verdict` alone
as permission to submit, approve, publish, or merge.

| Corrected phase | Verified status | Present now | Missing before the phase can exit |
|---|---|---|---|
| P0 — contracts and reads | **Partial** | Conservative resource regions, closed cause/relationship/disposition vocabularies, bounded diagnostic validation, `regions`, and `check` | Assurance/availability/refusal registries, authority ADRs, cross-platform corpus, isolated npm/VSIX proof, and explicit zero-model/zero-AST/zero-lifecycle tripwires |
| P1 — pilot and storage decision | **Not started** | No durable state; only caller-supplied diagnostic input | Measurements, content-free metrics, storage/retention/privacy decision, record-mode preview, migration prototype, and reviewed rollout decision |
| P2 — governed cause recording | **Contract fragments only** | Cause, binding, disposition, and transformation-receipt validators over untrusted diagnostic input | Trusted authority lookup, durable versioned records, migrations, proposal/confirmation/supersession, recovery, and incorporation into the existing review transaction |
| P3 — intent graph and replay | **Not implemented** | A future operation vocabulary and roadmap only | Typed graph/index, bounded bidirectional queries, CMP gateway planner, exact expansion, deterministic replay, and reverse-convergence provenance |
| P4 — walkthroughs | **Not implemented** | None | Typed claims, deterministic validators, model-draft boundary, dual hashes, evidence validation, staleness, and revalidation receipts |
| P5 — enforcement | **Blocked by prerequisites** | None; ordinary publication is deliberately unchanged | Universal lifecycle Candidate, existing-review-subject binding, existing approval/publication integration, projected receipt, recovery, and opt-in creation-pinned enforcement |
| P6 — VS Code, learning, brownfield | **Not implemented** | Help content and generic `/sf-inspect comprehension` routing only | Leased snapshot slice, Comprehension Center, navigation, replay/walkthrough/staleness views, lessons, touched-area policy, backfill, accessibility, and large-repository hardening |

### Explain-change and intent-trace boundary

The registered `intent.trace` phrase family (`why does this code exist`, `trace the intent`, and
`which decision produced this`) is not proof that CMP explanation exists. It has no CMP graph,
bounded CMP read planner, or exact cause-to-code/code-to-cause projection behind it. The future
public surface remains namespaced:

```text
singularity-flow comprehension explain clause <CLAUSE-ID>
singularity-flow comprehension explain file <PATH>
singularity-flow comprehension explain symbol <SYMBOL-ID>
singularity-flow comprehension explain change <REGION-ID>
singularity-flow comprehension explain refusal <REFUSAL-ID>
singularity-flow comprehension explain generation <NUMBER>
singularity-flow comprehension explain test <TEST-ID>
```

Until P3 lands, `/sf-regression-investigate`, `/sf-logs`, and `/sf-review` remain adjacent tools for
regression analysis, command history, and diff review; none of them is a substitute for governed
code-to-intent explanation.

### Audit evidence

Evidence on `main@3b5d79e6`:

- 19/19 focused CMP contract and command tests passed;
- 60/60 combined CMP, command, help, and packaged-skill tests passed;
- 3/3 focused VS Code Help Center and `@sflow` tests passed;
- VS Code type checking passed;
- the product check passed 1,047 checks across 135 skills, two agents, and one extension, with only
  pre-existing vocabulary advisories;
- npm dry-run packaging included the CMP command, contracts, roadmap, help topic, and inspect skill.

This evidence proves the observe-only pilot and its packaging boundary. It does not satisfy the CMP
v1 release criteria, any enforcement acceptance criterion, or a native VS Code Comprehension Center.

### Tracked implementation gaps

| Backlog ID | Required work | Dependency/exit evidence |
|---|---|---|
| `CMP-P0-001` | Finish the read-only foundation and correct the misleading `--phase` recovery text | Cross-platform deterministic corpus; isolated npm/VSIX loading; explicit no-model/no-AST/no-write/no-lifecycle tripwires |
| `CMP-P1-001` | Decide storage, retention, privacy, metrics, and creation-pinned `off`/`record` rollout | Approved ADRs, migration prototype, measured budgets, and independent pilot review |
| `CMP-P2-001` | Add governed cause proposals, confirmations, terminal dispositions, and narrow transformation authority | Durable schemas/migrations plus authority, staleness, recovery, ref-race, and adversarial-laundering tests |
| `CMP-P3-001` | Implement the intent-indexed graph and `comprehension explain` reads | Bidirectional query parity, bounded exact handles, cache rebuild, gateway no-extra-tool, and unavailable-structure tests |
| `CMP-P3-002` | Implement deterministic comprehension replay without colliding with SGOS Process replay | Fresh-export hash stability, ordering, refusal/repair, reverse-convergence, recovery, and transcript-exclusion tests |
| `CMP-P4-001` | Implement typed walkthroughs, validators, exact expansion, and selective/conservative staleness | Counterfeit-model, prompt-injection, malformed/overflow, Candidate/evidence/structure drift, and zero-model tests |
| `CMP-P5-001` | Integrate CMP into the single existing Candidate/review/approval/publication transaction | `SGOS-P0-001`, every-workflow lifecycle matrix, remote rejection/push recovery, crash/retry, and fresh-export receipt verification |
| `CMP-P6-001` | Add the leased VS Code Comprehension Center and learning experience | Slice lease/disposal, stale-response, multi-root, keyboard/screen-reader, offline/office-proxy, and large-tree tests |
| `CMP-P6-002` | Add touched-area brownfield policy and labelled historical backfill | No-full-backfill compatibility, rename/move/touch fixtures, and no-fabricated-history tests |

## Validated reuse map

CMP must extend the following current authorities rather than copying them.

| Need | Existing implementation | Reuse decision |
|---|---|---|
| Exact changed-resource set | `src/repository-change-set.mjs` (`buildRepositoryChangeSet`, `verifyRepositoryChangeSetIntegrity`) | Build fallback regions from this canonical change set. Do not add another Git diff parser. |
| Immutable Candidate contract | `src/sgos/contracts.mjs` (`createCandidateSnapshot`, `validateCandidateSnapshot`) | CMP authority must bind the same Candidate hash. The observe-only bridge may label a repository change-set subject, but it is not the universal publication Candidate. |
| Candidate storage and verification | `src/sgos/runtime.mjs` (`putSgosCandidateSnapshot`, `readSgosCandidateSnapshot`) | Reuse after the Story lifecycle is routed through the SGOS Candidate boundary. Do not create a CMP Candidate store. |
| Clause/path claims | `src/specifications.mjs` (`evaluateSpecCoverage`) | Import approved clause claims and exact changed paths. CMP cause coverage must not redefine specification coverage. |
| Deterministic facts and human adjudication | `src/convergence.mjs` | Reuse the distinction between deterministic facts, assisted candidates, and authoritative adjudication. Missing trace evidence is not proof of missing behavior. |
| Story approval and publication | `src/state.mjs` (`submitPhase`, `approvePhase`, `publishGeneration`) | Extend the existing review subject and transaction after the universal Candidate bridge. Never implement `comprehension approve` as a second authority path. |
| Lifecycle history | workflow history, lifecycle events, Story lineage, SGOS lineage records | Build replay as a projection over existing immutable facts. Do not persist a second competing history. |
| Schemas and migration | `src/schema-migrations.mjs` | Every durable CMP family uses `currentSchemaVersion`, a reader, migration, golden fixture, and unknown-newer refusal. Computed diagnostics remain schema-transient. |
| Global documentation explanation | `src/commands/explain.mjs` and `help.explain` gateway planner | Preserve `sflow explain` as global, repository-independent documentation help. CMP explanation is namespaced under `comprehension`. |
| Model-facing host | `src/gateway/` registry, planners, handles, and result contracts | Add bounded read projections first. Mutations use plans, existing confirmation/authority, and the existing five gateway tools; CMP does not add a tool per operation. |
| Leased IDE state | `apps/vscode/src/state.ts` (`acquireSlices`) and `apps/vscode/src/cli/snapshot.ts` (`SnapshotSlice`) | Add a separately leased `comprehension` slice only when a CMP panel is visible; release it when the consumer closes. |
| Optional structure | current AST status/context/query and evidence replay paths | Structural corroboration consumes available facts with honest assurance. `unavailable` falls back to exact source; it is not a CMP failure by default. |

The universal Candidate dependency is already tracked as
[`SGOS-P0-001`](SGOS-PENDING-WORK.md#p0--release-and-portability). WEL has the same lifecycle
dependency in [`WEL-P1-002`](WEL-PENDING-WORK.md#p1--trust-and-enforcement-prerequisites). CMP must
not solve either dependency with a private bridge.

## Critical gaps and corrections

### 1. There is no universal Story Candidate yet

The SGOS runtime has a strong Candidate Snapshot contract, but ordinary Story generation currently
uses repository change sets and generation records. The CMP draft assumes one Candidate authority
already governs every publication. That assumption is false.

**Correction:** record-only CMP may bind a clearly labelled diagnostic subject derived from the
exact repository change set. Enforcement requires `SGOS-P0-001`; at that point CMP records bind the
same persisted Candidate used by verification, review, and publication. A compatibility projection
must never be labelled as the universal Candidate.

### 2. `sflow explain` is already a public command

The current command answers global, deterministic documentation questions without requiring a
repository. Reinterpreting `sflow explain clause ...` as a repository query would be an ambiguous
breaking change and would invalidate installed help examples.

**Correction:** use `sflow comprehension explain clause <ID>` and corresponding namespaced forms.
Keep `sflow explain` and `help.explain` compatible. Natural-language resolution may offer a CMP read
when a repository subject is explicit, but it must not silently switch command meaning.

### 3. The proposed packet approval is a duplicate authority

The draft both says to reuse approval machinery and proposes `sflow comprehension approve` plus a
new `comprehension-decision`. That creates two ways to approve the same bytes and raises unresolved
questions about thresholds, authority groups, rejection, invalidation, recovery, self-approval,
remote publication, and transaction rollback.

**Correction:** the existing phase submission assembles one expanded review subject containing the
Candidate hash and, when policy requires it, the CMP packet hash. The existing `approvePhase`
decision binds that subject. A CMP receipt projects the existing decision; it does not mint another
decision. No CMP-specific publisher is permitted.

### 4. Replay names two different operations

SGOS already uses replay to invalidate and re-execute a Process suffix. CMP uses replay to mean a
read-only narrative projection of Story history. A top-level `sflow replay` would make a read and a
consequential mutation appear interchangeable.

**Correction:** expose the read as `sflow comprehension replay <WORK-ID>`. Keep SGOS Process replay
under its current Process namespace and confirmation protocol. Canonical comprehension replay is
derived from existing Story/lifecycle/SGOS records; `comprehension-replay-event` is a projection
shape unless an ADR proves that a genuinely missing authoritative event must be recorded.

### 5. Region granularity is underspecified

"Smallest stable semantic unit" is not an algorithm. Diff hunks depend on diff settings, line ranges
move, AST adapters differ by language and assurance, document/config parsers disagree about
boundaries, and rename/refactor lineage can be many-to-many. Assigning `structurally-derived` to an
unstated heuristic would create false precision.

**Correction:** begin with canonical resource regions. Introduce finer adapters one at a time with a
versioned segmentation algorithm, deterministic corpus, overlap/coverage rules, adapter identity,
and fallback contract. A fine region must cover exact bytes owned by the parent resource region;
uncovered bytes remain material. Cross-Candidate equivalence is explicit lineage, never a guessed
reuse of an ID.

### 6. Materiality cannot rely on convenient labels

The draft lists categories but does not specify how a byte is classified, what happens when
classifiers disagree, or whether tests, generated output, policy, and documents count. A permissive
classifier could erase the very changes CMP is intended to expose.

**Correction:** every author-owned change is material by default. A region becomes mechanical only
through a reviewed deterministic-transformation receipt. Policy controls may require additional
corroboration for selected path classes, but absence of an adapter never makes a change
nonmaterial.

### 7. Transformation receipts need a real verifier boundary

An executable/configuration hash and exit code do not prove a transformation was semantic-free.
The draft's example does not define input capture, environment/toolchain identity, output capture,
network/filesystem scope, verifier independence, or what `semanticChange: false` proves.

**Correction:** before accepting this disposition, define a separately reviewed transformation
profile that binds exact input and output manifests, tool artifact, configuration, invocation,
environment, allowlisted path set, and deterministic verifier result. A formatter receipt may prove
only the properties its verifier actually checks. Until then, those changes require ordinary causes.

### 8. Several dispositions are impossible in a final Candidate

`revert`, `excluded-from-publication`, and often `split` describe a repair action, not a valid state
of a region that remains in the final Candidate. `legacy-untouched` cannot describe a changed region.
Counting those labels as coverage would allow unexplained bytes to publish.

**Correction:** distinguish planning disposition from terminal Candidate disposition:

- `explained`, `approved-deviation`, and a verified `deterministic-transformation` may satisfy final
  coverage;
- `revert` and `excluded-from-publication` are resolved only after the region disappears from the
  recomputed Candidate;
- `split` is resolved only after removal from this Candidate and an exact target-work receipt;
- `legacy-untouched` belongs to a brownfield inventory, never the current changed-region manifest;
- `unresolved` always remains incomplete.

### 9. AST optionality must be stronger than a statement of intent

The draft says structure is optional, but structural graph, symbol queries, walkthrough validation,
and its thin pilot assume symbol extraction. On many repositories current assurance is text-only or
preview-grade.

**Correction:** every structural field carries availability and assurance. Exact resource/source
expansion is the universal floor. Missing, unsupported, stale, or degraded AST returns
`unavailable` and cannot establish structural corroboration, but does not block record mode or
ordinary work. A policy may require a reviewed structure adapter only for explicitly enrolled new
Stories after readiness proves it is installed and current.

### 10. Rollout conflicts with brownfield adoption

The founding publication invariant is global, while the brownfield section allows unexplained
legacy code and incremental adoption. The draft does not specify enrollment, config ownership,
in-flight Story behavior, downgrade, rollback, or what happens when CMP itself is unavailable.

**Correction:** use the explicit modes below. Enrollment is pinned when a new Story is created.
Legacy and in-flight Stories retain their pinned mode. No upgrade changes their authority. Touched
legacy bytes are current regions only for an enrolled Story; untouched inventory remains labelled
without fabricated history.

## Corrected constitutional invariants

1. **One exact subject.** Every CMP authority record binds the exact universal Candidate used by
   verification and publication. Before that bridge exists, CMP output is diagnostic only.
2. **Complete exact byte ownership.** Region adapters form a deterministic, non-overlapping
   ownership projection over every author-owned changed resource. Unowned or ambiguously owned bytes
   remain unresolved.
3. **Conservative materiality.** Every author-owned change is material unless a reviewed
   transformation protocol proves the narrower claim needed to classify it as mechanical.
4. **Terminal coverage only.** A final Candidate is complete only when every current material region
   is explained, an approved deviation, or covered by a valid deterministic-transformation receipt.
   A requested revert/exclusion/split is not coverage until the Candidate is recomputed.
5. **Governed causes only.** A cause reference resolves to a current approved/human-authoritative
   record of a registered kind whose subject and scope cover the Candidate. Free text is presentation.
6. **Models cannot promote claims.** A model may propose bindings, grouping, or prose. It cannot set
   materiality, validation, freshness, approval, evidence assurance, or publication verdicts.
7. **One decision and one publisher.** CMP extends the existing phase review subject, approval
   decision, publication transaction, pending-push recovery, and receipt lineage. It creates no
   alternate approval or Git writer.
8. **Replay is a projection.** Canonical Story comprehension replay is regenerated from existing
   typed authoritative records. It cannot rewrite reverse-converged intent as preplanned intent.
9. **Structure is optional and typed.** Structural claims resolve against the exact Candidate with
   their real assurance, or remain unavailable. Exact source/diff access is always retained.
10. **Unknown is not pass.** Missing records, stale hashes, ambiguous region lineage, unsupported
    adapters, unavailable evidence, or invalid receipts stay visible and cannot increase assurance.
11. **Approval means accountability, not cognition.** The existing authorized decision proves which
    exact review subject was decided; no score or receipt claims attention, comprehension, or memory.
12. **Brownfield history is not invented.** Untouched legacy code may remain `legacy-unexplained`.
    Current changes receive current causes; historical backfill has separately labelled assurance.
13. **Caches have no authority.** Graph, symbol, query, replay, and IDE caches are rebuildable and
    Candidate/policy/adapter keyed. A cache miss or stale cache never changes a governing verdict.
14. **A refusal is recoverable.** Every refusal identifies exact unresolved regions, stable reason
    codes, and the smallest legal repair without modifying the Candidate.

## Authority and storage design

### Record ownership

| Information | Owner | Storage class | Notes |
|---|---|---|---|
| Candidate and resource manifest | existing SGOS/lifecycle Candidate authority | immutable authority | CMP references its hash; it never copies the Candidate into a new authority family. |
| Region manifest | CMP, derived from exact Candidate and versioned adapter set | immutable authority only in `record`/`enforce`; computed diagnostic in `off` | Recalculation must reproduce the same bytes on supported platforms. |
| Cause source | existing specification, clarification, decision, defect, recovery, risk, approval, or other registered authority | existing immutable authority | `cause-ref` should normally be a typed projection/reference, not a duplicate statement record. |
| Cause binding and terminal disposition | CMP | immutable proposal/decision record with supersession | Model proposals and human-confirmed bindings are distinct states and hashes. |
| Transformation receipt | reviewed verifier authority | immutable evidence/authority according to its trust profile | Self-report from the transforming tool is insufficient. |
| Graph, replay, and structural view | CMP projection | evidence/large object or rebuildable cache | Graph edges cite authority; the graph itself does not create it. |
| Walkthrough prose | presentation/evidence | large object | Typed claims and their validation are separate from prose bytes. |
| Packet | existing phase review assembly | immutable review subject | It includes CMP hashes when enrolled; it is not a parallel submission. |
| Approval | existing Story approval authority | existing immutable decision | The exact expanded review subject is bound by `approvePhase`. |
| Receipt | existing publication lineage plus CMP projection | immutable projection/receipt | It cannot exist before the exact publication transaction succeeds. |
| IDE/query index | local runtime | operational cache | Repository-local, bounded, content-free metrics only, safe to delete and rebuild. |

### Write protocol

Durable CMP authority is permitted only after a storage ADR chooses its exact paths and transaction
boundary. The protocol must:

1. freeze and re-read the exact Candidate;
2. compute region/coverage records using the current registered schema and adapter identities;
3. stage immutable records and reserve their hashes through the existing authority-store pattern;
4. add their hashes to the existing phase review subject;
5. invalidate earlier CMP projections and approval when any bound input changes;
6. publish through the existing governed Git transaction;
7. retain an exact pending-publication marker when ref advancement or push fails;
8. recover by pushing the recorded commit or recomputing against a new Candidate, never the ambient
   current `HEAD`.

Large source, graph, evidence, and prose payloads remain outside small authority records and are
referenced by digest. Operational caches belong under the existing local runtime boundary, not the
governed repository tree. No prompt, transcript, hidden reasoning, credential, absolute home path,
or raw identity is required for CMP authority.

## Planned rollout modes (not implemented)

The future CMP configuration contract has exactly three product modes. The current code has no CMP
mode reader, Story pin, or enrollment behavior; it exposes only explicit observe-only commands.

| Mode | Behavior | Publication effect |
|---|---|---|
| `off` | No automatic CMP computation. Explicit read-only `comprehension regions/check` remains available. | None. This is the default before the pilot completes and for existing/in-flight Stories. |
| `record` | Compute and store diagnostics/projections, expose review UI and metrics, but label missing or invalid explanation as non-blocking. | None. This may become the default for newly created Stories only after the pilot exit gates pass. |
| `enforce` | Include the current CMP manifest/coverage/packet in the existing review and publication subject. | Refuse through the existing gate when enrolled policy is not satisfied. Unavailable until every enforcement prerequisite below passes. |

Rules:

- repository configuration expresses the allowed mode; Story creation pins the effective mode and
  policy hash;
- upgrades preserve the pinned mode of existing Stories;
- `record` cannot be interpreted as a soft pass and cannot mint a comprehension receipt;
- `enforce` is not a hidden fallback when config is malformed; readiness refuses enrollment;
- changing allowed modes is a governed configuration change with preview, exact confirmation,
  rollback, and state-branch projection;
- withdrawing enforcement applies only to future Stories unless an authorized recovery process
  explicitly amends the current Story law;
- AST, model, cache, or IDE unavailability never changes the pinned mode silently.

`record` becomes a product default only after P1 pilot evidence is approved. `enforce` remains
unavailable until P5 and specifically until `SGOS-P0-001` is complete.

## Delivery plan

### P0 — contract correction and read-only foundation

**Goal:** establish a deterministic vocabulary and exact fallback without changing lifecycle state.

Deliverables:

- this corrected roadmap and authority-flow ADR drafts;
- conservative resource-region and manifest contracts;
- closed cause, relationship, disposition, assurance, availability, and refusal vocabularies;
- pure coverage validation over caller-supplied bindings/dispositions;
- `comprehension regions` and `comprehension check` read commands;
- baseline resolver with explicit `--base`, safe active-generation selection, and disclosed `HEAD`
  fallback;
- no-model, no-AST, no-write, no-gate boundaries.

Acceptance criteria:

- add, modify, delete, rename, mode change, symlink, binary, unsupported source, and dirty working-tree
  fixtures produce stable sorted output;
- the same exact subject produces the same manifest on macOS, Linux, and Windows;
- subject or changed bytes produce a different manifest and make prior supplied bindings stale;
- all changed resources are material unless an explicit future receipt protocol says otherwise;
- normal Story publication and all existing commands behave identically when CMP is unused;
- `sflow explain` still works outside a repository.

Required tests:

- contract and canonicalization unit tests;
- repository-change-set adapter tests for every Git status/mode case;
- malformed/escaped path, digest mismatch, duplicate ID, unsupported schema, and oversized input tests;
- boundary tripwires proving zero model calls, zero AST calls, zero writes, and zero lifecycle calls;
- CLI JSON/text parity and packaged npm/VSIX tests.

### P1 — pilot, measurement, and storage decision

**Goal:** prove whether region/cause diagnostics are useful and safe before automatic recording.

Deliverables:

- reviewed region/materiality/lineage ADR;
- authority/storage/retention/privacy ADR;
- exact corpus containing real small, large, generated, binary, rename, refactor, config, test, and
  document changes;
- content-free local work metrics for region counts, unresolved reason classes, adapter availability,
  latency, cache behavior, and storage bytes;
- record-mode preview and migration prototype behind an experimental flag;
- office/offline/proxy and cross-platform release exercise.

Acceptance criteria:

- reviewed corpus has zero false `complete` verdicts;
- every false positive/negative materiality finding has a stable fixture and documented disposition;
- performance and storage ceilings are measured on named supported-machine classes;
- no raw code, cause statement, path, work ID, identity, prompt, or transcript is present in metrics;
- migration round trips preserve old records without increasing assurance;
- an independent review approves whether newly created Stories may default to `record`.

Required tests:

- deterministic corpus replay on every supported OS/Node version;
- concurrent append, interrupted write, retention, clear, disabled-metrics, and corrupt-cache tests;
- fresh clone/package/VSIX loading with no source-tree dependency;
- existing and in-flight Story compatibility tests.

### P2 — governed cause recording and terminal dispositions

**Goal:** persist record-mode proposals and human decisions without introducing another approval.

Deliverables:

- typed references into current authoritative cause families;
- immutable binding proposal, human confirmation, supersession, and terminal disposition contracts;
- placeholder rejection and scope/subject/authority/freshness validation;
- exact cause-grouped diagnostic packet incorporated into, but not authorizing, the normal review
  projection;
- reviewed deterministic-transformation profile for at least one narrow transformation, or an
  explicit decision to defer that disposition.

Acceptance criteria:

- a model proposal remains visibly unconfirmed and cannot satisfy coverage;
- changing the Candidate, policy, cause record, binding, or confirmation stales the affected result;
- `revert`, `excluded`, and `split` remain unresolved until recomputation proves the byte is absent;
- one actor cannot use a free-text placeholder or a forged cause hash to obtain completion;
- record mode remains non-blocking and uses the existing Story transaction for any durable write.

Required tests:

- missing, stale, revoked, wrong-subject, wrong-scope, duplicate, counterfeit, and placeholder causes;
- proposal/confirmation separation and self-approval policy cases;
- supersession, invalidation, crash recovery, ref-race, and push-failure cases;
- adversarial transformation laundering fixtures.

### P3 — intent graph and deterministic comprehension replay

**Goal:** answer bounded cause-to-code and code-to-cause questions from existing records.

Deliverables:

- typed graph nodes/edges that reference existing authority rather than embedding claims;
- Candidate/policy/adapter-keyed incremental query index;
- `comprehension explain` for clause, file, symbol, change, refusal, generation, and test IDs;
- `comprehension replay` as chronological and focused projections over existing lifecycle/SGOS facts;
- explicit reverse-converged and post-hoc provenance labels.

Acceptance criteria:

- cause-to-code and code-to-cause queries return the same exact bounded subject;
- missing edges and unavailable structure are shown, not inferred;
- rebuilding after cache deletion returns byte-equivalent authority projections;
- replay never changes Process state and cannot be confused with SGOS Process replay;
- a transcript or model summary cannot appear as an authoritative event.

Required tests:

- graph determinism, cycle, orphan, duplicate, stale edge, cache poisoning, and size-limit fixtures;
- lifecycle event ordering, same-timestamp tie-breaking, reverse convergence, refusal/repair, recovery,
  and missing-history fixtures;
- command collision tests for existing global help and SGOS replay;
- gateway bounded-output and no-extra-tool tests.

### P4 — typed walkthroughs and selective invalidation

**Goal:** allow useful narration without mistaking prose for facts.

Deliverables:

- typed structural fact, diff fact, evidence-supported claim, human judgment, and model advisory
  contracts;
- deterministic validators per claim class;
- optional model draft path whose output is untrusted structured input;
- dual binding to exact Candidate and exact claim/prose bytes;
- dependency-aware staleness and revalidation receipts;
- exact source expansion for every claim.

Acceptance criteria:

- a nonexistent or stale symbol cannot pass structural validation;
- a missing/stale evidence record cannot pass an evidence-supported claim;
- human judgment and model advisory remain visibly distinct from verified facts;
- missing AST yields `unavailable`, not a false failure or pass;
- a dependency change invalidates only proven dependants where precision exists and conservatively
  invalidates the larger parent when it does not.

Required tests:

- counterfeit model, prompt injection, malformed draft, output overflow, cancellation, timeout, and
  zero-model fallback tests;
- claim-class validator, Candidate drift, prose drift, evidence drift, structural drift, and
  selective/conservative invalidation tests;
- source expansion path/symlink/traversal and binary safety tests.

### P5 — universal Candidate integration and opt-in enforcement

**Goal:** make completeness a real gate without creating a second authority path.

Prerequisites:

- `SGOS-P0-001` is complete and every selected lifecycle publishes the same exact Candidate;
- P0–P4 migration, privacy, recovery, cross-platform, and adversarial evidence is approved;
- a supported cause/region profile and recovery journey are installed and readiness-tested.

Deliverables:

- CMP hashes in the existing phase review subject and approval decision;
- coverage/quality checks in the existing submission/publication gate;
- one projected comprehension receipt bound to the existing publication transaction;
- refusal explanations and exact repair/recompute paths;
- opt-in `enforce` enrollment for newly created Stories only.

Acceptance criteria:

- no lifecycle can publish a different tree from the Candidate whose CMP packet was reviewed;
- no parallel CMP approval, publisher, scheduler, or recovery log exists;
- stale approval, changed Candidate, ref advance, push failure, interruption, and retry remain bound
  to the exact recorded transaction;
- unavailable CMP infrastructure refuses enrollment before Story creation, not ordinary file work;
- disabling CMP for future Stories cannot weaken an already pinned enforced Story.

Required tests:

- end-to-end creation, generation, submit, review, approve, publish, fresh-export verification, and
  receipt replay;
- every existing workflow and publication path, including Ad Hoc reverse convergence;
- push hooks, remote rejection, pending publication recovery, competing writers, process death, and
  exact rollback;
- legacy/off/record/enforce matrix and downgrade/upgrade compatibility.

### P6 — VS Code, learning, brownfield, and production hardening

**Goal:** make the proven contracts understandable and usable without changing their authority.

Deliverables:

- leased `comprehension` snapshot slice and cause-grouped review panel;
- exact diff/source expansion, clause/file/available-symbol navigation, replay timeline, unknowns,
  stale claims, and repair actions;
- `sf-learn` lessons in disposable examples, never the live governed repository;
- touched-area brownfield inventory and separately labelled historical backfill workflow;
- accessibility, localization readiness, packaging, retention, and operational support material.

Acceptance criteria:

- opening ordinary SFlow views does not load CMP graph/walkthrough payloads;
- each panel acquires/releases its own slice lease and stale responses cannot overwrite current state;
- every UI mutation is an existing CLI plan/confirmation, not webview authority;
- untouched legacy code stays labelled without blocking; changed enrolled regions follow current law;
- backfill distinguishes `historically-confirmed`, `historically-inferred`, and `unknown`;
- keyboard, screen-reader, multi-root, offline, office proxy, missing initialization, and large-repo
  journeys pass.

Required tests:

- extension-host lease lifecycle, cancellation, rapid repository switch, stale response, memory, and
  large-tree tests;
- CLI/gateway/UI result and refusal-code parity;
- brownfield rename/move/touch/backfill and no-fabricated-history fixtures;
- npm/VSIX content, minimum/current VS Code, installer, upgrade, reset, and fresh-machine exercises.

## Public interface plan

### CLI

Available pilot reads:

```text
singularity-flow comprehension regions [--base REVISION] [--json]
singularity-flow comprehension check [--base REVISION]
  [--bindings FILE] [--dispositions FILE] [--json]
```

Future read surfaces remain under the namespace:

```text
singularity-flow comprehension region <REGION-ID>
singularity-flow comprehension explain <clause|file|symbol|change|refusal|generation|test> <ID>
singularity-flow comprehension replay <WORK-ID> [--focus TYPE:ID]
singularity-flow comprehension walkthrough show <ID>
singularity-flow comprehension packet <CANDIDATE-ID>
singularity-flow comprehension receipt <CANDIDATE-ID>
```

Future mutations should be expressed as previewed plans through the existing lifecycle and approval
commands. The submitted draft's top-level `explain`, top-level `replay`, and
`comprehension approve` forms are rejected for compatibility and authority reasons.

### Gateway

- Keep the existing five model-facing tools and operation registry.
- Add model-free, bounded read planners for region, coverage, explanation, replay, and packet
  projection only as their corresponding phases land.
- Handles bind repository, subject, Candidate, policy, adapter set, and index revision.
- A model may request a binding proposal plan, but cannot approve, confirm, persist authority, or
  execute publication.
- Every response uses stable result/reason codes, exact references, byte ceilings, and explicit
  `unavailable` fields.
- No full graph, source tree, transcript, or raw evidence is injected into a prompt by default.

### VS Code

- Add `comprehension` to `SnapshotSlice` only with a dedicated CLI snapshot projection.
- The panel that needs the slice calls `acquireSlices(['comprehension'])` and disposes the lease when
  hidden or closed.
- Initial view is a compact summary: Candidate, region/coverage counts, unresolved reason groups,
  freshness, and availability.
- Expand on demand by cause, resource, exact diff, claim, evidence, or replay event.
- All edits use native reviewed forms and existing command plans; webview state is never authority.
- If the extension cannot load the slice, the CLI remains fully usable and the failure cannot block
  a non-enrolled Story.

## Migration and compatibility

- Register only record families that are actually durable. Computed coverage results, CLI render
  models, and cache entries remain schema-transient.
- Each durable family has `currentSchemaVersion`, exact canonicalization, self-hash rules, migration,
  golden fixtures, a previous-version reader test, and unknown-newer-version refusal.
- Migration may preserve or lower assurance; it must never invent a Candidate binding, confirmation,
  structural fact, evidence result, approval, or receipt.
- Historical diagnostic outputs that predate the universal Candidate bridge remain labelled
  diagnostic and cannot be migrated into enforceable records by changing `schemaVersion`.
- Existing workflows and in-flight Stories retain their pinned CMP mode and policy. Missing CMP
  configuration means `off` for compatibility.
- Existing `sflow explain`, SGOS Process replay, phase approval, publication, and recovery command
  meanings remain unchanged.
- Existing AST-disabled/unsupported operation remains supported. A new adapter cannot retroactively
  change prior region IDs or assurance without creating new records.
- Old packages and state branches must remain readable during a documented mixed-version window;
  newer writers fail closed rather than partially updating old authority.
- Package and VSIX tests must load every registered schema/command without relying on a source
  checkout or absolute development path.

## Performance and privacy budgets

### Performance

- P0 work is proportional to the existing change set, not repository size, after Git supplies the
  comparison.
- Region and cause processing must be canonically streamed/sorted with explicit count, per-record,
  total-byte, depth, and diagnostic-output ceilings. The pilot bounds caller evidence files and
  record counts, but the repository change-set builder still hashes each changed or untracked file
  in full.
- Indexes are keyed by Candidate, policy, schema, and adapter-set hashes. They are incrementally
  reusable only when all keys match.
- A stale/corrupt/missing cache triggers bounded rebuild or `unavailable`; it never reuses an
  earlier verdict.
- No CMP graph, walkthrough, or replay payload is part of the core VS Code snapshot. Consumer-owned
  leases govern loading and release.
- P1 must publish measured cold/warm latency, peak memory, authority bytes, cache bytes, and Story
  start/submit overhead on named supported machines. Proposed release budgets are approved from
  those measurements rather than guessed in this roadmap.
- `record` default requires no material regression to non-CMP Story start and ordinary snapshot
  refresh. `enforce` requires an explicit latency SLO and timeout/recovery behavior approved in P5.

### Privacy and security

- CMP authority contains hashes, typed references, classifications, and accountable decisions; it
  does not require prompts, responses, transcripts, chain-of-thought, secrets, credentials, or
  home-directory paths.
- Local metrics contain only schema/time, mode, adapter/availability class, counts, reason classes,
  latency, and byte totals. They exclude code, prose, paths, IDs, Git identities, and individual
  productivity measures.
- Cause statements and walkthrough prose are content and follow repository evidence retention and
  access policy; they are never copied into content-free telemetry.
- Model-drafted input is untrusted data, bounded before parsing, stripped of instruction authority,
  and incapable of selecting tools, policy, approval, or verdicts.
- Exact source expansion uses verified repository-relative no-follow paths and bounded reads.
- External transport, centralized metrics, or organization analytics require a separate consent,
  privacy, retention, and threat review. They are not implied by CMP.
- Reviewers are never ranked by speed, clicks, time, acceptance rate, quiz score, or inferred
  comprehension.

## Risk register

| Risk | Severity | Failure mode | Required control/exit gate |
|---|---:|---|---|
| Non-universal Candidate | Critical | CMP approves one subject while a lifecycle publishes another | No enforcement before `SGOS-P0-001`; exact end-to-end Candidate transaction tests |
| Parallel approval/publisher | Critical | Conflicting authority and unrecoverable partial state | Reuse `submitPhase`/`approvePhase`/existing publisher; architecture test rejects second writer |
| Transformation laundering | Critical | Semantic changes are hidden as formatting/generated output | Default material; reviewed exact transformation profile; adversarial corpus |
| False completeness | Critical | Missing/invalid causes are counted as explained | Conservative unknown, closed vocabulary, authority/freshness checks, zero-false-complete corpus gate |
| Region identity churn | High | Review and causes stale on harmless tool/platform differences | Versioned adapter, canonical fixtures on every OS, explicit lineage rather than matching guesses |
| Disposition loopholes | High | `split`, `revert`, or `excluded` labels leave bytes in final Candidate | Recompute Candidate; only terminal present-region dispositions count |
| AST false authority | High | Preview/text facts are represented as semantic proof | Typed assurance/availability, exact fallback, explicit adapter readiness |
| Replay/history collision | High | Read projection is confused with Process re-execution or rewrites provenance | Namespaced command; existing records only; reverse-convergence labels |
| Command compatibility | High | Global help or SGOS commands change meaning | `comprehension` namespace and CLI compatibility tests |
| Brownfield surprise | High | Upgrade blocks existing work or fabricates historical causes | Creation-pinned modes; default off before pilot; explicit legacy labels |
| Stale/corrupt cache | High | Old graph/coverage is presented as current | Full subject keys, integrity checks, rebuildable cache, no cache authority |
| Storage and UI regression | Medium | Graphs slow every command/refresh and bloat state branches | Large-object separation, budgets, leased slice, P1 measurements |
| Model prompt injection | Medium | Generated prose attempts to change policy or tools | Untrusted structured input, no model judgment, bounded gateway, counterfeit-model tests |
| Privacy/surveillance | High | Source/prompts/identity or reviewer behavior enters telemetry | Content-free local metrics, prohibited-field tests, separate external-consent review |
| Migration assurance inflation | Critical | Legacy diagnostics become enforceable by migration | Explicit diagnostic provenance, migrations cannot mint authority, golden downgrade tests |

## Measurable completion criteria

CMP may be called complete only when all of the following are evidenced on the exact release commit:

1. One universal Candidate hash is used by region computation, verification, review, approval,
   publication, pending-push recovery, and the final receipt for every enrolled workflow.
2. A reviewed cross-platform corpus produces byte-identical region manifests and zero false
   `complete` verdicts.
3. Every current author-owned Candidate byte belongs to exactly one conservative region or one
   reviewed finer region; gaps and overlaps refuse.
4. Every terminally complete region resolves to current governed cause authority, an approved exact
   deviation, or a reviewed transformation receipt.
5. Impossible dispositions cannot satisfy a final Candidate while their bytes remain present.
6. Cause-to-code and code-to-cause queries agree on the exact Candidate and return bounded exact
   references without relying on grep, a model, or a transcript.
7. Canonical replay reconstructs the same ordered projection from a fresh Authority Store export and
   preserves post-hoc/reverse-converged provenance.
8. Every walkthrough claim has a type, exact dependencies, truthful assurance/availability, exact
   source expansion, and deterministic staleness behavior.
9. Missing AST, model, cache, network, IDE, or optional adapter cannot create a pass and cannot block
   ordinary non-enrolled work.
10. The existing phase decision binds the exact Candidate, policy, evidence, and CMP packet. No
    second approval or publication authority exists.
11. Ref advance, remote rejection, webhook failure, push timeout, crash, cancellation, and retry
    recover the exact recorded transaction without publishing ambient `HEAD`.
12. Legacy/in-flight/off/record/enforce compatibility and rollback journeys pass on Windows, macOS,
    and Linux.
13. CLI, gateway, and VS Code expose the same result/reason codes and cannot bypass one another's
    authority boundary.
14. The leased IDE slice demonstrates bounded cold/warm latency and releases memory/state after its
    last consumer.
15. Metrics and durable records pass prohibited-field scans for prompts, transcripts, secrets,
    absolute home paths, raw identities, and individual productivity measures.
16. Every durable schema passes current, previous, unknown-newer, corruption, migration, and packaged
    runtime tests.
17. Npm and VSIX artifacts, installers, a fresh clone, state-branch reuse, office proxy/offline cases,
    and minimum/current supported runtime matrices pass.
18. A signed release receipt binds the exact source commit, package artifacts, schema registry,
    migration goldens, test suites, platform evidence, supported profiles, and remaining exclusions.

## Maintenance

- This roadmap is the controlling delivery correction for the CMP v1 proposal. It does not by
  itself authorize `record` default or `enforce` implementation.
- When a phase starts, record its Story/branch, owner, dependency state, and target release here.
- Mark a phase complete only with landing commit, exact test/release evidence, and updated docs.
- Reconcile this file whenever [SGOS pending work](SGOS-PENDING-WORK.md),
  [WEL pending work](WEL-PENDING-WORK.md), Candidate publication, approval, schema, gateway, AST, or
  VS Code slice contracts change.
- Add newly discovered scope under a stable CMP backlog ID rather than silently broadening an exit
  gate.
