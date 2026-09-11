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
reviewed JSON candidate containing `phase`, `generation`, and explicit clauses, then run:

```sh
singularity-flow architecture intent init --work-id WRK-123 --from design/architecture-intent.json
singularity-flow architecture intent validate --work-id WRK-123
# publish and approve the owning phase generation before rendering governed planned output
singularity-flow architecture intent render --work-id WRK-123
singularity-flow architecture show --work-id WRK-123 --planned
```

The planned CALM document is Story-local and is cryptographically bound to the exact base World
Model and projection. It cannot replace or republish the shared architecture. After implementation
and a refreshed deterministic World Model, record the comparison with:

```sh
singularity-flow architecture intent verify --work-id WRK-123
```

The fulfilment receipt keeps `fulfilled`, `missing`, `deviated`, `not-observable`, and `unplanned`
distinct. It resolves the intent base from bounded local state-branch history, so unrelated
architectural drift cannot be presented as successful delivery.

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
