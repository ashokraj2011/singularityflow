---
name: sflow-approve
description: Review and approve a submitted phase as the current Git identity, recording its human authority group, phase-default agent, self-approval warning, hashes, commit, and push.
disable-model-invocation: true
argument-hint: "[WORK-ID] [--fetch]"

---
# Approve the submitted phase

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision.

On `Out of sequence`, relay and stop. On `Soft sequence warning`, show it and leave `continue` to the human. Never edit state to bypass a gate. The current Git identity—not the governed agent—must match a configured approval authority.

1. Run `singularity-flow phase show <phase> --json`. In the visible assistant response, reproduce every returned generated current-phase text document in full between `--- BEGIN <path> ---` and `--- END <path> ---`, with ID, kind, bytes, and SHA-256. A Shell/tool block does not satisfy artifact review. Show binary/image paths and metadata. Never say “shown above.” Never ask for approval based only on a filename or summary.
2. Show reviewer identity/authority, phase agent, hashes, checks, usage, prior decisions, generator identity, and any self-approval warning. Unauthorized identity stops; changing agents cannot grant authority.
3. Prefer `singularity-flow approve <PHASE> --work-id <WORK-ID> --fetch` in a persistent shell. Require the reviewer to type the exact phase name. Never add `--yes`.
4. Without persistent input, run `singularity-flow choices begin approve <WORK-ID> --fetch --json`. Ask the reviewer to type the exact phase ID from `approvalContext.phase`. Do not supply, autocomplete, infer, or silently record it. Run `singularity-flow choices answer <TOKEN> phase-confirmation <TYPED-PHASE> --json`, then `singularity-flow approve <TYPED-PHASE> --work-id <WORK-ID> --fetch --selection-receipt <TOKEN>` only when `ready: true`. The CLI revalidates and consumes the receipt exactly once.
5. Report commit/push, reviewer, authority, agent, assurance, self-approval, remaining threshold, and next phase. Do not merge, deploy, or alter Jira.
6. Reproduce `Context boundary` and `Next Copilot actions` exactly. For `new`, request `/clear` then `/sf-next`; for `compact`, request `/compact` then `/sf-next`; stop before the next phase.
