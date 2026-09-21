# Browser-Verified Revision Loop (`BRL`) v0.4

**Status:** corrected implementation specification; not activated by this document

**Namespace:** `BRL`

**Codebase validation point:** `main@499b2656`

**Decision owner:** unassigned

**Independent validator:** unassigned

**Supersedes:** the unversioned BRL draft based on `6e9f323`

**Builds on:** REV candidate intervals and publication selection, registered quality commands,
Test-Credible Evidence, ENV bindings, validation findings, verification correction, and bounded
workflow rework loops.

> **Law in one line:** BRL may report a browser result only when it can prove the exact frozen
> candidate that produced the served application, the exact checks and environment that exercised
> it, and the complete disposition of the run's processes and effects.

## 1. Decision and scope

BRL adds a governed inner loop to a code-bearing phase:

```text
freeze candidate
  -> build and launch that exact candidate in an approved isolated runner
  -> run registered unit and browser checks
  -> compare assertions and pinned visual baselines
  -> create candidate-bound findings
  -> revise code or tests
  -> freeze a new candidate
  -> repeat until the developer selects a current green candidate
```

The normal outer lifecycle remains separate:

```text
Specification -> Code with BRL -> Testing/Verification -> Conformance
                                  | failed review |
                                  +---- bounded return to Code ----+
```

BRL is not a second workflow engine, a self-approving agent, or permission to mutate approved
intent. It does not turn screenshots into proof, make Testing complete from a Code result, or
allow code changes in an artifact-only Testing phase.

The first release targets one repository, one active Story, one code-bearing phase generation,
and one frozen candidate per check run. Composite repositories and distributed test farms remain
out of scope until they have equivalent candidate-under-test and effect attestations.

## 2. Validated current boundary and implementation checkpoint

The codebase now contains the safe, model-free BRL foundation described below, but it does **not**
provide an active browser runner or a publication authority. This checkpoint covers
`main@499b2656` plus the bounded implementation delivered with this specification:

| Foundation at the validation point | Current status |
|---|---|
| Immutable REV candidate references, bounded intervals, capture, precheck, and local CAS head | Guarded local pilot available |
| Read-only registered-check planning | Kernel foundation available |
| Injected Code-check probe | Development-only; produces `observed-unverified`, never proof |
| Code-result projection with candidate/config/test/environment staleness | Kernel foundation available |
| Selected-head publication selection and local attestation primitives | Implemented foundation; not an activated public REV publication bridge |
| `spec-code-test-loop` workflow and bounded Testing-to-Code return | Available as a manual governed workflow |
| Playwright MCP observation in Testing | Available when configured; not an isolated BRL runner |
| Closed browser-check, run-key, run-state, run-receipt, and comparison schemas | Implemented and migration-registered with N-1 readers |
| Exact frozen-candidate Git reads and private content-addressed artifact storage | Implemented through the reviewed Git Access Layer; no ambient-worktree execution |
| Deterministic assertion projection, staleness, and closed result rules | Implemented as a non-authoritative kernel foundation |
| Deterministic pixel comparison and approved baseline membership | Unavailable; every non-null visual baseline and visual claim is refused |
| Public `revision checks capabilities/plan/status/result/run` lifecycle | Implemented; planning and running fail closed until a registered check and trusted runner are available |
| Copilot `/sf-revision-checks` and local `@sflow /revision-checks` surfaces | Implemented; mutation is never executed by the participant or skill |
| Escaped VS Code browser-result card projection | Implemented as an inert view model; it grants no witness, Testing, approval, or publication authority |
| Approved isolated check runner with quiescence and effect-resolution proof | Unavailable |
| Authenticated durable check receipts | Unavailable |
| Candidate-under-test application attestation | Unavailable |
| Governed baseline lifecycle and findings handoff | Unavailable |
| Exact selected-candidate Story publication bridge | Runtime capability reports unavailable |

Until all release gates in this specification pass, BRL execution MUST remain unavailable. The
existing manual `spec-code-test-loop` may still be used, but its MCP screenshots and observations
must retain their current honest status and cannot be relabelled as BRL receipts.

The current foundation seals Story/work-item, phase and generation, loop, interval, run, workflow,
configuration, proof-profile, command, environment, adapter, Candidate, and exact approved test-
manifest identities. A receipt additionally records the fixed bridge attempt ID and an explicit
`candidateUnderTestAttestation: null` authority boundary. One immutable receipt is admitted per run
ID. These fields prevent substitution; they do not make the unavailable runner or application-
provenance attestation exist.

## 3. Terms and authority

### 3.1 Frozen candidate

An immutable, independently verifiable REV candidate reference containing at least its candidate
ID and digest, repository tree, source manifest, effect set, Story, phase, and generation.

### 3.2 Candidate-under-test attestation

A durable record proving that the application reached by the browser came from one exact frozen
candidate. It binds:

