---
name: sflow-show
description: Expand one registered Singularity Flow reference handle deterministically, with optional section, pointer, or range selection.
disable-model-invocation: true
argument-hint: "<sfref:v1:...> [--section HEADING | --json-pointer POINTER | --range RANGE] [--max-bytes N]"
---
# Show a governed reference

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

Run `singularity-flow show <HANDLE>` with only the selection options explicitly requested by the user:

- `--section "<exact Markdown heading>"`
- `--json-pointer "<RFC 6901 pointer>"`
- `--range "lines:<start>..<end>"` or `--range "bytes:<start>..<end>"`
- `--max-bytes <N>` up to 65536

Only `sfref:v1:` handles registered in committed Story or Initiative context are accepted. A failed hash, stale revision, ambiguous section, human-only visibility, or unknown handle is a hard stop. Never fall back to arbitrary filesystem reads.
