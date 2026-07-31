---
name: sflow-capabilities
description: Inspect the configured Singularity capability tree and explain the effective inherited policy for a selected capability.
---

# Singularity Flow capability policy

1. Run `singularity-flow capabilities list`.
2. Ask which configured capability to inspect when it is not clear from context.
3. Run `singularity-flow capabilities show <ID> --json`.
4. Explain the root-to-leaf path and effective restrictions.
5. Do not edit `singularity/capabilities.yml` without an explicit request.

Missing values inherit. Empty allowlists deny all. Required checks and protected
paths accumulate.
