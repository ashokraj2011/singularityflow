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
- Read exact-tier readiness: `singularity-flow wm availability [--phase PHASE] [--task TEXT] --json`.
- Materialize missing tiers: `singularity-flow wm ensure [--phase PHASE] [--task TEXT] --json`.
- Recover stale, process-owned temporary worktrees: `singularity-flow wm cleanup --json`; use `--force` only after confirming no build runs.
- Verify freshness: `singularity-flow wm check [--branch BRANCH] [--remote REMOTE]`.
- Inspect context: `singularity-flow wm context <PHASE> [--task TEXT] [--evidence]`.
- Compose: `singularity-flow wm compose [--agent ID] [--phase ID] [--work-id ID] [--task TEXT] [--evidence] [--dry-run|--render-only]`.
- Inspect optional structural intelligence: `singularity-flow wm ast doctor|status --json`.
- Read bounded structure: `singularity-flow wm ast context --paths <ROOT> --json` or `wm ast query --predicate symbol|import|language|path --value <VALUE>`.
- Materialize a derived local structural snapshot: `singularity-flow wm ast build --paths <ROOT> --json`. Continue a budget-limited build only with the returned `--resume <HANDLE>`.
- Preview structural cache cleanup with `singularity-flow wm ast cache prune --dry-run`; apply only with the exact confirmation printed by the CLI.

`--branch` uses an isolated worktree and never switches the checkout. Fetch is fast-forward-only. Builds publish per `git.publish`; `--local` retains the commit locally. Never run `wm ensure` to answer a read-only question.

Report generated time, source hash, commit, views, and stale reason. Never call a failed `wm check` current.

`wm light` is zero-token inventory, not semantic architecture, behavior, security, or impact.

The built-in AST broker is also zero-token, but its JavaScript/TypeScript symbol and import facts
are lexical and must be reported as `text` assurance. Never describe them as parsed syntax.
`syntax` or `semantic` requires a validated adapter. AST defaults to the Story's pinned cone, or
changed tracked paths without a cone. Add `--all` only on explicit request. Results contain no source bodies.

Never run competing builds on one branch. Composition is additive; agent views cannot remove required
views. Agents are not approval identities. Cite evidence and separate facts from assumptions.
