# Reference repositories at Story intake

Use a reference repository when a Story must understand existing code but must deliver into a
different repository. A typical example is generating a new PySpark batch rule engine from a Java
service while leaving the Java repository unchanged.

This is intentionally different from a Capability repository:

| Repository role | Story branch | SFlow commits/pushes | Used for generation |
| --- | --- | --- | --- |
| Delivery target | yes | yes, through lifecycle publication | yes |
| Capability delivery member | yes | yes, when the Capability spans repositories | yes |
| Reference repository | never | never | yes, read-only at one pinned commit |

## Start a reference-driven Story

Create the empty target repository in your approved Git provider first, clone it, initialize SFlow,
and start the Story from that target checkout:

```sh
singularity-flow start SPARK-RULES-1 \
  --from-branch main \
  --work-type reference-driven-build \
  --title "Create the PySpark batch rule engine" \
  --description "Reproduce the approved Java rule semantics in a new PySpark batch implementation; do not change the Java API" \
  --acceptance-criteria "Equivalent rule outcomes for the approved fixtures" \
  --reference-repository java-rule-engine=https://github.example/office/java-rule-engine.git \
  --reference-branch java-rule-engine=release/2026-q3
```

Both reference options may be repeated. The ID connects each URL to its branch and must use
lower-case kebab case. SFlow refuses credentials embedded in a URL.

At intake SFlow:

1. observes the exact remote branch without changing either repository;
2. pins its advertised commit and tree in the Story workflow snapshot and
   `context/reference-repositories.json`;
3. materializes a detached checkout under
   `.singularity-flow/reference-repositories/<id>` in the Story checkout;
4. excludes that machine-local directory through Git's local exclude file; and
5. verifies the checkout before every phase preparation.

The branch is provenance, not a moving dependency. If it advances tomorrow, this Story continues to
read the SHA it pinned today. Start a new Story to intentionally consume the newer revision.

## Inspect and recover

```sh
singularity-flow story references list --work-id SPARK-RULES-1
singularity-flow story references verify --work-id SPARK-RULES-1 --json
singularity-flow story references materialize --work-id SPARK-RULES-1
```

`materialize` creates missing checkouts only. It never resets or deletes an existing checkout. A
dirty, attached, wrong-origin, wrong-commit, or wrong-tree reference is treated as tampering and
reported for human inspection. Move that local directory aside and rerun materialization if you
want a clean reproduction; the governed Story pin does not change.

On another laptop, resume the Story and run `story references materialize`. The exact references
come from the Story branch, not from machine-local workspace configuration.

## VS Code and Copilot

The **Start work** form shows **Reference repositories** for Stories. Enter one line per source:

```text
java-rule-engine | https://github.example/office/java-rule-engine.git | release/2026-q3
```

For Copilot `/sf-start`, supply the same ID, URL, and branch when asked. `/sf-code` verifies the
reference set and uses only the returned repository-relative paths. It must not edit or reset those
paths. The target repository remains the only place application changes can be published.