- the verified candidate reference and repository tree;
- the isolated materialization identity;
- build and launch definition digests and argv digests;
- toolchain and environment fingerprints;
- the content-addressed build-output manifest;
- the launched process tree or exact remote deployment identity;
- the observed origin and readiness probe;
- the served artifact digest or deployment attestation; and
- the runner implementation and attestation identity.

Possessing tests from candidate `Cn` is not proof that a server was built from or serves `Cn`.

### 3.3 Browser check

A model-free, registered quality command in argv form with exact working directory, affected
roots, structured result adapter, output roots, environment binding, time and output limits,
artifact policy, network/effect policy, and optional visual-baseline policy.

### 3.4 Browser run receipt

An authenticated durable receipt for one exact check against one candidate-under-test attestation.
It is not constructed from caller-supplied JSON, console prose, or a self-hashed report alone.

### 3.5 Comparison record

A deterministic projection of assertion outcomes, visual comparisons, and human observations.
It carries no model judgment.

### 3.6 Finding

A content-derived `VF-<12hex>` record bound to a run, candidate, criterion set, exact test or
visual comparison, and admitted artifact digests. An assertion or visual failure may deterministically
pre-fill a finding. A human must supply any semantic observation or severity not established by
policy.

### 3.7 Green

The closed verdict defined in section 8. “The command exited zero,” “Playwright showed green,”
or “a screenshot looks right” is not the BRL green verdict.

## 4. Non-negotiable requirements

### Candidate and application provenance

- `[BRL:REQ-001]` Every run MUST bind one independently verified frozen candidate. Mutable
  developer worktrees, indexes, or editor buffers are never execution inputs.
- `[BRL:REQ-002]` The runner MUST materialize the candidate into an isolated workspace. Candidate
  source is read-only after materialization; admitted generated output lives only under declared
  writable roots.
- `[BRL:REQ-003]` Before browser navigation, the runner MUST produce a candidate-under-test
  attestation. A local application binds its build output and launched process tree. A remote QA
  application binds an approved deployment receipt that maps the deployed artifact back to the
  same candidate and build manifest. Without either proof, the browser check is `unavailable`.
- `[BRL:REQ-004]` The browser receipt MUST bind the candidate-under-test attestation. Testing files
  from `Cn` running against an unknown, stale, or unrelated server MUST never become a current
  result for `Cn`.
- `[BRL:REQ-005]` A changed candidate, source tree, build/launch definition, test body, adapter,
  baseline set, environment fingerprint, toolchain, browser, or applicable network policy makes
  the previous result stale.

### Comparison forms and evidence

- `[BRL:REQ-006]` BRL permits exactly three comparison forms: executable assertion, deterministic
  visual comparison, and human observation. Assertions and visual comparisons may be witnesses;
  human observations create findings or notes and cannot alone satisfy a criterion.
- `[BRL:REQ-007]` Screenshot, trace, video, HTML report, or model explanation alone MUST NOT
  satisfy an acceptance criterion.
- `[BRL:REQ-008]` A claimed defect fix needs a discriminating witness: with one unchanged test
  body, baseline, relevant environment, and adapter, the parent fails and the child passes. If a
  regression test is introduced on the child, the exact child test body MUST also be run against
  the parent. Inability to run the parent leaves the proof owed; it does not fabricate a negative.
- `[BRL:REQ-009]` Comparison verdicts, stale bindings, finding IDs, and result-card rendering MUST
  be deterministic and model-free.
- `[BRL:REQ-010]` Every finding passed to `revise` MUST bind its candidate, criteria, comparison,
  and admitted artifact digests within the packet budget. Changed or revoked evidence makes the
  route and packet stale.

### Visual baselines

- `[BRL:REQ-011]` A visual baseline is an immutable, content-addressed set. Each image binds its
  name, pixels digest, viewport, device scale, color settings, browser/version, platform/font
  profile, candidate, capture operation, and approved baseline-set digest.
- `[BRL:REQ-012]` The comparison algorithm/version, pixel policy, masks, animation policy, and
  tolerance are registered configuration. They cannot be chosen or relaxed per run.
- `[BRL:REQ-013]` A failing run MUST NOT update its own baseline. A baseline proposal is a separate
  reviewable mutation with an exact diff, reason, affected criteria, and authorized approval.
- `[BRL:REQ-014]` An approved baseline change creates a new candidate and invalidates the prior
  result. If `C2` supplies intended new pixels, approval materializes baseline set `B2` in child
  candidate `C3`; the affected checks rerun on `C3/B2`. `C2` never becomes green retroactively.
- `[BRL:REQ-015]` Baseline approval accepts expected pixels only. It does not approve product code,
  waive a criterion, or replace a specification amendment when the expected behavior changed.

### Phase and publication integrity

- `[BRL:REQ-016]` BRL runs only in a phase whose resolved `generation.task` is `code` and whose
  exact phase policy enables BRL. A phase name such as `implementation` grants no authority.
