---
name: sflow-approve
description: Review and approve a submitted phase as the current Git identity, recording its human authority group, phase-default agent, self-approval warning, hashes, commit, and push.
argument-hint: "[WORK-ID] [--fetch]"
disable-model-invocation: true
---
# Approve the submitted phase

Sequence gates may be hard or soft. On `Out of sequence`, stop immediately and relay the error. On `Soft sequence warning`, show the full warning and leave the interactive `continue` decision to the human; never self-confirm. Use `singularity-flow nextsteps` only for read-only guidance and never edit managed state to bypass a gate.

The current Git identity must match one of the phase's configured approval authority groups. The governed agent is selected by the phase contract and never grants approval permission.

1. Before opening the mutating approval command, run `singularity-flow phase show <phase> --json`. In the visible assistant response, reproduce every returned generated current-phase text document in full between `--- BEGIN <path> ---` and `--- END <path> ---`, preceded by its stable ID, kind, byte count, and SHA-256. A Shell/tool block, even when it contains the text, is collapsible and does not satisfy artifact review. Present binary/image absolute paths and metadata. Never say “shown above,” “rendered above,” or “documents shown.” Never ask for approval based only on a filename or summary.
2. Prefer `singularity-flow approve <WORK-ID> --fetch` in a persistent interactive shell; omit the ID only when already on its branch. The CLI displays the documents again immediately before confirmation so terminal review has the same guarantee. If persistent stdin or `write_bash` is unavailable, use the selection-receipt bridge below and keep the reviewer inside Copilot.
3. Show the reviewer identity, matched authority group, and automatically selected phase agent. If the identity is unauthorized, stop; changing agents is not a workaround.
6. Show the phase, artifact hashes, checks, token usage, prior decisions, and whether this identity generated the phase.
7. Require the reviewer to type the exact phase name for final confirmation; selection UI must not weaken this deliberate approval control. Self-approval is allowed but must remain visibly warned and must never be described as independent review.
8. The CLI commits and pushes the decision and advances only after the distinct-human-identity threshold is met.
9. Report the decision commit, reviewer identity, authority group, governed agent, identity assurance, self-approval status, remaining approvals, and next phase. Do not merge, deploy, or modify Jira.
10. When the approval threshold advances the workflow, reproduce the CLI's `Context boundary` and `Next Copilot actions` lines exactly. If the policy says `new`, stop and ask the contributor to run `/clear` and then `/sflow-next`; do not begin the next phase in the current conversation. If it says `compact`, ask for `/compact` before `/sflow-next`. `keep` may continue normally.

Selection-receipt bridge for shells without persistent stdin:

1. Run `singularity-flow choices begin approve <WORK-ID> --fetch --json`. This synchronizes the exact work branch before issuing a 15-minute receipt bound to the branch HEAD, submitted phase, generation, artifact hashes, work ID, and current Copilot session when available.
2. Show the receipt's reviewer identity, authority result, complete phase review, automatic agent, and self-approval warning. Ask the reviewer to type the exact phase ID shown in `approvalContext.phase`. Do not supply, autocomplete, infer, or silently record it.
3. Record the exact typed response with `singularity-flow choices answer <TOKEN> phase-confirmation <TYPED-PHASE> --json`. The command accepts only the current phase ID.
4. After the receipt says `ready: true`, run `singularity-flow approve <WORK-ID> --fetch --selection-receipt <TOKEN>`. Never add `--yes`.
6. The CLI revalidates the branch HEAD and all approval context, consumes the receipt exactly once, writes the audited decision with channel `copilot-selection-receipt`, commits, and pushes. A changed phase, generation, artifact hash, branch HEAD, identity threshold, or expired/consumed receipt fails safely.
