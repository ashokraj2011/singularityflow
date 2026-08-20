# Flow Impact Framework

The Flow Impact Framework measures whether a configured delivery approach is
associated with faster or better governed Story delivery. It is deliberately
separate from **Change impact analysis**, which predicts which repositories and
components a proposed change may affect.

## Trust boundary

- `singularity/impact.yml` defines studies, cohorts, metrics, quality guardrails,
  matching dimensions, uncertainty reporting, and privacy floors.
- Schema version 1 requires exactly two cohorts because comparison and causal
  wording are deliberately pairwise.
- Story creation snapshots that definition and its SHA-256 into immutable Story
  resolution. Later configuration changes cannot rewrite an active study.
- The lifecycle branch owns classification, exposure observations, provider
  evidence, the final receipt, and invalidations.
- The engine derives native timing and governance observations. External systems
  may contribute observations only through the strict evidence envelope.
- Missing provider data is `unavailable`; Singularity never estimates it.
- Comparison output is aggregate. The engine refuses cohorts below the configured
  privacy floor and never reports individual performance.

## Enable a study

New repositories receive an intentionally disabled starter study. Review
`singularity/impact.yml` on the configuration branch, then set `enabled: true`.
Automatic enrollment remains explicit at the configuration level:

```yaml
version: 1
automaticEnrollment: true
metricAuthorities:
  elapsed-ms: { authority: kernel-only }
  escaped-defects: { authority: external-provider, providers: [quality-system] }
studies:
  - id: governed-ai-delivery
    label: Governed AI delivery
    enabled: true
    unit: story
    method: matched-observational
    eligibility:
      workTypes: [feature, bugfix, chore]
      capabilities: []
    groups:
      - id: baseline
        label: Baseline
        assistanceMode: baseline
        weight: 1
      - id: governed-agent
        label: Governed agent
        assistanceMode: governed-agent
        weight: 1
    matching:
      dimensions: [capability, repository-class, work-type, complexity, risk, time-period]
      timePeriod: quarter
      seed: governed-ai-delivery-v1
      weighting: minimum-cohort-count
    primaryMetric:
      id: flow-time-excluding-approval-wait-ms
      direction: lower
    guardrails:
      - id: rework-cycles
        maximumRegressionPercent: 10
    reporting:
      bootstrapSamples: 1000
      confidenceLevel: 0.95
    privacy:
      individualReporting: false
      minimumCohortSize: 5
      pseudonymizeContributors: true
      allowedDimensions: [capability, repository-class, work-type, complexity, risk, time-period]
```

Supported methods are:

- `matched-observational`: reports a quality-gated observed association.
- `before-after`: reports observed change, not causality.
- `phased-rollout`: may report a causal estimate when the configured design and
  observed rollout receipts prove every predeclared wave, treatment exposure,
  adherence, crossover decision, concurrent control, and pre-trend check, and
  the quality guardrails pass. Otherwise it reports an observed association.
- `randomized`: deterministically assigns a Story to one of two reviewed prompt
  sets. Reports use intention-to-treat cohorts, disclose prompt adherence, and do
  not silently promote an open-label comparison to a causal claim.

## Compare two prompt sets

Impact schema 2 adds `prompt-set-randomized` studies without changing existing
schema-1 delivery studies. Put both Markdown prompt sets under
`singularity/prompts/`, calculate their reviewed hashes, and then add the study
to `singularity/impact.yml`:

```bash
singularity-flow impact study prompt-hash singularity/prompts/specification-a.md
singularity-flow impact study prompt-hash singularity/prompts/specification-b.md
```