- `[BRL:REQ-017]` A Code result is review evidence, not a Testing/Verification verdict. A later
  phase creates a distinct phase-bound receipt or explicitly records exact-policy reuse.
- `[BRL:REQ-018]` Source or test changes requested during Testing return through the configured
  bounded rework edge to a new Code generation. Testing never publishes changed source.
- `[BRL:REQ-019]` A change to approved intent routes to the existing intent-amendment ceremony.
  Approval creates a new specification generation and invalidates affected candidates and results;
  BRL never edits the approved specification in place.
- `[BRL:REQ-020]` Environment-only failure remains an environment or Testing rerun issue unless a
  reviewed return explicitly authorizes source/test repair.
- `[BRL:REQ-021]` Code publication MUST bind the exact selected loop head, its current green result,
  a fresh transition-bound precheck, and the current workflow/configuration/proof inputs. Latest
  chronological candidate is not a substitute for selected head.

### Execution, effects, and recovery

- `[BRL:REQ-022]` `revision.checks.plan` is read-only. Running a check requires a separate exact
  plan confirmation unless a current standing authorization covers the exact check and effect set.
- `[BRL:REQ-023]` Standing authorization is permitted only for an independently attested runner
  whose declared effects are limited to local processes, isolated ephemeral files, an approved
  dependency cache, and explicitly allowlisted network reads. Unknown effects, network writes,
  external mutations, or credential changes always require per-run authority or are refused.
- `[BRL:REQ-024]` Network access is default-deny. A browser target, package mirror, or API origin
  must be explicitly allowlisted with method/effect limits. “Network read” must be enforced by the
  runner, not inferred from the command name.
- `[BRL:REQ-025]` Credentials are brokered to the isolated runner, never copied into candidate
  source, logs, reports, traces, screenshots, or durable receipts. Browser storage state is private
  secret material, not a BRL artifact.
- `[BRL:REQ-026]` Timeout, cancellation, malformed output, adapter failure, runner loss, and process
  exit are first-class outcomes. SFlow MUST prove process-tree quiescence separately from effect
  resolution before retrying.
- `[BRL:REQ-027]` Automatic retry is legal only when every spawned process is quiescent and every
  observed effect is absent, restored, or idempotently compensated. Otherwise the run and interval
  enter `recovery-required` and no new candidate or run may start.
- `[BRL:REQ-028]` Every mutation uses compare-and-swap over the active Story, phase generation,
  selected head, run revision, configuration, environment, and policy bindings. Repeated exact
  confirmations are idempotent; changed authority produces a new plan.

### Budgets and privacy

- `[BRL:REQ-029]` Every inner and outer loop is bounded. A ceiling creates a Human Request with
  `extend`, `clarify/amend`, or `stop`; it never silently retries or waives evidence.
- `[BRL:REQ-030]` BRL records Story-level attempts, findings, and flaky-test debt only. It MUST NOT
  produce per-person productivity or performance metrics.

## 5. Candidate-under-test provenance

### 5.1 Local isolated application

The trusted runner performs this closed sequence:

1. independently verify the retained candidate reference and source manifest;
2. materialize its exact tree into a fresh isolated directory with source read-only;
3. resolve only registered toolchain/dependency inputs;
4. execute build argv under the declared effect/network policy;
5. hash the complete admitted build-output tree into a build manifest;
6. launch the registered start argv against that output;
7. wait for the registered readiness predicate;
8. observe the actual bound origin and served artifact identity;
9. seal the candidate-under-test attestation; and
10. only then start the browser check.

The build and launch steps may share one execution tenancy, but their command receipts remain
distinct. The application cannot be replaced between readiness and browser completion without
invalidating the run.

### 5.2 Remote QA/UAT application

An ENV base URL alone is insufficient. The remote path requires an approved deployment adapter
that returns an authenticated deployment receipt binding:

```text
candidate reference -> build manifest -> deployed release identity -> observed origin
```

The receipt must remain current for the entire run. If the remote platform cannot attest the
deployed artifact, BRL reports `CANDIDATE_UNDER_TEST_UNPROVEN`; users may still perform a labelled
manual observation, but it cannot become a BRL green result.

### 5.3 Candidate-under-test record

The durable record contains no secrets and has a closed schema including:

```json
{
  "kind": "brl-candidate-under-test",
  "candidateRefSha256": "sha256:...",
  "candidateTree": "<git-object>",
  "materializationSha256": "sha256:...",
  "buildDefinitionSha256": "sha256:...",
  "buildOutputManifestSha256": "sha256:...",
  "launchDefinitionSha256": "sha256:...",
  "environmentSha256": "sha256:...",
  "toolchainSha256": "sha256:...",
  "servedArtifactSha256": "sha256:...",
  "observedOriginSha256": "sha256:...",
  "runnerAttestationSha256": "sha256:..."
}
```

