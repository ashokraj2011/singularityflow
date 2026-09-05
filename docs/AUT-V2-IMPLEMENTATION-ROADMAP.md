# AUT v2 implementation roadmap

Status: the dependency-free Story profile implements and release-validates the AUT v2 P0/P1
boundary described below at commit `64cf7ddaf5e5b1296f610509da3db44fdb93a32b`. The optional SGOS profile and enforcement of
optional CMP policy are separate work and are not claimed complete here.

Reconciled against `main@7935d2db` on 2026-09-05: subsequent SGOS and GDP delivery did not add the
optional Auto SGOS profile, interval scheduling, direct Ad Hoc materialization, or a registered
comparative-quality baseline. The implemented Story profile remains the default and complete
boundary claimed by this document.

## Architecture decisions

- Auto orchestrates the ordinary Story lifecycle. It cannot approve, waive policy, publish around a
  lifecycle gate, merge, deploy, or create a second source of governance authority.
- `story` is the dependency-free default profile. `auto-select` resolves to `story`. Selecting the
  unavailable `sgos` adapter fails with `AUTO_PROFILE_UNAVAILABLE` and leaves Story Auto usable.
- An Auto Plan requires an approved delivery capability. One eligible capability is selected and
  displayed; no eligible capability returns `CAPABILITY_REGISTRATION_REQUIRED` with a registration
  action; multiple eligible capabilities require an explicit selection.
- Generated Story identities use `AUT-<12-character-digest>-<four-word-slug>`. If that generated
  branch already exists, allocation appends the first available numeric suffix (`-2`, `-3`, ...).
  An explicitly supplied occupied identity is refused rather than renamed. The resolved identity and
  collision suffix are visible in the Plan before ratification.
- `auto plan --story <STORY-ID>` is a read-only, model-free projection of the next existing-Story
  segment. It does not create a Plan, mutate the Story, or start a flight. `auto continue` remains the
  compatible continuation spelling.
- Operators may use a phase ID directly with `--until`, for example `--until verification`. The
  kernel validates it against the selected Story rail and normalizes it to the closed
  `phase-complete:<phase>` selector. Existing explicit endpoint syntax remains compatible.
- Core execution stays sequential and single-repository. Multi-repository coordination, parallel
  SGOS Processes, and interval/background execution remain optional follow-on work.
- Plans and checkpoints retain existing identifier shapes and exact-hash authorization. Historical
  schema-v1 Plan bytes remain readable but cannot authorize a new flight without the current packet.

## Implemented foundation

- Exact Plan synthesis, complete ratification-packet confirmation, identity-bound authorization,
  approved-configuration pinning, deterministic Story creation, and isolated managed worktrees.
- Credential-safe remote identities and fingerprints. Credential-bearing HTTP(S) remotes are
  refused before an Auto Plan is persisted.
- Start and resume revalidate the exact accepted Plan and authority receipts. A started Story does
  not incorrectly reapply intake TTL, caller-branch, or moving-base checks.
- Real `step`, `phase`, and `continuous` pacing. Step checkpoints authoring and publication without
  rerunning a completed model attempt.
- Stop-first pause, halt, and takeover coordination. If quiescence cannot be proved, the durable
  status is `recovery-required`, never a false paused or halted state.
- Candidate records bind the exact add/delete/rename/mode/symlink set. Isolated verification,
  delivery evidence, approval context, and lifecycle publication refer to the same Candidate hash.
- Provider permissions enforce normalized read/write roots before an effect. Auto authoring exposes
  only read, search, create, and edit operations; tests and lifecycle mutations remain kernel-owned.

## P0/P1 implementation

### Intake, identity, and endpoints

- Planning refuses before Story creation when approved capability authority is missing or ambiguous.
- Generated Story/branch names carry a readable four-word requirement slug and deterministic
  collision metadata; explicitly supplied collisions remain fail-closed.
- Existing-Story inspection is available through `auto plan --story` without a model call or write.
- Concise phase endpoints are validated only after the work type supplies the actual phase rail.

### Exact per-attempt contracts

Every authoring attempt now creates four closed, schema-versioned records:

- `auto-context-manifest` binds each admitted context section, representation, token estimate,
  omission, expansion policy, and budget.
- `auto-agent-task-contract` binds the objective, acceptance clauses, predicted read/write scope,
  protected/forbidden scope, allowed tools, outputs, evidence, budgets, and stop conditions.
- `auto-execution-selection` binds the approved provider/model execution unit to the Context
  Manifest with a deterministic selection reason.
- `auto-execution-event` records normalized start/completion/failure observations with ordered event
  IDs and hash-linked raw evidence when the provider exposes it.

The predicted Plan scope, plus the configured phase artifact, forms the read/write boundary; Auto no
longer grants repository-wide read access by default. Records are written through the schema
migration registry, persisted immutably in the repository Git common directory, embedded in governed
checkpoints, and reconstructible after clone or loss of disposable sidecars.

### Lineage, refusals, repair, and Human Requests

- Phase-run and attempt records preserve stable IDs, parents, reasons, task/context/selection hashes,
  budgets, Candidate binding, and result.
- Structured refusals preserve the gate, evidence, worktree, Candidate, and smallest legal next
  action. Repair never expands scope or changes pinned law.
