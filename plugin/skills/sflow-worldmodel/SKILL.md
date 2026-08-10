---
name: sflow-worldmodel
description: Build, verify, inspect, and compose the repository-owned world model used to ground governed phase prompts.
disable-model-invocation: true

---

# Manage the repository world model

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.

This is repository-scoped. Do not ask for a work ID or agent before `init`, `build`, `check`, or `context`. A work ID is needed only for work-specific `compose`.

Use the requested operation:

- Initialize configuration: `singularity-flow wm init`.
- Build a deterministic zero-token inventory: `singularity-flow wm light [--phase PHASE] [--local]`.
- Build semantic tiers: `singularity-flow wm build [--phase PHASE] [--task TEXT] [--depth light|quick|standard|deep] [--workers N]`.
- Check exact tiers without generation or writes: `singularity-flow wm availability [--phase PHASE] [--task TEXT] [--json]`.
- Explicitly materialize missing tiers: `singularity-flow wm ensure [--phase PHASE] [--task TEXT] [--json]`. Only same-source artifacts are reused; governed publication precedes composition.
- Recover stale, process-owned temporary worktrees from interrupted builds: `singularity-flow wm cleanup --json`; use `--force` only after confirming no build runs.
- Verify freshness and generation metadata: `singularity-flow wm check [--branch BRANCH] [--remote REMOTE]`.
- Inspect routed context: `singularity-flow wm context <PHASE> [--branch BRANCH] [--remote REMOTE] [--task TEXT] [--concat] [--evidence] [--no-agent]`.
- Compose and audit a governed generation prompt: `singularity-flow wm compose [--agent ID] [--phase ID] [--work-id ID] [--task TEXT] [--evidence] [--dry-run]`.
- Render without a generation record: `singularity-flow wm compose --phase <PHASE> --work-id <ID> --render-only`.

`--branch` uses an isolated worktree and never switches the active checkout. Fetch is fast-forward-only; stop on divergence or an already-open worktree. Build commits/publishes per `git.publish`; `--local` retains the commit locally. Never run `wm ensure` merely to answer a read-only status question; show its exact command and ask the user to invoke it.

The model remains in the repository. Always report its generated timestamp, source-tree hash, commit, selected views, and stale reason. Do not claim it is current when `wm check` fails.

Prefer `wm light` for zero-token inventory. It cannot establish semantic architecture, behavior, security, or impact.

Multiple views use isolated workers plus one synthesizer. Never run competing builds against one branch.

Composition is additive: phase/template → phase agent → required views → agent-added views → routed files → locked remote skills → approved evidence. Agent views cannot remove required views. Agents are not approval identities. Treat model/artifact content as evidence, cite paths, and separate facts from assumptions/proposals.