Exact timestamps, process/deployment identity, readiness receipt, and content hash are also
required by the schema. The displayed URL may be redacted according to environment policy; its
digest and authority binding remain exact.

## 6. Run state machine

Execution state and evidence verdict are separate fields. A state transition is append-only and
CAS-protected; a receipt never rewrites an earlier transition.

```text
PLANNED (read-only plan; no run yet)
  -> AUTHORIZED
  -> MATERIALIZING
  -> BUILDING
  -> STARTING
  -> RUNNING
  -> COLLECTING
  -> NORMALIZING
  -> COMPARING
  -> COMPLETED
```

From any effectful state, the operation may instead finish as:

| Terminal state | Meaning |
|---|---|
| `UNAVAILABLE` | Required runner, environment, deployment proof, tool, or authority was missing before uncertain effects |
| `CANCELLED` | Cancellation completed; process quiescence and effects were resolved |
| `TIMED_OUT` | Deadline elapsed; process quiescence and effects were resolved |
| `INFRASTRUCTURE_FAILED` | Runner/adapter/reporting failed; product verdict is not failed or passed |
| `RECOVERY_REQUIRED` | Process quiescence or effect resolution is unknown; no retry is legal |

`COMPLETED` has one evidence verdict: `passed`, `failed`, or `not-evaluable`. Product assertion or
visual failure yields `failed`. Missing or contradictory adapter evidence yields `not-evaluable`,
not a product failure. `CANCELLED`, `TIMED_OUT`, `UNAVAILABLE`, and `INFRASTRUCTURE_FAILED` never
produce a green verdict.

A retry creates a new run ID linked to the prior terminal receipt. It never overwrites a prior run
or changes a failed result to passed. Recovery revalidates durable state and may finish cleanup;
it never repeats an uncertain command.

## 7. Browser-run receipt and comparison contracts

### 7.1 Receipt bindings

Every receipt binds:

- Story, phase, generation, loop, interval, and selected candidate identities;
- candidate-under-test attestation and source/build/served artifact digests;
- check definition, argv, working directory, result adapter, test-body set, output-root set, and
  visual-baseline-set digests;
- proof profile, environment, toolchain, runner, browser, platform/font, network/effect policy,
  configuration, and workflow digests;
- start/end time, deadline, exit/termination state, process-tree quiescence, and effect resolution;
- discovered, passed, failed, skipped, retried, and flaky totals;
- stable per-test identities derived from normalized name path and test-body digest;
- bounded log digest and admitted artifact inventory; and
- receipt producer/version, authenticated store identity, and receipt digest.

### 7.2 Deterministic visual comparison

This section is the target contract, not a current capability. Until an independently registered
pixel comparator can load approved baseline bytes and prove each image's membership in the pinned
baseline set, the runtime refuses non-null visual-baseline configuration and any adapter-supplied
visual claim. Reporter-supplied pixel totals or baseline hashes are never accepted as a substitute.

Each comparison binds baseline and actual pixels, optional diff image, comparison algorithm and
version, masks, thresholds, viewport/device/browser profile, and verdict. The renderer performs no
model call. Image metadata alone cannot replace decoded-pixel hashing.

### 7.3 Findings

Assertion and over-tolerance results may produce deterministic proposed findings. Human
observations are recorded only after a person identifies the artifact and describes the issue.
The canonical finding ID hashes its run, comparison/test identity, normalized text, bound criteria,
and evidence digests. Editing any field creates a new finding.

Findings have explicit dispositions: `open`, `accepted-for-revision`, `not-a-defect`,
`duplicate`, `environment`, `intent-amendment`, or `new-work`. A disposition never deletes the
original failure.

## 8. Closed green verdict

BRL displays **green / ready to publish** only when all of the following are true for the exact
selected candidate and current bindings:

1. the candidate and candidate-under-test attestation independently verify;
2. every required registered check completed and has an authenticated current receipt;
3. every required test check discovered at least its configured `minimumDiscovered` tests and
   discovered count is greater than zero;
4. process exit, adapter status, and normalized counts are mutually consistent;
5. failed count is zero;
6. skipped count is within an approved check-definition limit, and no skipped test is required or
   criterion-bound; the default limit is zero;
7. no retry changed a failure into a pass; such a test is `flaky`, not passed;
8. no required or criterion-bound test is quarantined;
9. every required report and artifact exists, is admitted, and matches its digest;
10. every required visual comparison is within its registered tolerance;
11. there is no open blocking finding, owed discriminating witness, stale binding, or contradictory
    observation;
12. environment, toolchain, browser, baseline, check, test-body, and configuration bindings are
    current;
13. every process is quiescent and every effect is resolved; and
14. the run and artifact stores pass integrity and access/retention checks.

A policy may quarantine a flaky non-required test with owner, reason, issue reference, approved
authority, and expiry of at most 30 days. The result is labelled `green-with-debt`, lists the
quarantine, and is **not** BRL green when the test is required, criterion-bound, or the workflow
requires debt-free publication. Expiry makes the result stale. Quarantine never turns a failing
criterion into a pass.

