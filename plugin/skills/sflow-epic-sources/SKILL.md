---
name: sflow-epic-sources
description: List, upload, pin, materialize, and verify governed Epic source files used to generate requirements and Story plans.
---

# Manage Epic sources

1. Start with `singularity-flow epic sources list --epic <EPIC-KEY>`.
2. For an upload, ask for the exact provider and local path, then run `singularity-flow epic sources add --epic <EPIC-KEY> --provider <ID> --file <PATH> --mime <TYPE>`.
3. For an HTTPS reference, require a configured `https-reference` provider and run the same command with `--url` and `--label`.
4. Run `singularity-flow epic sources materialize --epic <EPIC-KEY>` before generation when the user requests verification.
5. Show every source ID, provider version, MIME type, byte count, SHA-256, local verified cache path, commit, and push.
6. Never expose provider credentials or treat a filename as sufficient provenance.
