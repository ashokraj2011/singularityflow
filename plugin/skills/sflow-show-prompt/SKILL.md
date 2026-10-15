---
name: sflow-show-prompt
description: Inspect the exact governed phase prompt and summarize its composition without copying artifacts or source into chat.
disable-model-invocation: true

---

# Show the effective phase prompt

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. A command's JSON is complete even when long: if your tool saved it to a file, read that file to its end before acting; never treat a saved or long result as truncated or stop because of its size.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Run `singularity-flow wm show-prompt`, forwarding `$ARGUMENTS` unchanged when present.
2. The default command is read-only. `--record-audit` may create the immutable local generation-prompt receipt and prompt-audit entry used for a real Copilot handoff. Do not build the world model, prepare or publish an artifact, create a Git commit, or change workflow state.
3. Read the complete skill and `GOVERNED PHASE PROMPT` sections privately for the audit; never copy their artifact/code bodies into chat. Summarize the selected skill, phase, agent, input sources, grounding availability and limitations from that exact output.
4. Preserve exact prompt bytes in command output. Link only verified prompt/skill paths when supplied; otherwise offer the exact read-only command for full inspection outside chat. Do not invent a preview path or claim a summary is the complete prompt.
5. If the command reports a missing session, work item, phase, or governed agent, report that exact prerequisite and stop. If it reports unavailable World-Model context, preserve that status and continue the handoff; do not silently select or generate anything.
6. Explain that the first section is Copilot's skill contract and the second is the effective governed prompt. Report no Git commit or workflow transition. With `--record-audit`, report the returned immutable prompt receipt and audit write without reproducing their bodies.