Zero discovered tests, all tests skipped, malformed reporter output, missing output, reporter
crash, missing screenshot required by the check, unknown retry history, or a “pass” based only on
exit code is `not-evaluable` or failed according to the registered adapter—never green.

## 9. Artifact admission, security, and retention

Browser artifacts are hostile inputs even when created locally.

- Output roots are fixed repository-relative identifiers resolved inside the runner's separate
  writable area. Symlinks, junctions/reparse points, hard-link escapes, alternate data streams,
  traversal, device names, and path/case collisions are refused on every platform.
- The runner inventories files without executing them, verifies real-path containment, opens with
  no-follow semantics where supported, hashes exact bytes, then copies admitted bytes into an
  immutable artifact store.
- Media type is detected from bytes and checked against the registered type. Extension and
  reporter declarations are not trusted.
- HTML reports render only in a script-disabled sandbox with restrictive CSP, no network, no
  opener, and no file-system access. Raw report HTML is never injected into a privileged webview.
- Trace/archive admission enforces entry count, expanded-byte, nesting, compression-ratio, and
  filename limits before extraction. Archive members cannot escape their private directory.
- Logs, traces, videos, screenshots, reports, network captures, headers, cookies, tokens, browser
  storage, and personal data pass secret/privacy scanning. Unsafe artifacts are quarantined or
  rejected and cannot be previewed or forwarded to a model.
- Receipt metadata records `private`, `story`, or `public` access and `ephemeral`, `review`, or
  `proof` retention. Raw artifacts are not committed to the application branch merely to preserve
  them. Durable receipts keep digests and authorized resolvable references for the review period.
- Expired or revoked artifacts remain represented by their digest and disposition. Their absence
  is shown honestly and may make a pending review unavailable.

Default implementation ceilings are intentionally conservative and configurable downward:

| Resource | Default hard ceiling |
|---|---:|
| Registered checks per plan | 32 |
| Artifacts per check receipt | 64 |
| Receipt JSON | 256 KiB |
| Combined admitted artifacts per run | 256 MiB |
| Individual screenshot | 16 MiB |
| Individual trace/report archive | 128 MiB compressed and 512 MiB expanded |
| Bounded stdout + stderr retained for normalization | 1 MiB per check |
| Check timeout | 2 hours maximum; workflow should configure less |
| Automatic SFlow reruns of one candidate | 0 by default |

Exceeding a limit yields a named refusal or `not-evaluable` result; truncation cannot preserve a
pass claim unless the adapter contract explicitly proves the omitted data is non-authoritative.

## 10. Sandbox and effect policy

The release profile requires an independently reviewed executor with:

- OS-level process and filesystem isolation appropriate to each supported platform;
- immutable candidate input and separate writable build/output/cache areas;
- process-tree identity, termination, and quiescence proof including descendants;
- default-deny network enforcement with destination/method audit;
- secret brokerage that keeps values outside argv, environment diagnostics, and artifacts;
- bounded CPU, memory, storage, process count, wall time, and output;
- explicit dependency-cache ownership and cleanup/retention policy;
- effect journaling and deterministic recovery after crashes; and
- current platform witnesses for macOS, Linux, and Windows before those platforms are advertised.

Running a process in a temporary directory is not isolation. Killing a parent PID is not process-
tree quiescence. Deleting an output directory is not proof that network or other external effects
were absent.

Because no approved sandbox is assumed by this specification, the safe built-in profile remains:

```text
plan: available when candidate and registered commands verify
run: unavailable with REV_CODE_CHECK_EXECUTOR_UNAVAILABLE
result: read-only projection of independently verified receipts, if any
```

Playwright MCP may continue to support a human Testing review. It MUST NOT be used as a substitute
for the BRL execution attestation.

## 11. Loop and retry budgets

The target workflow declares both budgets:

```yaml
brl:
  maximumCandidatesPerCodeGeneration: 5
  maximumRunsPerCandidate: 2
  onCeiling: human
reworkLoops:
  - from: testing
    to: implementation
    maxAttempts: 3
    resetOnPhase: specification
```

- One run is normal. A second run is allowed only for an explicitly recorded infrastructure or
  flakiness investigation after the first run reached a cleanup-safe terminal state.
- Runner-native retries are pinned in the check definition and fully exposed in the receipt; they
  do not evade `maximumRunsPerCandidate`.
- A new candidate consumes the Code-generation candidate budget even when it changes only tests or
  baselines.
- A new approved Specification generation resets the configured outer repair budget and starts a
  new Code generation. It does not erase prior evidence.
- At either ceiling, SFlow creates a Human Request. `extend` creates a new bounded budget record
  with reason and authority; `clarify/amend` routes to the relevant ceremony; `stop` preserves the
  loop. No extension is inferred from another retry command.

