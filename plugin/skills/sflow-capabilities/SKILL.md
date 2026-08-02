---
name: sflow-capabilities
description: Inspect the configured Singularity capability tree and explain the effective inherited policy for a selected capability.
---

# Singularity Flow capability policy

What an organisation builds is a tree of capabilities with exactly one root. A
capability that names a repository is a leaf that **ships**; one that names no
repository **groups** the capabilities beneath it. Kind is a classification and
says nothing about which of the two it is — the repository does.

1. Run `singularity-flow capabilities list`.
2. Ask which configured capability to inspect when it is not clear from context.
3. Run `singularity-flow capabilities show <ID> --json`.
4. Explain the root-to-leaf path and effective restrictions.
5. Do not edit `singularity/capabilities.yml` by hand. When the contributor asks
   to change the map, use `/sflow-capability-map`, which validates every write
   and pushes to the lead repository that holds the map.

Missing values inherit. Empty allowlists deny all. Required checks and protected
paths accumulate. Every fold is monotonic: a child may tighten what an ancestor
set and can never loosen it.

These commands read the map in the repository you are standing in. To read the
map of an organisation without a checkout, use
`singularity-flow capability organisation <LEAD-URL> --json`.
