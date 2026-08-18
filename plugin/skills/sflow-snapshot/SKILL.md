---
name: sflow-snapshot
description: Read a bounded revision-aware snapshot of governed work and optional diagnostic timings.
disable-model-invocation: true
argument-hint: "[WORK-ID] [--include <slice>]"
---
# Read a governed snapshot

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.

1. Run `singularity-flow snapshot $ARGUMENTS --json`.
2. Preserve the revision, included slices, freshness, not-modified result, warnings, and timings.
3. When the caller supplies `--if-revision`, do not fetch a replacement payload after `notModified` unless asked.
4. Snapshot is read-only. Do not infer omitted source content or use timing data as workflow evidence.

