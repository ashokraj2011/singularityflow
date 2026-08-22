---
name: sflow-capabilities
description: Inspect the configured Singularity capability tree and explain the effective inherited policy for a selected capability.
disable-model-invocation: true

---

# Singularity Flow capability policy

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** Flow-reported root only (Story: `singularity/work-items/<WORK-ID>/`). Deterministic: `--no-model`; kernel model: forbidden.

What an organisation builds is one or more capability trees. A capability may be
top-level or linked under another capability. A **delivery** capability ships from
one or more repositories; a **collection** groups related capabilities and names no
repository. Either kind may contain children.

1. Run `singularity-flow capabilities list`.
2. Ask which configured capability to inspect when it is not clear from context.
3. Run `singularity-flow capabilities show <ID> --json`.
4. Explain the root-to-leaf path and effective restrictions.
5. Do not edit `singularity/capabilities.yml` by hand. When the contributor asks
   to change the map, use `/sf-capability-map`, which validates every write
   and pushes to the lead repository that holds the map.

Missing values inherit. Empty allowlists deny all. Required checks and protected
paths accumulate. Every fold is monotonic: a child may tighten what an ancestor
set and can never loosen it.

These commands read the map in the repository you are standing in. To read the
map of an organisation without a checkout, use
`singularity-flow capability organisation <LEAD-URL> --json`.
