---
name: sflow-epic-sync
description: Synchronize an Epic lead branch and its registered Story repositories, then report exact repository and publication receipts.
---

# Synchronize an Epic

1. Resolve the Epic key from the argument or current branch.
2. Run `singularity-flow epic sync <EPIC-KEY> --json`.
3. Report every fetched repository, branch, commit, stale context, and pending publication.
4. If synchronization cannot fast-forward, stop and show the conflicting repository; never force-push.
5. End with `/sflow-epic-next <EPIC-KEY>`.
