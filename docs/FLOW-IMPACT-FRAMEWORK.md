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
  quality guardrails pass.

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
