---
name: sflow-inspect
description: Inspect the selected Story, progress, documents, evidence, prompt composition, and next actions without mutation.
disable-model-invocation: true
argument-hint: "[WORK-ID] [status|progress|documents|prompt|next]"
---
# Inspect governed work

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested.

1. Resolve the requested Story through `singularity-flow session status --json` and `singularity-flow status <WORK-ID> --json`. If selection is ambiguous, show candidates and stop.
2. Route the requested view to `progress`, `documents list`, `show-prompt`, `report`, or `nextsteps`. With no view, show status, progress, generated artifacts, approvals, warnings, and next actions.
3. Preserve exact artifact paths, hashes, identities, self-approval warnings, model/token availability, and pending-publication state.
4. Do not prepare, publish, submit, approve, reject, synchronize, or edit files. Offer `/sf-continue` for an explicitly reviewed mutation.
