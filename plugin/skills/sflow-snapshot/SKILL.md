---
name: sflow-snapshot
description: Read a bounded revision-aware snapshot of governed work and optional diagnostic timings.
disable-model-invocation: true
argument-hint: "[WORK-ID] [--include <slice>]"
---
# Read a governed snapshot

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow snapshot $ARGUMENTS --json`.
2. Preserve the revision, included slices, freshness, not-modified result, warnings, and timings.
3. When the caller supplies `--if-revision`, do not fetch a replacement payload after `notModified` unless asked.
4. Snapshot is read-only. Do not infer omitted source content or use timing data as workflow evidence.