## 12. Proposed configuration contract

This is target schema, not syntax accepted by the validation-point build:

```yaml
qualityCommands:
  browser-tests:
    kind: test
    argv: [npx, --no-install, playwright, test, --reporter=json]
    workingDirectory: .
    affectedRoots: [src, tests]
    modelPolicy: never
    timeoutMs: 900000
    result:
      adapter: playwright-json
      path: .sflow/results/playwright.json
      minimumDiscovered: 1
    outputRoots: [checks/browser-tests]
    browser:
      environment: qa
      build:
        argv: [npm, run, build]
        outputRoots: [dist]
      launch:
        argv: [npm, run, start:test]
        readiness: { kind: http, path: /health, expectedStatus: 200 }
      artifacts: { screenshots: always, traces: on-failure, video: never }
      visualBaseline:
        path: tests/__screenshots__
        tolerance: 0.005
        algorithm: playwright-pixel-v1
        updatePolicy: governed
      effects:
        filesystem: isolated-ephemeral
        dependencyCache: approved
        network: { mode: allowlist, origins: [environment:qa] }
      limits:
        maximumArtifacts: 64
        maximumArtifactBytes: 268435456

workTypes:
  spec-code-test-loop:
    phaseOverrides:
      implementation:
        revisionLoop:
          browserVerified: true
          checks: [unit, browser-tests]
          maximumCandidates: 5
          maximumRunsPerCandidate: 2
      testing:
        verificationChecks: [unit, browser-tests]
        receiptReuse: rerun
```

Commands are argv arrays. Shell strings, package-script inference, per-run tolerance overrides,
and implicit output glob discovery are invalid.

## 13. CLI, Copilot, and VS Code lifecycle

All surfaces consume the same service and records. The first public slice is deliberately smaller
than the complete BRL lifecycle: capability inspection, Story-bound planning, exact-confirmed run,
run status, and one run result. Anything not in that slice remains unavailable rather than being
approximated by shell scripts or caller-supplied records.

### 13.1 Capability inspection

```bash
singularity-flow revision checks capabilities --json
```

This read reports the installed planner, runner, receipt-store, comparison, baseline, finding,
publication, platform, and sandbox capabilities with exact unavailable reasons. Repository opt-in
cannot turn a compiled or externally attested capability from unavailable to available.

### 13.2 Story-bound read-only planning

```bash
singularity-flow revision checks plan --json
```

Planning resolves the ready active Story, its current code-bearing phase generation, and the exact
current retained loop-head candidate. The caller cannot select an arbitrary candidate on argv.
It returns exact checks, candidate-under-test strategy, environment/effect policy, limits, expected
artifacts, and `planSha256`. It starts no process and creates no run. No ready Story or no retained
current candidate yields an exact refusal.

### 13.3 Exact run authorization

```bash
singularity-flow revision checks run \
  --plan sha256:<PLAN> \
  --confirm sha256:<PLAN> \
  --json
```

The mutation re-resolves authority and all bindings under the Story subject lock. A stale plan
fails before effects. Standing authorization, when eligible, records the exact authorizing policy
instead of fabricating user confirmation.

### 13.4 Status and result

```bash
singularity-flow revision checks status [<RUN-ID>] --json
singularity-flow revision checks result <RUN-ID> --json
```

Both operations are read-only. With no run ID, `status` resolves only the active Story's current
run; it never scans unrelated repositories or users. `result` names one exact run and returns its
current/stale bindings and authenticated receipt projection.

Public cancellation, manual retry, and recovery mutations are deferred from the first slice. An
in-flight process may still receive host cancellation, but the executor must record the resulting
terminal state and cleanup evidence. Recovery remains an internal fail-closed boundary until its
own plan/idempotency/fault witnesses qualify; users are never advised to rerun an uncertain check.

### 13.5 Later gated findings, revision, and baseline lifecycle

These commands are part of the complete BRL contract, not the first public slice. Capability
inspection MUST report them unavailable until their stores, authority, and fault witnesses pass.

```bash
singularity-flow revision finding create \
  --run <RUN-ID> --comparison <ID> --criteria <CLAUSE-ID> --text-stdin --json

singularity-flow revise \
  --finding <VF-ID> --feedback-stdin --saved-buffers-confirmed --dry-run --json

singularity-flow revision baseline propose \
  --check <CHECK-ID> --run <RUN-ID> --reason <TEXT> --json

singularity-flow revision baseline approve \
  <PROPOSAL-ID> --confirm <PROPOSAL-ID> --json
```

A baseline approval returns the required child-candidate capture action. It never marks the source
run green. `revise` retains the existing preview then exact-confirmation lifecycle.

### 13.6 Publication

After the selected head is current, green, and freshly prechecked, ordinary phase publication may
consume the exact selection through the activated publication bridge. `/sf-code` shows the
selection before mutation. Publication, submission, and approval remain three separate actions.

