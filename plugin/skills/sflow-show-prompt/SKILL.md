---
name: sflow-show-prompt
description: Inspect the exact governed phase prompt and summarize its composition without copying artifacts or source into chat.
disable-model-invocation: true

---

# Show the effective phase prompt

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. A bounded result names `agentOutput.read` ranges and `omittedFields` text files; read all in one response with your file tool, at the exact paths in the checkout's `.sflow/out/`. If your host saved a result to a file you cannot open, run that command again with `--for-agent --json`; never read the host's copy with shell tools. If a path SFlow returned fails to open, copy it again exactly from the result and open it once more; only then report it unopened, with the path and error.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`, or as is from a non-Git (chat) folder: SFlow finds the bound checkout; never refuse or wrap for it; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow wm show-prompt`, forwarding `$ARGUMENTS` unchanged when present.
2. The default command is read-only. `--record-audit` may create the immutable local generation-prompt receipt and prompt-audit entry used for a real Copilot handoff. Do not build the world model, prepare or publish an artifact, create a Git commit, or change workflow state.
3. Read the complete skill and `GOVERNED PHASE PROMPT` sections privately for the audit; never copy their artifact/code bodies into chat. Summarize the selected skill, phase, agent, input sources, grounding availability and limitations from that exact output.
4. Preserve exact prompt bytes in command output. Link only verified prompt/skill paths when supplied; otherwise offer the exact read-only command for full inspection outside chat. Do not invent a preview path or claim a summary is the complete prompt.
5. If the command reports a missing session, work item, phase, or governed agent, report that exact prerequisite and stop. If it reports unavailable World-Model context, preserve that status and continue the handoff; do not silently select or generate anything.
6. Explain that the first section is Copilot's skill contract and the second is the effective governed prompt. Report no Git commit or workflow transition. With `--record-audit`, report the returned immutable prompt receipt and audit write without reproducing their bodies.
