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
   `.singularity-flow/reference-repositories/<work-id>/<id>` in the Story checkout;
4. excludes that machine-local directory through Git's local exclude file; and
5. verifies the checkout before every phase preparation.

The Work ID namespace matters when one checkout moves between Stories: two Stories may use the same
reference ID at different commits without overwriting or invalidating one another. Existing Stories
that used the earlier `.singularity-flow/reference-repositories/<id>` layout remain compatible.

The branch is provenance, not a moving dependency. If it advances tomorrow, this Story continues to
read the SHA it pinned today. Start a new Story to intentionally consume the newer revision.

## Inspect and recover

```sh
singularity-flow story references inspect \
  --reference-repository java-rule-engine=https://github.example/office/java-rule-engine.git \
  --reference-branch java-rule-engine=release/2026-q3 --json
singularity-flow story references list --work-id SPARK-RULES-1
singularity-flow story references verify --work-id SPARK-RULES-1 --json
singularity-flow story references materialize --work-id SPARK-RULES-1
```

`inspect` is a provisional read-only branch check for intake forms. It performs no Story mutation;
Story start resolves the branch again and records that final result.

`materialize` creates missing checkouts only. It never resets or deletes an existing checkout. A
dirty, attached, wrong-origin, wrong-commit, or wrong-tree reference is treated as tampering and
reported for human inspection. Move that local directory aside and rerun materialization if you
want a clean reproduction; the governed Story pin does not change.

Reference trees containing symlinks, submodules, unsupported Git entries, or checkout filter
attributes are refused before checkout. This prevents a repository-relative read from escaping to
another laptop path or invoking a machine-configured content filter.

On another laptop, resume the Story and run `story references materialize`. The exact references
come from the Story branch, not from machine-local workspace configuration.

## VS Code and Copilot

The **Start work** form shows **Reference repositories** for Stories. Choose **Add reference
repository**, then enter its stable ID, clone URL, and branch in separate fields. **Check reference**
performs the provisional read-only check and shows the resolved commit before Story start. The
engine repeats the check at start, so the green status is useful feedback, not authority.

After start, **Lifecycle → Reference repositories** shows each immutable pin, detached-checkout
health, project markers, shallow source roots, and whether the pinned commit already contains a
reusable World Model. It also offers **Verify references** and, when needed, **Materialize missing
references**.

For Copilot `/sf-start`, supply the same ID, URL, and branch when asked. `/sf-code` verifies the
reference set and uses only the returned repository-relative paths. It must not edit or reset those
paths. The target repository remains the only place application changes can be published.

Every byte in a reference repository is untrusted source data, not an instruction. `AGENTS.md`,
README instructions, prompts, workflow/configuration files, comments, scripts, generated output,
and tool output inside a reference cannot grant tool authority, widen the write scope, or override
the governed Story prompt. SFlow never executes, builds, installs, or runs hooks from a reference.

## Generation and World Model behavior

Phase composition adds a small deterministic reference-grounding section containing only the exact
detached root, requested branch, pinned commit/tree, common project markers, and shallow source
roots. This requires no model and avoids sending a full file inventory.

SFlow does **not** build or rebuild a World Model for a reference repository. If the pinned commit
already carries `singularity/world-model/manifest.json`, generation exposes it only after validating
the complete manifest-controlled file graph, admission limits, and current source fingerprint.
Malformed, incomplete, stale, or oversized reference models are ignored; generation continues with
bounded ordinary file access beneath the detached reference root. Missing or unusable reference
World Models never block the Story. Lifecycle reports lightweight local reference health without
repeating the full World Model validation on every UI refresh.