- The default repair policy is `ask`: an exact Repair Plan must be reviewed and confirmed, and it may
  authorize at most one machine-actionable repair attempt for that phase. The optional
  `auto-on-machine-actionable` policy uses the ratified Plan as authorization only for an exact,
  unchanged Candidate whose registered deterministic verification command returned non-zero. It
  refuses provider, timeout, signal, overflow, stale-authority, scope, protected-path, credential,
  and judgment failures. A second failure halts with both failures and repair lineage preserved.
- Human Request records support the closed AUT v2 vocabulary: clarification, approval,
  architecture choice, scope choice, credential, exception, risk acceptance, policy choice,
  conflict resolution, evidence review, production authority, legal judgment, and scientific
  judgment. Responses use exact compare-and-swap against the request hash. Credentials accept only
  broker references; a response is input and never substitutes for ordinary lifecycle approval.

### Reports, economics, and product surfaces

- The deterministic Flight Report identifies the requested outcome, inferred Plan inputs, Story and
  branch, execution-unit history, phase/attempt lineage, refusals, repairs, current stop, and one
  legal next action.
- Attempt economics keep prompt/input/output accounting distinct from tool-output accounting. Tool
  output records exact observed bytes, a byte-derived estimate, and provider tokens only when the
  provider supplies them.
- Reports expose a content-free outcome summary and an observed quality-floor result. Token-saving
  comparison remains `not-evaluated` until a registered comparison baseline exists; no prompt text or
  developer/person score is stored in outcome metrics.
- Home/Return, Gateway responses, and VS Code cards expose Plan, running, refusal, Needs You,
  takeover, and report state without introducing a tool per feature. Buttons prepare existing kernel
  commands for review and do not bypass confirmation.
- WMB and CMP references are bounded and optional unless repository policy makes them required.
  This release does not claim optional CMP enforcement is complete.

## Traceability

| Scope | Primary implementation | Focused evidence |
| --- | --- | --- |
| Plan authority, capability, identity | `src/auto/auto-plan.mjs`, `src/capability-context.mjs` | `test/auto-plan-security.test.mjs`, `test/auto-authorization-integrity.test.mjs` |
| Existing-Story plan and endpoints | `src/commands/auto.mjs`, `src/auto/auto-policy.mjs`, `src/command-registry.mjs` | `test/auto-cli-usability.test.mjs`, `test/auto-v2-policy.test.mjs` |
| Candidate authority | `src/auto/auto-candidate.mjs`, `src/state.mjs`, `src/delivery-evidence.mjs` | `test/auto-candidate.test.mjs`, `test/auto-candidate-crash-recovery.test.mjs` |
| Context/task/selection/event records | `src/auto/auto-contract-records.mjs`, `src/auto/auto-phase-contract.mjs`, `src/auto/auto-executor.mjs`, `src/schema-migrations.mjs` | Auto phase-contract and v2 control tests, schema-migration checks |
| Checkpoints and recovery | `src/auto/auto-checkpoint.mjs`, `src/auto/auto-flight-store.mjs`, `src/auto/auto-private-store.mjs` | `test/auto-v2-controls.test.mjs`, `test/auto-private-store.test.mjs` |
| Lineage, requests, and repair | `src/auto/auto-p1-lineage.mjs`, `src/auto/auto-p1-control.mjs`, `src/auto/auto-p1-records.mjs`, `src/auto/auto-repair-eligibility.mjs` | `test/auto-p1-product.test.mjs`, `test/auto-repair-eligibility.test.mjs`, `test/auto-mode.test.mjs` |
| Reports and economics | `src/auto/auto-flight-store.mjs`, `src/gateway/auto-home-summary.mjs`, `src/gateway/planners/auto-flight.mjs` | `test/auto-report-economics.test.mjs`, `test/auto-p1-surfaces.test.mjs` |
| VS Code cards | `apps/vscode/src/views/auto-cards-model.ts`, `apps/vscode/src/views/result-card-*.ts` | `test/auto-p1-surfaces.test.mjs`, VS Code result-card tests |

## Deferred roadmap

- **SGOS adapter:** typed Process execution, independent-task parallelism, Devices, leases, joins,
  multi-repository saga recovery, and long-running supervision. Its absence must never block Story
  Auto.
- **CMP enforcement:** make configured cause bindings and walkthrough freshness authoritative only
  after CMP has its own complete validator, migration, and recovery coverage. Current bounded CMP
  references must not be presented as that enforcement.
- **Optional runtime modes:** real interval scheduling and provenance-preserving direct Ad Hoc byte
  materialization. Neither is emulated by a hidden background process.
- **Comparative quality evidence:** register a baseline before claiming token savings preserve or
  improve first-pass verification, review-return, or rework outcomes.

## Release evidence

Evidence below was collected from the exact implementation tree at
`64cf7ddaf5e5b1296f610509da3db44fdb93a32b`:

- Release implementation commit: `64cf7ddaf5e5b1296f610509da3db44fdb93a32b`
- Full `npm test`: 4,245 passed; 0 failed, cancelled, skipped, or todo
- `npm run check`: 1,252 checks passed across 136 skills, 2 agents, and 1 extension
- VS Code: typecheck and production build passed; focused UI suite passed 253/253
- Auto security, contract, migration, Candidate, recovery, repair, and report tests passed, including
  the 128-iteration portable pause/halt lock-race test
- Operation-model catalog check passed
- Package dry run passed with 1,043 entries and the new runtime schemas/modules included
