---
name: sflow-show
description: Expand one registered Singularity Flow reference handle deterministically, with optional section, pointer, or range selection.
disable-model-invocation: true
argument-hint: "<sfref:v1:...> [--section HEADING | --json-pointer POINTER | --range RANGE] [--max-bytes N]"
---
# Show a governed reference

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. A bounded result names `agentOutput.read` ranges and `omittedFields` text files; read all in one response with your file tool, at the exact paths in the checkout's `.sflow/out/`. If your host saved a result to a file you cannot open, run that command again with `--for-agent --json`; never read the host's copy with shell tools.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`, or as is from a non-Git (chat) folder: SFlow finds the bound checkout; never refuse or wrap for it; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Run `singularity-flow show <HANDLE>` with only the selection options explicitly requested by the user:

- `--section "<exact Markdown heading>"`
- `--json-pointer "<RFC 6901 pointer>"`
- `--range "lines:<start>..<end>"` or `--range "bytes:<start>..<end>"`
- `--max-bytes <N>` up to 65536

Only `sfref:v1:` handles registered in committed Story or Initiative context are accepted. A failed hash, stale revision, ambiguous section, human-only visibility, or unknown handle is a hard stop. Never fall back to arbitrary filesystem reads.
