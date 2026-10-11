---
name: sflow-inbox
description: Show what is waiting for your approval.
disable-model-invocation: true

---
# Open the pending approval inbox

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow inbox --json`. This fetches the configured Git remote and reads committed work-item state without checking out every branch.
2. If `items` is empty, report that the remote approval inbox is clear. Do not infer that uncommitted or unpublished work is ready for review.
3. Show every pending item with its work/Jira ID, title, phase, generation, approval count, waiting time, human authority groups, artifact path, remote commit, and self-approval warning.
4. Use Copilot's `ask_user` facility to let the contributor select one exact work/Jira ID. Never infer or preselect an item.
5. Run `singularity-flow session attach <WORK-ID> --json` once for that selection, then use its exact `repositoryPath`. It may create a tracking branch and fast-forward; never merge, rebase, reset, stash, or discard work. The phase agent does not change human authority. Do not attach again through `/sf-session`.
6. Run `singularity-flow phase show <PHASE> --for-agent --json`; retain current `reviewBinding` and `displayBinding`. Summarize the packet and list each artifact/brief's identity, generation/hash and verified Markdown-preview link; binary uses path/metadata. Never reproduce bodies/code/diffs. Tool output or summaries are not review; the human must review complete linked documents before approval.
7. Show current `reviewBinding`, identity/authority, checks and warnings. Document reuse never reuses approval consent. Mention `/sf-documents` for supporting evidence.
8. Stop. Offer `/sf-approve <PHASE-ID> --work-id <WORK-ID>` with actual IDs and `/sf-reject`; never decide or approve automatically.
