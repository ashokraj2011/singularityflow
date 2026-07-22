---
name: sflow-inbox
description: Fetch and display the repository-wide inbox of committed work-item phases awaiting approval, then safely open a selected review.
disable-model-invocation: true
---
# Open the pending approval inbox

1. Run `singularity-flow inbox --json`. This fetches the configured Git remote and reads committed work-item state without checking out every branch.
2. If `items` is empty, report that the remote approval inbox is clear. Do not infer that uncommitted or unpublished work is ready for review.
3. Show every pending item with its work/Jira ID, title, phase, generation, approval count, waiting time, allowed reviewer personas, artifact path, remote commit, and self-approval warning.
4. Use Copilot's `ask_user` facility to let the contributor select one exact work/Jira ID. Never infer or preselect an item.
5. Run `singularity-flow session attach <WORK-ID>` for the exact selection. This may create a local tracking branch and fast-forward it, but it must never merge, rebase, reset, stash, or discard local work.
6. Continue through `/sflow-session` if persona selection is required. The contributor must choose the persona; never select an approval-capable persona on their behalf.
7. Run `singularity-flow phase show <PHASE> --json` and reproduce every generated text document in the visible response for review. Also mention supporting evidence available through `/sflow-documents`.
8. Stop after presenting the complete review context. Offer `/sflow-approve` and `/sflow-reject` as explicit next actions, but never decide or approve automatically.
