---
name: sflow-snapshot
description: Read a bounded revision-aware snapshot of governed work and optional diagnostic timings.
disable-model-invocation: true
argument-hint: "[WORK-ID] [--include <slice>]"
---
# Read a governed snapshot

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow snapshot $ARGUMENTS --json`.
2. Preserve the revision, included slices, freshness, not-modified result, warnings, and timings.
3. When the caller supplies `--if-revision`, do not fetch a replacement payload after `notModified` unless asked.
4. Snapshot is read-only. Do not infer omitted source content or use timing data as workflow evidence.