### 13.7 Surface activation status and gated targets

- **Implemented foundation:** `@sflow /revision-checks` provides zero-model capability, plan,
  status, and result reads and prefills the exact separately reviewed mutation; it never submits a
  run. Capability discovery works before a repository or Story is selected.
- **Implemented but inert:** the escaped VS Code result-card projection can render supplied closed
  result bytes in tests. It is not connected to an artifact opener, witness, or lifecycle action.
- **Gated target:** `/sf-code` will render current BRL readiness and the same plan/run/result
  commands only after the runner and publication bridge qualify.
- **Gated targets:** `/sf-revise` accepting an exact `VF-` reference, `/sf-validate` recording human
  observations, and `/sf-reject` owning the Testing-to-Code outer return require the governed
  findings and rework lifecycle that is not activated in this slice.
- **Gated target:** the full VS Code card will show Candidate/application provenance,
  unit/browser/visual sections, admitted artifact access, stale reasons, effect/cleanup status, and
  one legal next action. HTML and trace opening remains unavailable until the sandboxed viewer and
  secure artifact-admission boundary qualify.

Every refusal shows both the shell command and Copilot route when one exists.

## 14. Correct example

Story `UI-217` changes a responsive header.

1. `C1/B1` runs. Unit tests pass; browser tests fail `header collapses on 375px`; visual comparison
   is 1.9% over the registered 0.5% tolerance. The receipt proves the served application was built
   from `C1`. Findings `VF-A` and `VF-B` bind the assertion, images, trace, and `AC-3`.
2. The developer revises from `VF-A`. Candidate `C2` passes the assertion, but the visual still
   differs from approved baseline set `B1`.
3. The developer determines that the new layout is intended and proposes the observed pixels from
   `C2`. An authorized reviewer approves baseline set `B2`. This does **not** make `C2` green.
4. The approved baseline change is captured as child candidate `C3`. All affected checks rerun
   against the application built from `C3`, using `B2`. The result is current and green.
5. The developer selects `C3`; publication binds `C3`, the green result, and fresh precheck.
6. Testing independently reruns the configured checks under its own receipt. If it finds a product
   or test defect, `/sf-reject` returns to Code within the three-attempt outer budget. If only the
   QA environment is unavailable, Testing records that condition and does not blame or edit Code.

If approving `B2` changes expected behavior beyond `AC-3`, step 3 routes to intent amendment
instead; no baseline or source candidate is accepted until the amendment is approved.

## 15. Acceptance criteria

- `[BRL:AC-001]` Running against a mutable developer worktree is refused before execution.
- `[BRL:AC-002]` Tests from `C1` pointed at an unproven or `C0` server produce
  `CANDIDATE_UNDER_TEST_UNPROVEN`, never a `C1` receipt.
- `[BRL:AC-003]` Local build/launch binds candidate tree, build output, process tree, observed origin,
  and served artifact; changing any one makes the result stale.
- `[BRL:AC-004]` Remote QA without an authenticated candidate-to-deployment receipt is unavailable.
- `[BRL:AC-005]` Screenshot-only or human-observation-only evidence cannot satisfy a criterion.
- `[BRL:AC-006]` A claimed fix whose test passes on both parent and child is refused as a weakened
  witness; a child-only test is replayed unchanged on the parent.
- `[BRL:AC-007]` A baseline update from failing `C2/B1` creates approved `B2`, child `C3`, and a new
  run; `C2` remains failed/stale.
- `[BRL:AC-008]` Per-run tolerance relaxation and auto-update baseline flags are refused.
- `[BRL:AC-009]` Zero discovered, all skipped, fail-then-pass retry, malformed report, missing
  required artifact, and contradictory exit/count cases never render green.
- `[BRL:AC-010]` Quarantining a required or criterion-bound flaky test leaves publication blocked;
  quarantine expiry makes the result stale.
- `[BRL:AC-011]` Candidate, test body, adapter, baseline, ENV, browser, policy, or configuration
  change produces explicit stale bindings.
- `[BRL:AC-012]` Cancellation and timeout prove descendant-process quiescence and effect resolution;
  uncertainty enters recovery-required and prevents retry.
- `[BRL:AC-013]` Network is denied unless the exact origin/method policy is enforced and attested.
- `[BRL:AC-014]` A malicious HTML report cannot execute script, navigate, access local files, or
  call privileged VS Code APIs.
- `[BRL:AC-015]` Archive traversal, zip bomb, symlink/reparse escape, Windows device path, secret-
  bearing trace, and over-limit artifact are rejected without preserving a pass claim.
- `[BRL:AC-016]` Inner and outer ceilings stop with an explicit Human Request; exact extension is
  bounded and auditable.
- `[BRL:AC-017]` Testing rerun creates a distinct receipt. A Code result alone cannot complete
  Testing or Verification.
