# CALM Architecture from the World Model

Singularity Flow can publish a deterministic FINOS CALM 1.2 architecture document beside a
registered-v4 World Model. The product is named `arch.calm@1`. It uses the exact capability map,
approved workflow policy, and admitted World Model facts; it never asks a model to invent an
architecture.

The projection is a derived view, not a second source of truth. Change the capability map, policy,
or source facts and rebuild the World Model. Do not edit files below
`singularity/world-model/projections` by hand.

## Enable it safely

Open **Configuration Center → World model → Behavior & generation settings → Architecture
projection**, enable **Generate CALM architecture**, and publish the configuration. The recommended
rollout is enabled and optional:

```yaml
worldModel:
  format: registered-v4
  projections:
    arch.calm:
      enabled: true
      required: false
      contract: arch.calm@1
      calm: { schemaRelease: "1.2", strict: true }
```

Optional means a projection-toolchain failure creates a durable refusal receipt but does not block
the ordinary World Model or Story work. Set `required: true` only after the repository has reviewed
its classifications and the packaged validator works on every supported machine.

## Build and reuse

Build it with or without an active Story:

```sh
singularity-flow wm build --format registered-v4 --projections arch.calm
```

The projection, source map, official-validator receipt, toolchain lock, and World Model manifest are
committed in one transaction to the configured state branch. The application branch is unchanged.
Every Story reuses that state product while its source, scope, capability, configuration, registry,
and toolchain identities remain exact. `--projections all` selects every projection declared in
approved configuration; it is refused when the catalog is empty rather than treating `all` as a
literal projection.

The build remains model-free when the WMB v4 composer is deterministic. CALM validation runs with
the packaged `@finos/calm-cli` and packaged CALM 1.2 schemas; no schema download is required.

## Inspect it

In VS Code, open **Configuration Center → World model → System architecture**. The Explorer provides
separate component, connection, ordered-flow, governance-control, and evidence-gap tables. It lists
workflow phase usage, opens the exact content-addressed CALM JSON, and prepares reviewed export or
comparison prompts without executing them. **Story plan** prepares a read-only Copilot request for
the active Story's approved planned overlay; candidate or unapproved intent is refused.

The equivalent model-free commands are:

```sh
singularity-flow architecture show
singularity-flow architecture validate
singularity-flow architecture explain <ELEMENT-ID>
singularity-flow architecture sources <ELEMENT-ID>
singularity-flow architecture doctor
```

`explain` and `sources` identify the exact governed fact behind an element and where its authoritative
change must be made. `/sf-architecture` provides the same bounded route in Copilot without invoking
a model.

## Story architecture intent

A Story can describe a proposed architecture delta without changing the shared base. Prepare a
reviewed JSON candidate containing `phase` and explicit `clauses`. The owning phase's stored
`generation` is its last accepted publication, so SFlow targets the next publication (`P + 1`): a
new phase at generation 0 produces a generation-1 intent. You may supply `generation`, but it must
be an integer exactly equal to that inferred target.

```json
{
  "phase": "planning",
  "clauses": [
    {
      "clauseId": "WRK-123:ARCH-001",
      "operation": "add-node",
      "elementId": "orders-api",
      "required": true,
      "value": {
        "node-type": "service",
        "name": "Orders API",
        "description": "Handles order requests"
      }
    }
  ]
}
```

Initialize, publish, submit, and approve in this order:

```sh
singularity-flow architecture intent init --work-id WRK-123 --from design/architecture-intent.json
singularity-flow architecture intent validate --work-id WRK-123
singularity-flow phase publish planning
singularity-flow submit planning
singularity-flow approve planning --work-id WRK-123
singularity-flow architecture intent render --work-id WRK-123
singularity-flow architecture show --work-id WRK-123 --planned
```

Initialization creates only a guarded Story draft; it does not increment, publish, submit, or
approve a phase. Repeating an identical initialization against the same base and target returns the
existing intent. A different intent is never overwritten implicitly. While the owning phase is
current and authorable, replace it with an exact compare-and-swap:

```sh
singularity-flow architecture intent revise \
  --work-id WRK-123 \
  --from design/revised-architecture-intent.json \
  --expect-intent sha256:<CURRENT-INTENT-DIGEST>
```

Revision cannot change the owner phase. If that phase is already approved, reopen it through the
normal lifecycle first; the revised intent targets the next publication and does not inherit the
old approval. Publication commits and binds the exact intent bytes to its owning phase and target
generation. The normal phase approval ceremony then approves that publication under its full
authority and quorum policy. Approval is not inferred from an arbitrary intent field or from draft
creation.

The planned CALM document is Story-local and is cryptographically bound to the exact base World
Model and projection. It cannot replace or republish the shared architecture. After implementation
and a refreshed deterministic World Model, record the comparison with:

```sh
singularity-flow architecture intent verify --work-id WRK-123
```

Standalone verification compares the projection with a clean current Git source by default. If
the reviewed implementation is intentionally uncommitted, pass the exact Candidate Snapshot
returned by `singularity-flow wm snapshot` with `--candidate-snapshot sha256:<DIGEST>`. The
Candidate must still match the current source byte-for-byte and its base revision must still be
current; the continued existence of an older Candidate never authorizes later implementation
bytes. Verification does not capture a Candidate, rebuild the model, or commit source implicitly.

The fulfilment receipt keeps `fulfilled`, `missing`, `deviated`, `not-observable`, and `unplanned`
distinct. It resolves the intent base from bounded local state-branch history, so unrelated
architectural drift cannot be presented as successful delivery. A self-hashed receipt is displayed
as `recorded-unverified`, not as gate-ready proof. At every enforcing gate, SFlow independently
resolves the approved intent, historical base, current projection and source maps, recomputes the
complete deterministic report, and compares it with the saved receipt.

If the gate returns `WMC_INTENT_REPORT_MISMATCH`, do not edit the receipt. First correct any reported
base-history, current-source, Candidate Snapshot, or state-authority problem; then rerun
`singularity-flow architecture intent verify --work-id WRK-123`. That command takes the Story lock,
rechecks the current intent and Story revision, and atomically replaces the stale report with the
recomputed result. Review it and retry the lifecycle gate. A matching but blocking report remains
`WMC_INTENT_UNFULFILLED` until the implementation satisfies the required clauses and unplanned
architecture changes are resolved.

## Trust and privacy boundaries

- Only reviewed assurance grades may create architecture elements. Heuristic and model-advisory
  facts remain visible as gaps but cannot become nodes or relationships.
- Source maps use repository-relative paths and exact hashes. They exclude absolute machine paths,
  credentials, and individual approval-group members.
- The state-branch writer regenerates normalized snapshots from current approved source bytes,
  reconstructs the projection, and repeats the configured official validation before committing.
- Validator credentials and proxy settings are removed and a process bootstrap denies direct socket,
  DNS, HTTP, HTTPS, datagram, and `fetch` access.
- Export requires an explicit repository-relative destination plus confirmation of an exact preflight
  digest. It never changes World Model or Story authority.
