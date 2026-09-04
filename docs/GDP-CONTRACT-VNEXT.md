# Governed Delivery and Proof — corrected contract vNext

**Status:** accepted contract baseline; runtime implementation remains unavailable

**Baseline:** `main@70db564e`

**Program ID:** `GDP`

**Record namespaces:** `GDM` for delivery and `PFC` for proof

**Decision owner:** Singularity Flow repository maintainers

**Validation owner:** `test/gdp-contract-freeze.test.mjs`

**Decision date:** 2026-09-04

**Source proposal:** `SPEC-GDP-Governed-Delivery-and-Proof (1).md`

This document is the M0 correction layer for the source proposal. The proposal's requirements and
acceptance IDs remain useful, but this contract takes precedence wherever identity, ownership,
configuration, command, storage, migration, or recovery rules conflict. It does not install a GDP
runtime, register a durable writer, add a command, alter a workflow, or enable a gate.

The accepted delivery sequence is maintained in the
[GDP milestone roadmap](GDP-DELIVERY-ROADMAP.md). The exact reused contracts are pinned in
[`contracts/gdp/companion-lock.json`](contracts/gdp/companion-lock.json), and every proposed new
record family is classified in
[`contracts/gdp/record-family-catalog.json`](contracts/gdp/record-family-catalog.json).

## 1. Product decision

GDP is one program with two stable contract namespaces:

- `GDM` owns delivery selection, bounded delivery contracts, promotion, and presentation.
- `PFC` owns deterministic proof predicates, results, summaries, gaps, and invalidation.

GDP offers two delivery modes:

```text
workflow
outcome
```

`recommend` is not a mode. It is a read-only selection strategy. Auto is an execution pace, not a
third mode. Proof profile, delivery mode, execution provider, execution pace, and autonomy ceiling
remain independent axes.

The two modes converge on the existing SGOS Candidate, action authorization, approval authority,
and publication unit of work. Neither namespace owns a second Candidate, scheduler, evidence
authority, approval system, commit writer, push path, or recovery journal.

## 2. Corrected selection contract

The target configuration vocabulary is:

```yaml
delivery:
  selectionStrategy: recommend # recommend | fixed | human-choice
  defaultMode: outcome          # workflow | outcome; fallback only
  allowedModes: [outcome, workflow]
  defaultWorkflowProfile: feature
```

Rules:

1. `selectionStrategy` controls whether SFlow recommends, applies a fixed repository default, or
   requires a choice.
2. `defaultMode` is always one of `workflow | outcome`; it is never `recommend`.
3. `defaultWorkflowProfile` is a valid installed workflow ID. A proof profile such as `standard`
   cannot occupy this field.
4. Recommendation creates no Story, branch, Candidate, approval, authorization, or durable
   selection.
5. Selection is a human or existing policy authority decision bound to the recommendation plan and
   current repository/configuration identity.

### Smart Init v1 compatibility projection

Current `smart-init-policy` v1 records are not rewritten. A future v2 reader projects them as:

| v1 input | v2 projection |
|---|---|
| `delivery.defaultMode: outcome|workflow` | same `defaultMode`; `selectionStrategy: fixed` |
| `delivery.workflowProfile: standard` | `defaultWorkflowProfile: feature`, marked `legacy-standard-alias` |
| another installed workflow ID | same `defaultWorkflowProfile` |
| unknown workflow ID | `defaultWorkflowProfile: null`, status `unavailable`, explicit refresh decision required |
| `executionPace` | unchanged; remains independent of delivery mode |

New initialization may default to `selectionStrategy: recommend`, but migration cannot reinterpret a
previously accepted fixed selection as a recommendation. Any durable v2 rewrite requires a
configuration preview and exact confirmation through the existing configuration publication path.

## 3. Stable proof identity

The source proposal made Predicate Results and Proof Summaries reference the Passport while the
Passport referenced those results. The resulting hash graph cannot be constructed. GDP instead
introduces an immutable Proof Subject:

```text
Candidate
+ Completion Contract
+ Effect Policy
+ Proof Policy/Profile
+ WMM baseline reference or explicit unavailable state
+ Candidate WMM delta reference or explicit unavailable state
                       |
                       v
                Proof Subject hash
                       |
          +------------+-------------+
          |                          |
          v                          v
 Predicate Results              Signals / Gaps
          |                          |
          +------------+-------------+
                       v
                  Proof Summary
                       |
                       v
                 Change Passport
                       |
                       v
             Decision / Publication
```

Normative rules:

- Predicate Results, Signals, Gaps, invalidations, and Proof Summaries bind
  `proofSubjectSha256`, never the current `passportSha256`.
- A Change Passport binds exactly one Proof Subject and at most one current Proof Summary.
- Later evidence produces a new result/summary/Passport revision; it never mutates stored bytes.
- A Passport is an index and presentation aggregate. It cannot grant approval or publication
  authority.
