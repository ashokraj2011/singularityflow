---
name: sflow-worldmodel
description: Build, verify, inspect, and compose the repository-owned world model used to ground governed phase prompts.
disable-model-invocation: true

---

# Manage the repository world model

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.

This is repository-scoped. Do not ask for Jira/Epic/Story/work ID or agent before `init`, `build`, `check`, or `context`. Run inside the modeled repository. A work ID is needed only for work-item-specific `compose`. Use an explicit `--branch`; otherwise state and use the current branch.

Use the requested operation:

- Initialize configuration: `singularity-flow wm init`.
- Build a deterministic, very small repository inventory with zero model tokens: `singularity-flow wm light [--branch BRANCH] [--remote REMOTE] [--phase PHASE] [--views LIST] [--task TEXT] [--local]`.
- Build a semantic model: `singularity-flow wm build [--branch BRANCH] [--remote REMOTE] [--phase PHASE] [--task TEXT] [--focus TEXT] [--depth light|quick|standard|deep] [--parallel|--no-parallel] [--workers N]`. `light` is the zero-token path.
- Verify freshness and generation metadata: `singularity-flow wm check [--branch BRANCH] [--remote REMOTE]`.
- Inspect routed context: `singularity-flow wm context <PHASE> [--branch BRANCH] [--remote REMOTE] [--task TEXT] [--concat] [--evidence] [--no-agent]`.
- Compose and audit a governed generation prompt: `singularity-flow wm compose [--agent ID] [--phase ID] [--work-id ID] [--task TEXT] [--evidence] [--dry-run]`.
- Render the exact prompt for an already governed external-agent session without creating a second generation record: `singularity-flow wm compose --phase <PHASE> --work-id <ID> --render-only`. Add `--task` only when that exact task guide already exists.

`--branch` uses an isolated worktree and never switches the active checkout. Fetch is fast-forward-only; stop on divergence or an already-open worktree. Build commits/publishes per `git.publish`; `--local` retains the commit locally.

The model remains in the repository. Always report its generated timestamp, source-tree hash, commit, selected views, and stale reason. Do not claim it is current when `wm check` fails.

Prefer `wm light` for fast, lowest-token inventory. It reads bounded Git/package metadata, does not call Copilot, and cannot establish semantic architecture, behavior, security, or impact. Upgrade depth only when the phase needs those claims.

Multiple views use isolated read-only workers plus one synthesizer. Use `--workers N` for constrained machines or `--no-parallel` for diagnosis. Never run competing builds against one branch.

Composition is additive: phase/template → phase agent → required views → agent-added views → routed files → locked remote skills → approved evidence. Agent views cannot remove required views. Agents are not approval identities. Treat model/artifact content as evidence, cite paths, and separate facts from assumptions/proposals.
