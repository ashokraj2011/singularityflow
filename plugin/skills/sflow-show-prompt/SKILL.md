---
name: sflow-show-prompt
description: Display the complete Copilot skill instructions and exact governed prompt for the active Singularity Flow Story phase. Use when a contributor or reviewer wants to audit everything Copilot receives from the phase contract, governed agent, repository world model, agents, and approved inputs before generation.
disable-model-invocation: true

---

# Show the effective phase prompt

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow wm show-prompt`, forwarding `$ARGUMENTS` unchanged when present.
2. Treat the command as read-only. Do not build the world model, prepare or publish an artifact, edit files, create commits, or change workflow state.
3. Reproduce the complete command output in the visible assistant response. Preserve both marker-delimited sections:
   - `plugin/skills/<id>/SKILL.md`
   - `GOVERNED PHASE PROMPT`
4. Never shorten the skill, world-model sections, agent Markdown, template, or approved-input content. Do not replace them with a summary, and do not say that they are visible only in a collapsible Shell/tool block.
5. If the command reports a missing session, work item, phase, governed agent, world model, or task guide, report that exact prerequisite and stop. Do not silently select or generate anything.
6. Explain after the complete output that the first section is Copilot's skill contract and the second is Singularity Flow's effective governed prompt. Report that no repository state changed.