- Semantic hashes exclude clocks, duration, hostname, process ID, checkout path, cache handles,
  transport state, and display prose unless a specification explicitly declares one as semantic.
- Operational receipts may contain those fields but cannot change the deterministic result hash.

The M0 draft shapes are closed by
[`schemas/gdp-contract-freeze.schema.json`](../schemas/gdp-contract-freeze.schema.json). They are
design contracts only and are deliberately absent from the production migration registry.

## 4. Authority and ownership

| Concern | Sole authority/writer | GDP role |
|---|---|---|
| Candidate bytes and identity | Existing SGOS Candidate lifecycle | Reference only |
| Workflow lifecycle | Creation-pinned workflow runtime | Project into obligations; never replace in place |
| Outcome local work | Existing Ad Hoc/Change Flight Plan boundary until promoted | Add Completion Contract and Passport later |
| Agent execution | SGOS GEU; v1 remains pinned, v2 is a later milestone | Reference execution/checkpoint records |
| World Model | WMB v4 state-branch authority and deterministic Candidate delta | Reference or label unavailable |
| Clause/witness observation | WEL | Consume without strengthening assurance |
| Exact checker and execution evidence | CAB after its own gates | Consume authenticated evidence |
| Schema compatibility | MIG migration registry | Register before first governed write |
| Human approval/risk decision | Existing approval and Action Authorization authorities | Reference exact decision |
| Git publication and recovery | Existing publication unit of work | Supply exact inputs only |
| Product telemetry | Existing privacy/consent boundary | Aggregate categories only; never proof |

Detailed authority consequences are accepted in
[ADR 0005](adr/0005-gdp-authority-and-compatibility.md).

## 5. Storage, branch, and retention contract

GDP uses logical planes, not a new remote branch:

| Plane | Canonical logical root | Authority |
|---|---|---|
| Subject | `singularity/work-items/<WORK-ID>/gdp/subjects/<family>/<sha256>.json` | Governed work branch |
| Evidence | `singularity/work-items/<WORK-ID>/gdp/evidence/<family>/<sha256>.json` | Governed work branch, append-only |
| Decision | `singularity/work-items/<WORK-ID>/gdp/decisions/<family>/<sha256>.json` | Governed work branch, existing human authority |
| Operational | `$GIT_COMMON_DIR/singularity-flow/gdp/operations/<SUBJECT>/<family>/<id>.json` | Machine-local recovery only |
| Projection | `.singularity-flow/gdp/cache/<SUBJECT>/...` | Disposable, never authoritative |

`<sha256>` is the 64-character lowercase hexadecimal payload digest. Paths are repository-relative
contracts; implementations must use the existing secure path and no-symlink primitives.

The state branch may carry an append-only derived discovery index and release-scoped gap snapshot,
but it cannot replace the exact Story/Outcome records. WMM remains reusable state-branch authority;
GDP stores only its pinned hash/reference. Evidence created after Candidate freeze is stored outside
the application-source Candidate manifest and is joined through the Proof Subject.

No record is deleted merely because a retention period expires. Expiry creates a reviewable
retention decision and keeps any pin required to verify a published Passport. Operational and cache
planes may be cleaned only when no active journal, authorization, Candidate, or recovery record
references them.

The identity and storage decision is accepted in
[ADR 0006](adr/0006-gdp-proof-identity-and-storage.md).

## 6. Command contract

Existing `start`, `run`, `review`, `phase`, `submit`, `approve`, `recover`, `auto`, `adhoc`,
`program`, `process`, `candidate`, `execution-unit`, and `wm` commands retain their current grammar.
GDP does not overload them during M0–M4.

Future GDP commands use explicit nouns:

```text
sflow delivery recommend --request-file <REPOSITORY-RELATIVE-FILE> --json
sflow delivery select --plan <REPOSITORY-RELATIVE-FILE> \
  --mode <workflow|outcome> --confirm-plan sha256:<64-hex> --json
sflow delivery promote <WORK-ID> --preview --json
sflow delivery promote <WORK-ID> --plan sha256:<64-hex> \
  --confirm-plan sha256:<64-hex> --json

sflow change status [WORK-ID] --json
sflow change show [WORK-ID] --json
sflow change next [WORK-ID] --json
sflow change evidence [WORK-ID] --json

sflow proof status <WORK-ID> --json
sflow proof explain <WORK-ID> <PREDICATE-ID> --json
sflow proof gaps <WORK-ID|--release> --json
sflow proof signals <WORK-ID> --json

sflow workflow migrate <WORK-ID> --to gdm-v1 --preview --json
sflow workflow migrate <WORK-ID> --to gdm-v1 \
  --plan sha256:<64-hex> --confirm-plan sha256:<64-hex> --json
```

Mutation rules:

- a preview is read-only and ends with “Nothing changed”;
- `--confirm-plan` must equal the current plan digest and `--plan`; a bare `--confirm`, yes/no, or
  copied stale digest is invalid;
