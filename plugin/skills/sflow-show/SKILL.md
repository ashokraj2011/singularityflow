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
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

Run `singularity-flow show <HANDLE>` with only the selection options explicitly requested by the user:

- `--section "<exact Markdown heading>"`
- `--json-pointer "<RFC 6901 pointer>"`
- `--range "lines:<start>..<end>"` or `--range "bytes:<start>..<end>"`
- `--max-bytes <N>` up to 65536

Only `sfref:v1:` handles registered in committed Story or Initiative context are accepted. A failed hash, stale revision, ambiguous section, human-only visibility, or unknown handle is a hard stop. Never fall back to arbitrary filesystem reads.
