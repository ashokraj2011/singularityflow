---
id: model-independence
title: Model independence
aliases: [no-model, model-policy, tripwire]
commands: [doctor]
related: [manual-authorship, telemetry-and-cost]
---
Every operation is classified `never`, `optional` (with a deterministic fallback), or `required`; unclassified operations are rejected, not assumed safe. One chokepoint invokes providers; the effective policy is the most restrictive in the call stack. `SINGULARITY_FLOW_NO_MODEL=1` (or `--no-model`) disables model use — most-restrictive-wins — and model-dependent commands fail fast with the manual alternative.

The guarantee is tested, not promised: CI places fake model executables on the PATH and runs a complete story lifecycle with models disabled. The model is removable; the governance is not. Copilot chat itself remains a model-hosted surface outside this guarantee's scope.