- a confirmed plan is single-subject, single-repository-revision, single-configuration-revision,
  operation-specific, expiring, and one-time;
- paths must be repository-relative regular files and must not resolve through symlinks;
- commands never accept prompt or request bodies in argv, environment variables, or diagnostics;
- a stale plan returns the new read-only preview command, not a mutation command with a guessed
  digest;
- `decide` and `publish` remain product-language goals until their collision-free adapters are
  specified in GDP-M8. They are not new M0 commands.

## 7. Transaction and recovery order

Every future GDP mutation must use the existing subject lock, Candidate verification, and
publication unit of work in this order:

1. resolve the exact workspace, repository, subject, runtime, and configuration authority;
2. read and verify every plan input and reject a pending recovery;
3. acquire the existing bounded subject mutation lock;
4. re-read/CAS the subject and validate the exact one-time confirmation;
5. stage immutable subject/evidence/decision records and an operational journal;
6. verify closed schemas, hashes, references, budgets, protected paths, and Candidate identity;
7. commit the exact planned tree with existing governed trailers;
8. push the exact recorded commit through the existing publication transport;
9. publish existing state/ledger projections only where current policy requires them;
10. mark the journal complete and release the lock.

A failure before commit restores the captured preimage and leaves no authority. A failure after
commit retains the exact commit and pending publication marker. Recovery may push or reconcile only
that commit; it cannot use ambient `HEAD`. Consequential external effects are never automatically
repeated. Transport-indeterminate effects require reconciliation or a human decision.

Each refusal must contain a stable code, bounded metadata, what remained unchanged, preserved
Candidate/evidence references, and exactly one legal next action. It cannot include credentials,
remote URLs with user-info, raw prompt bodies, arbitrary terminal output, or home-directory paths.

The first reserved error vocabulary is:

```text
GDM_SELECTION_PLAN_STALE
GDM_SELECTION_CONFIRMATION_INVALID
GDM_PROMOTION_REQUIRED
GDM_PROMOTION_PLAN_STALE
GDM_MIGRATION_BOUNDARY_UNSAFE
GDM_MIGRATION_PLAN_STALE
GDM_PUBLICATION_RECOVERY_REQUIRED
PFC_PROOF_SUBJECT_INVALID
PFC_REFERENCE_CYCLE
PFC_SCHEMA_UNAVAILABLE
PFC_RECORD_TOO_LARGE
PFC_PREDICATE_INPUT_INVALID
PFC_PROOF_SUMMARY_STALE
PFC_RECOVERY_REQUIRED
```

Reservation does not make a code executable. A milestone that installs one must define its typed
metadata, status mapping, human explanation, safe next action, and compatibility behavior.

The command and recovery decision is accepted in
[ADR 0007](adr/0007-gdp-command-transaction-and-recovery.md).

## 8. World Model and AST availability

- GDP reuses one current remote-governed WMM baseline from the configured state branch.
- A Story may calculate a deterministic Candidate delta and should-set against that baseline.
- Starting, resuming, changing phase, or opening a Passport never triggers a full WMM rebuild.
- Missing, stale, unsupported, or temporarily unavailable WMM/AST data is represented explicitly.
- Existing workflows continue with bounded repository text/file access.
- Only a newly enrolled policy that named a supported exact view before execution may treat that
  view as required; readiness must refuse enrollment before work starts.
- Models may narrate bounded facts but cannot create structural authority or a proof verdict.

## 9. Durable-family admission rule

The M0 family catalog is a design registry, not the MIG runtime registry. Before the first governed
write of any family, its implementation milestone must provide:

1. a closed current JSON Schema and current MIG version;
2. an N−1 reader or an explicit version-1 no-predecessor proof;
3. golden current and previous-version fixtures;
4. deterministic semantic hash and unknown-field tests;
5. malformed-reference, path escape, symlink, size, concurrency, and migration-purity tests;
6. the exact writer, reader, logical plane, immutable/mutable rule, and recovery behavior;
7. npm/VSIX packaging and clean-checkout compatibility evidence.

M0 deliberately asserts that none of the 34 new families is production-registered. This prevents a
schema document from being mistaken for an available runtime.

## 10. M0 acceptance

GDP-M0 is contract-complete when deterministic tests prove:

- the mode vocabulary contains only `workflow | outcome`;
- selection strategy is separate and a workflow selection names a valid profile category;
- Predicate Results and Proof Summaries cannot reference a current Passport;
- every new family appears exactly once in the design catalog with one writer, owner, plane,
  classification, milestone, migration owner, and reader policy;
- companion paths and digests match the accepted baseline;
- draft records are closed, bounded, acyclic, and machine/path/clock independent;
- production MIG does not yet register or write a GDP family;
- runtime source, workflows, gates, commands, and defaults remain unchanged.

Passing M0 authorizes GDP-M1 compatibility inventory and pure projections only. It does not
authorize durable writes, UI promotion, Outcome execution, proof gating, migration, or enforcement.
