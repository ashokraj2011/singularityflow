---
name: sflow-show-prompt
description: Display the complete Copilot skill instructions and exact governed prompt for the active Singularity Flow Story phase. Use when a contributor or reviewer wants to audit everything Copilot receives from the phase contract, governed agent, repository world model, agents, and approved inputs before generation.
disable-model-invocation: true

---

# Show the effective phase prompt

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Run `singularity-flow wm show-prompt`, forwarding `$ARGUMENTS` unchanged when present.
2. The default command is read-only. `--record-audit` may create the immutable local generation-prompt receipt and prompt-audit entry used for a real Copilot handoff. Do not build the world model, prepare or publish an artifact, create a Git commit, or change workflow state.
3. Reproduce the complete command output in the visible assistant response. Preserve both marker-delimited sections:
   - `plugin/skills/<id>/SKILL.md`
   - `GOVERNED PHASE PROMPT`
4. Never shorten the skill, world-model sections, agent Markdown, template, or approved-input content. Do not replace them with a summary, and do not say that they are visible only in a collapsible Shell/tool block.
5. If the command reports a missing session, work item, phase, or governed agent, report that exact prerequisite and stop. If it reports unavailable World-Model context, preserve that status and continue the handoff; do not silently select or generate anything.
6. Explain after the complete output that the first section is Copilot's skill contract and the second is Singularity Flow's effective governed prompt. Report that no Git commit or workflow transition occurred. When `--record-audit` was supplied, also report the local immutable prompt receipt and audit write.
