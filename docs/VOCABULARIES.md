# Scoped closed vocabularies

Singularity Flow owns every first-party lifecycle event member in one immutable, content-addressed
registry. Producers use the exported `LIFECYCLE_EVENT` symbols. `npm run check` parses actual
production call sites and refuses an unregistered member or a direct string literal before that
producer can ship.

Runtime validation is scoped to the authority-producing operation. An unknown lifecycle write is
refused before state, commits, pushes, or ledger entries are created. The refusal identifies the
vocabulary and member and confirms that source, artifacts, tests, and valid generation intent remain
available. It does not create a repository-wide authoring lock.

## Generation start is not a lifecycle event

`singularity-flow phase begin <phase>` establishes a local authoring boundary. It creates or returns
an idempotent, hash-bound receipt under:

```text
singularity/work-items/<WORK-ID>/context/generation-start/<PHASE>-gen<N>.json
```

The command writes no lifecycle event, ledger entry, commit, or push. `phase publish` later verifies
the unchanged receipt and binds its path, SHA-256, baseline commit/tree, initial change-set digest,
and prior generation commit into the existing `artifact-generated` lifecycle event. The start receipt
remains immutable after it is consumed.

`generation-started` is intentionally not a lifecycle member. A field emitter introduced by commit
`058cc9f` was rejected by the existing reader before persistence. The repair removes that emitter;
therefore no deprecated compatibility member is required.

## Recovery for the affected build

Upgrade Singularity Flow and rerun:

```bash
singularity-flow phase begin implementation --json
singularity-flow phase publish implementation --authored governed-agent
```

If source changed before the repaired begin command could establish generation 2, review the change
set printed by the refusal and use its exact opt-in only when the Story permits adoption:

```bash
singularity-flow phase begin implementation --adopt-existing --confirm sha256:...
```

No artifact regeneration is required solely because the invalid lifecycle member was rejected.

