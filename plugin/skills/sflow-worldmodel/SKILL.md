---
name: sflow-worldmodel
description: Build, verify, inspect, and compose the repository-owned world model used to ground governed phase prompts.
disable-model-invocation: true

---

# Manage the repository world model

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.

This is repository-scoped. Ask for a work ID only for work-specific `compose`.

Use the requested operation:

- Initialize configuration: `singularity-flow wm init`.
- Zero-token inventory: `singularity-flow wm light [--phase PHASE] [--local]`.
- Semantic build: `singularity-flow wm build [--phase PHASE] [--task TEXT] [--depth light|quick|standard|deep] [--workers N]`.
- Read readiness: `singularity-flow wm availability [--phase PHASE] [--task TEXT] --json`.
- Materialize missing tiers: `singularity-flow wm ensure [--phase PHASE] [--task TEXT] --json`.
- Recover stale build worktrees: `singularity-flow wm cleanup --json`; use `--force` only when no build runs.
- Verify freshness: `singularity-flow wm check [--branch BRANCH] [--remote REMOTE]`.
- Inspect context: `singularity-flow wm context <PHASE> [--task TEXT] [--evidence]`.
- Compose: `singularity-flow wm compose [--agent ID] [--phase ID] [--work-id ID] [--task TEXT] [--evidence] [--dry-run|--render-only]`.
- Inspect optional structural intelligence: `singularity-flow wm ast doctor|status --json`.
- Read bounded structure: `singularity-flow wm ast context --paths <ROOT> --json` or `wm ast query --predicate symbol|import|language|path --value <VALUE>`.
- Build local structure: `singularity-flow wm ast build --paths <ROOT> --json`; resume only with its returned handle.
- Preview cache pruning with `singularity-flow wm ast cache prune --dry-run`; apply its exact confirmation.

`--branch` uses an isolated worktree. Fetch is fast-forward-only. Builds follow `git.publish`; `--local` keeps the commit local. Never run `wm ensure` for a read.

Before starting another build, recover stale, process-owned temporary worktrees with `singularity-flow wm cleanup --json`; do not remove a live build's worktree.

Report generated time, source hash, commit, views, and stale reason. Never call a failed `wm check` current.

`wm light` is zero-token inventory, not semantic architecture, behavior, security, or impact.

The zero-token built-in AST facts are lexical `text` assurance, never parsed syntax. `syntax` or
`semantic` requires a validated executed adapter, not an advertisement. AST defaults to the Story's
pinned cone, or changed paths without one. Use `--all` only on request. Results contain no source bodies.

For a read-only Copilot host, resolve `show structural intelligence status`, `show bounded
structural context`, or `query repository symbols` through `sflow_resolve`, then use only the issued
read handle with `sflow_read`. These gateway reads are model-free and cannot populate the cache.
Required predicates run at publication and their receipt is revalidated at submission; manual
`wm ast gate` never bypasses lifecycle policy.

Never run competing builds on one branch. Composition is additive; agent views cannot remove required
views. Agents are not approval identities. Cite evidence and separate facts from assumptions.
