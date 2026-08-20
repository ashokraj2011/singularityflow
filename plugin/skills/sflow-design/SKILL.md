---
name: sflow-design
description: Produce and register the architecture and design artifact for the active Singularity Flow design phase, grounded in approved requirements and the codebase.
disable-model-invocation: true
argument-hint: "[design constraints or emphasis]"

---
# Architecture and design phase

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.

1. Run `singularity-flow status --json`; stop if the current phase is not `design`, and read the exact `workItem.title` as `STORY_TITLE`.
2. Run `singularity-flow wm compose --phase design --task "$STORY_TITLE"` and use the complete returned prompt. If the exact grounding plan is missing or stale, show and run the exact returned ensure command only with explicit contributor authorization, then rerun the identical compose command. Never substitute a conversational design objective for `STORY_TITLE`. Use architecture and security grounding as evidence.
3. Read approved requirements, list/view relevant uploaded documents and designs, and inspect only the additional source locations identified by the grounding package.
4. Execute the composed prompt's **Human clarification checkpoint**. Use `ask_user` for one concise batch, wait, then record the accepted response with `singularity-flow clarification record design --response-file <json>`. Even if the evidence looks complete, ask the human to confirm the proposed boundaries, contracts, failure behavior, and material tradeoffs. Stop if interactive questions or the durable response record are unavailable.
5. Run `singularity-flow prepare design` and complete the returned document.
6. Cover components, interfaces, data flow, alternatives, compatibility, security, privacy, observability, migration, rollout, rollback, risks, and an ordered implementation plan.
7. State assumptions and tradeoffs. Do not implement production code.
8. Remove every placeholder and run `singularity-flow phase publish design --authored governed-agent --channel copilot-host`.
9. Run `singularity-flow phase show design --json`, then reproduce every published text document in full in the visible assistant response between `--- BEGIN <path> ---` and `--- END <path> ---`, with its ID, kind, byte count, and hash. A collapsible Shell/tool block does not count. Never say “shown above.” Never replace it with a summary. For binary documents, show the absolute path, metadata, and open instruction.
10. Report the publication commit and token status. Do not submit or approve automatically. End with `Next in Copilot: /sf-submit design`, followed by `Terminal equivalent: singularity-flow submit design`.