```yaml
version: 2
automaticEnrollment: true
studies:
  - id: specification-prompts
    label: Specification prompt comparison
    kind: prompt-set-randomized
    generation: 1
    status: active
    hypothesis: Prompt B improves first-pass approval without increasing rework.
    method: randomized
    eligibility:
      workTypes: [feature]
      capabilities: []
    targetPhases: [specification]
    window:
      start: 2026-08-20T00:00:00.000Z
      end: 2026-09-20T00:00:00.000Z
    assignment:
      algorithm: sha256-mod-n-v1
      seed: specification-prompts-2026-q3
    variants:
      - id: prompt-a
        label: Prompt A
        prompts:
          specification:
            path: singularity/prompts/specification-a.md
            sha256: <OUTPUT FROM prompt-hash>
      - id: prompt-b
        label: Prompt B
        prompts:
          specification:
            path: singularity/prompts/specification-b.md
            sha256: <OUTPUT FROM prompt-hash>
    matching:
      dimensions: [capability, repository-class, work-type, complexity, risk, time-period]
      timePeriod: quarter
      weighting: minimum-cohort-count
    primaryMetric: { id: flow-time-excluding-approval-wait-ms, direction: lower }
    guardrails:
      - { id: rework-cycles, maximumRegressionPercent: 10 }
      - { id: first-pass-approval-rate, maximumRegressionPercent: 10 }
    reporting: { bootstrapSamples: 1000, confidenceLevel: 0.95 }
    privacy: { individualReporting: false, minimumCohortSize: 8 }
```

The two variants may differ only in the prompt Markdown. Story birth chooses a
variant with the declared hash algorithm, copies its prompt bytes into the
Story, and records `studyRunId`, variant and prompt hash in the birth state.
Governed prompt composition replaces the selected agent's prompt body while
leaving the agent, model routing, tools, skills, grounding, templates, gates and
approval ceremony unchanged. An agent override, shared-prompt drift, or change
to the copied prompt fails closed.

Each generation records both the selected prompt-definition hash and the final
composed-prompt hash. A final Impact Receipt reports exact, partial, deviated or
unavailable prompt adherence without storing prompt text in the comparison.
Increment `generation` whenever prompts, assignment, scope, metrics, guardrails,
or reporting policy change under the same study ID. Receipts are bound to both
`id@generation` and a normalized definition hash, so reusing a generation cannot
silently mix different prompt sets. Moving an unchanged run from `active` to
`closed` preserves that definition hash and its final report.
After closing a run, its Story-local copies and receipts remain reproducible, so
the shared prompt Markdown may be archived or removed after the reviewed config
no longer has an active or draft run referencing it.

## Benchmark full context strategies

The seeded `benchmarking-a` and `benchmarking-b` Story work types compare a broader treatment than
prompt wording. Both use `intake → design → implementation → testing → conformance` with identical
templates, agents and approvals. A requires the world model, bounded AST context and approval-bound
agent briefs. B disables those three features and uses full approved artifacts. Their intelligence
profile is pinned at Story birth.

Use these profiles for an operational benchmark when the whole context strategy is the independent
variable. Because a contributor chooses the work type, the result is observational unless assignment
is governed separately. Do not combine it with `prompt-set-randomized` under one study: that would
change more than one variable and invalidate the prompt-only interpretation.

## Metric authority and assurance

Every metric has one pinned authority: `kernel-only`, `external-provider`,
`attested`, or `composite`. Kernel timing and governance metrics cannot be
overridden by imported files. External-provider authority requires an explicit
provider allowlist. Conflicting authoritative observations fail verification
instead of being silently selected.

Assurance labels describe what was actually proven: `kernel-derived`,
`provider-signed`, `attested`, or `unverified-import`. A local JSON import is
never presented as provider-verified evidence merely because its envelope names
a provider.

Comparisons match within configured strata, weight those strata explicitly, and
bootstrap inside the same strata. Reports distinguish eligible, matched, and
excluded observations. Empty or unavailable guardrails never pass the quality
gate.

## Story lifecycle

1. An eligible Story is automatically assigned to a deterministic weighted cohort.
2. The plan records a transparent complexity/risk suggestion and its signals.
3. A contributor must confirm the two bands before implementation, or explicitly
   opt out with a reason.
4. Host telemetry supplies exact exposure where available. A human may add a
   clearly labelled self-reported attestation.
