---
name: sflow-approve
description: Interactively select a persona and approve a submitted Singularity Flow phase from any terminal, recording identity, persona, self-approval warning, hashes, commit, and push.
argument-hint: "[WORK-ID] [--fetch]"
disable-model-invocation: true
---
# Approve the submitted phase

Sequence gates may be hard or soft. On `Out of sequence`, stop immediately and relay the error. On `Soft sequence warning`, show the full warning and leave the interactive `continue` decision to the human; never self-confirm. Use `singularity-flow nextsteps` only for read-only guidance and never edit managed state to bypass a gate.

Anyone may choose any persona, but the chosen persona must be configured to approve the phase.

1. Before opening the mutating approval command, run `singularity-flow phase show <phase> --json`. In the visible assistant response, reproduce every returned generated current-phase text document in full between `--- BEGIN <path> ---` and `--- END <path> ---`, preceded by its stable ID, kind, byte count, and SHA-256. A Shell/tool block, even when it contains the text, is collapsible and does not satisfy artifact review. Present binary/image absolute paths and metadata. Never say “shown above,” “rendered above,” or “documents shown.” Never ask for approval based only on a filename or summary.
2. Prefer `singularity-flow approve <WORK-ID> --fetch` in a persistent interactive shell; omit the ID only when already on its branch. The CLI displays the documents again immediately before confirmation so terminal review has the same guarantee. If persistent stdin or `write_bash` is unavailable, use the selection-receipt bridge below and keep the reviewer inside Copilot.
3. When the CLI prints `Choose persona`, call Copilot's `ask_user` tool with the displayed approval-capable persona labels, IDs, and descriptions as selectable options. Never infer or preselect one.
4. Map the selected ID to the displayed number and send that number plus a newline to the same shell process with `write_bash`. Do not pass a persona flag, set a selection environment variable, edit the session file, use `--yes`, or infer any answer. If `ask_user` is unavailable or disabled, stop because explicit reviewer intent cannot be established safely.
5. Show the phase, artifact hashes, checks, token usage, prior decisions, and whether this identity generated the phase.
6. Require the reviewer to type the exact phase name for final confirmation; selection UI must not weaken this deliberate approval control. Self-approval is allowed but must remain visibly warned and must never be described as independent review.
7. The CLI commits and pushes the decision and advances only after the distinct-identity threshold is met.
8. Report the decision commit, persona, self-approval status, remaining approvals, and next phase. Do not merge, deploy, or modify Jira.

Selection-receipt bridge for shells without persistent stdin:

1. Run `singularity-flow choices begin approve <WORK-ID> --fetch --json`. This synchronizes the exact work branch before issuing a 15-minute receipt bound to the branch HEAD, submitted phase, generation, artifact hashes, work ID, and current Copilot session when available.
2. Present the returned `persona` options through `ask_user`, then record only the reviewer's exact selected ID with `singularity-flow choices answer <TOKEN> persona <PERSONA-ID> --json`.
3. Show the complete phase review and self-approval warning. Ask the reviewer to type the exact phase ID shown in `approvalContext.phase`. Do not supply, autocomplete, infer, or silently record the phase ID. Cancellation or any non-exact response stops without a decision.
4. Record the exact typed response with `singularity-flow choices answer <TOKEN> phase-confirmation <TYPED-PHASE> --json`. The command accepts only the current phase ID.
5. After the reviewer has explicitly completed both choices and the receipt says `ready: true`, run `singularity-flow approve <WORK-ID> --fetch --selection-receipt <TOKEN>`. Never add `--yes`.
6. The CLI revalidates the branch HEAD and all approval context, consumes the receipt exactly once, writes the audited decision with channel `copilot-selection-receipt`, commits, and pushes. A changed phase, generation, artifact hash, branch HEAD, identity threshold, or expired/consumed receipt fails safely.
