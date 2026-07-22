---
name: sflow-start
description: Interactively choose Jira or manual intake, collect the story and documents, then select a configured workflow template and persona and publish durable Singularity Flow state.
argument-hint: "<WORK-ID> [--jira | manual story details] [documents and URLs]"
disable-model-invocation: true
---
# Start Singularity Flow work

Use Copilot's interactive selection bridge for every finite choice:

- Start the Singularity Flow command in a persistent interactive shell. When it prints `Choose intake source`, `Choose workflow template`, or `Choose persona`, call `ask_user` with the displayed labels, IDs, and descriptions as selectable options.
- Never infer or preselect an answer. Map the chosen ID to the displayed number and send that number plus a newline to the same shell process with `write_bash`.
- If `ask_user` is unavailable or disabled, stop and tell the contributor to run the command directly in their terminal. Never pass `--type` or `--persona`, set a selection environment variable, or edit the session file.

1. Treat the invocation arguments as explicit user intent, but do not invent a work ID.
2. Run `singularity-flow version`. If unavailable, explain that the reviewed npm package must be installed; do not install an unknown package automatically.
3. Run `git status --short` and report existing changes. Singularity Flow refuses a dirty tree unless `--allow-dirty` was supplied.
4. If `.singularity/workflow.yml` is absent, run `singularity-flow init` on the base branch and ask the user to commit the generated workflow, templates, personas, and builder prompt before starting work.
5. Use `ask_user` to select whether the source is a Jira story or manual description and documents. Finish source intake before showing or choosing a workflow template. For Jira, use `--jira`. For manual intake, collect the title, user or audience, problem, desired outcome, in/out scope, stakeholders, urgency, constraints, dependencies, measurable acceptance criteria, risks, notes, and every local document or HTTPS reference the user wants attached. Do not invent missing answers; mark them as open questions.
6. For manual intake, create a temporary YAML or JSON story file outside tracked repository paths using the structure in `examples/manual-story.yml`. Use absolute paths for supplied local documents, or paths relative to the story file, and include URLs under `documents`. Run `singularity-flow start <WORK-ID> --story-file <file>` in an interactive terminal. The CLI imports and publishes every listed document. Explicit `--document <path>` and `--document-url <url>` options may be repeated for additional inputs.
7. For Jira intake, run `singularity-flow start <WORK-ID> --jira` in the persistent interactive shell. After Jira or manual intake is complete, use the selection bridge for the immutable workflow template and initial persona; never choose them for the user.
8. Confirm that the current branch exactly equals the work ID.
9. Read the created `workflow.json`, `STATUS.md`, `source.json`, `USER-STORY.md`, and `documents.json` when documents were supplied.
10. Summarize the source, imported documents and stable `DOC-nnn` IDs, current phase, required artifact, open questions, and next valid action.
11. Offer `/sflow-documents upload` for later supporting inputs during configured initial phases.
12. Do not generate the active artifact unless also requested. Recommend `/sflow-nextsteps` for the read-only ordered plan, `/sflow-next` to execute one next action, `/sflow-help` to explain the selected template, and `/sflow-phase` to begin its current phase directly.

`--jira` uses direct Jira REST through the npm utility and environment credentials. It does not use MCP or an IDE Jira plugin.