- `[BRL:AC-018]` Testing source/test edits cannot publish in Testing; the confirmed repair route
  opens a new Code generation and invalidates old results.
- `[BRL:AC-019]` Approved-intent feedback routes to amendment and changes no source, test, baseline,
  or approved specification before decision.
- `[BRL:AC-020]` Code publication accepts only the current selected head with a current green
  result and fresh precheck; a newer chronological but unselected candidate is irrelevant.
- `[BRL:AC-021]` Counterfeit model output, caller-supplied receipt JSON, and modified artifact
  metadata do not change any verdict.
- `[BRL:AC-022]` macOS, Linux, and Windows fault tests cover runner loss, cancellation, timeout,
  process descendants, path escapes, lock races, stale confirmation, and crash recovery before the
  respective platform is advertised.
- `[BRL:AC-023]` Story records expose aggregate rounds/findings/flaky debt but no per-person metric.

## 16. Implementation plan and release slices

Each slice ships disabled until its own tests and capability manifest pass. Later slices cannot
turn foundation-only records into historical proof.

### Slice 0 — closed contracts and honest capabilities

- Add schemas for candidate-under-test, run transition/intent, authenticated receipt, comparison,
  baseline set/proposal, finding, quarantine, and budget extension.
- Add migrations that preserve historical transport/status without inventing fields.
- Publish capability flags and exact unavailable reasons; current safe profile remains disabled.
- Add canonical hashing, size limits, closed vocabularies, and counterfeit-model tripwires.

### Slice 1 — isolated executor and provenance

- Implement one approved local runner adapter with read-only candidate materialization, build,
  launch, readiness, candidate-under-test attestation, process-tree cleanup, effect journal, and
  crash recovery.
- Prohibit remote execution until a deployment adapter can prove candidate-to-release identity.
- Complete macOS/Linux/Windows fault witnesses before enabling each platform.

### Slice 2 — normalized receipts and secure artifacts

- Implement structured unit and Playwright adapters with stable test identities and retry/flaky
  normalization.
- Add authenticated private receipt store and independent read verification.
- Add safe artifact admission, archive limits, secret/privacy scanning, sandboxed viewers, access,
  retention, and cleanup.
- Wire existing Code-result projection only to verified store readers.

### Slice 3 — comparison, findings, and governed baselines

- Implement deterministic pixel comparison and immutable baseline-set registry.
- Implement proposal/approval/capture-as-child lifecycle; enforce the `C2 -> B2 -> C3 -> rerun`
  rule.
- Produce deterministic findings and exact finding-to-REV packets.
- Add discriminating parent/child witness execution and weakened-witness refusal.

### Slice 4 — loop, workflow, and publication bridge

- Wire bounded candidate/run budgets and Human Requests.
- Integrate the existing `spec-code-test-loop` outer rework route without letting Testing edit code.
- Activate exact selected-head publication only after current green result plus fresh precheck is
  verified inside the Story publication lock and commit transaction.
- Preserve distinct Code and Testing receipts and exact-policy reuse labels.

### Slice 5 — product surfaces and release gate

- Add CLI commands, `/sf-code`, `/sf-revise`, `/sf-validate`, `/sf-reject`, zero-model
  `@sflow /checks`, and VS Code result/comparison/artifact cards.
- Ensure every mutation is plan-first, stale-safe, cancellable where applicable, and exposes shell
  plus Copilot routes.
- Add end-to-end fixtures for unit-only, local browser, visual baseline approval, flaky/quarantine,
  environment outage, intent amendment, outer rework, and publication.
- Require independent security review, decision owner, validator, release manifest, and current
  platform witness matrix before activation.

## 17. Required test suites

At minimum:

```text
brl-contracts.test.mjs
brl-candidate-under-test.test.mjs
brl-run-state-machine.test.mjs
brl-runner-effects.test.mjs
brl-playwright-adapter.test.mjs
brl-artifact-admission.test.mjs
brl-visual-comparison.test.mjs
brl-baseline-lifecycle.test.mjs
brl-finding-revision.test.mjs
brl-green-verdict.test.mjs
brl-budget.test.mjs
brl-phase-publication.test.mjs
brl-vscode.test.mjs
brl-copilot.test.mjs
brl-cross-platform-faults.test.mjs
brl-model-independence.test.mjs
```

The release trace maps every acceptance criterion to exact tests and supported-platform witnesses.
No enabled criterion may rely on a skipped test.

## 18. Non-goals for v0.4

- No autonomous intent change, baseline approval, phase approval, merge, or deployment.
- No browser run directly against a developer worktree.
- No screenshot or human observation as standalone proof.
- No remote QA result without candidate-to-deployment attestation.
- No unrestricted shell, implicit package-command discovery, or prompt-selected tolerance.
- No auto-updated baseline and no retroactive green result.
- No silent code change during Testing/Verification.
- No unbounded retry, loop, artifact store, process, output, or network authority.
- No per-person revision or defect metric.