5. External systems may import hash-bound metric observations.
6. Story finalization creates an Impact Receipt bound to the exact source revision,
   finalization packet, evidence hashes, and pinned study configuration.
7. Reopening the Story invalidates the receipt without erasing history.

The receipt intentionally binds to the pre-publication subject revision. Its
completion commit is represented by the typed `impact-finalized` publication
event, avoiding the impossible requirement that a file hash its own commit.

## Commands

```bash
singularity-flow impact study list
singularity-flow impact study show governed-ai-delivery
singularity-flow impact study prompt-hash singularity/prompts/specification-a.md
singularity-flow impact status WORK-123
singularity-flow impact enroll WORK-123 --complexity medium --risk small --confirm
singularity-flow impact enroll WORK-123 --opt-out --reason "Pilot exclusion" --confirm
singularity-flow impact exposure status WORK-123
singularity-flow impact exposure attest WORK-123 --phase implementation \
  --level code-assisted --assurance attested --reason "Pairing session"
singularity-flow impact evidence import provider-record.json WORK-123
singularity-flow impact evidence collect build-system observation.json WORK-123 --commit <FULL-SHA> --run-id <RUN-ID>
singularity-flow impact finalize WORK-123
singularity-flow impact verify WORK-123
singularity-flow impact doctor WORK-123
singularity-flow impact compare governed-ai-delivery --filter capability=payments --json
singularity-flow impact export --study governed-ai-delivery --out impact-receipts.jsonl
```

In Copilot use `/sf-impact` with the same arguments. The skill relays deterministic
engine output and cannot weaken classification, privacy, quality, or publication
rules.

## VS Code experience

Open **Configuration → Flow Impact studies → Open Flow Impact**, or run
**Singularity Flow: Flow Impact Studies & Reports** from the Command Palette. An
active, completed, or archived Story also offers **Open Flow Impact measurement**
inside Lifecycle.

The dedicated screen has four sections:

- **Overview** shows configured studies and the selected Story's enrollment.
- **Story measurement** confirms complexity/risk, records exposure attestations,
  imports provider evidence, verifies the final receipt, and runs measurement
  diagnostics. Mutating actions still use the CLI publication transaction.
- **Study reports** runs the engine's privacy-safe cohort comparison and shows the
  evidence grade, matched cohorts, confidence interval, quality guardrails, and
  result label. It can export normalized receipts as JSON Lines.
- **Configuration** edits `singularity/impact.yml` through the governed
  configuration API. The engine validates the YAML before changing the working
  tree; it is not committed automatically and should follow the normal
  configuration review path.

This screen is intentionally separate from **Impact Analysis**, which predicts
which repositories a proposed change touches. Flow Impact measures observed
delivery outcomes across completed Story receipts.

## Evidence envelope

External evidence is JSON or YAML with schema version 1, provider identity and
version, exact Story subject, registered metric, observation status, source
provenance, capture time, and optional integrity hash. Providers cannot submit
workflow policy or approvals. Available values must be finite numbers;
`unavailable` records must not contain a guessed value.

## Metrics and interpretation

Native metrics include flow time excluding approval wait, elapsed time, approval
wait, rework, rejections, first-pass approval, checks, self-approval, sequence
overrides, input/output/cached/total tokens, model/provider identity, and cost.
Conformance gaps and escaped defects remain
`unavailable` until an exact provider supplies them.

Comparisons use deterministic matching and seeded bootstrap intervals. A result is
called a validated delivery gain only when its method permits that inference and
all quality guardrails pass. Otherwise it is labelled as an observed association,
observed change, or acceleration that has not passed the delivery-quality gate.

## Storage

```text
singularity/work-items/<WORK-ID>/measurement/
├── plan.json
├── exposure/<sha256>.json
├── evidence/<evidence-id>.json
├── impact-receipt.json
└── invalidations/<sha256>.json
```

Every mutation uses the Story publication transaction: local subject lock,
optimistic revision check, allowlisted staging, one commit, fast-forward push, and
machine-local pending-publication recovery on failure.
