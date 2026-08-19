---
name: sflow-worldmodel
description: Build, verify, inspect, and compose the repository-owned world model used to ground governed phase prompts.
disable-model-invocation: true

---

# Manage the repository world model

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.

Use the requested operation:

- Initialize configuration: `singularity-flow wm init`.
- Zero-token inventory: `singularity-flow wm light [--phase PHASE] [--local]`.
- Semantic build: `singularity-flow wm build [--phase PHASE] [--task TEXT] [--depth light|quick|standard|deep] [--workers N]`.
- Read readiness: `singularity-flow wm availability [--phase PHASE] [--task TEXT] --json`.
- Materialize missing tiers: `singularity-flow wm ensure [--phase PHASE] [--task TEXT] --json`.
- Recover stale build worktrees: `singularity-flow wm cleanup --json`; use `--force` only when no build runs.
- Recover a validated publication failure: list and inspect with `wm recovery`, then run `wm recovery publish <ID> --confirm <ID>`. It republishes the retained bytes without a model.
- Verify freshness: `singularity-flow wm check [--branch BRANCH] [--remote REMOTE]`.
- Inspect context: `singularity-flow wm context <PHASE> [--task TEXT] [--evidence]`.
- Compose: `singularity-flow wm compose [--agent ID] [--phase ID] [--work-id ID] [--task TEXT] [--evidence] [--dry-run|--render-only]`.
- Inspect optional structural intelligence: `singularity-flow wm ast doctor|status --json`.
- Read bounded structure: `wm ast context --paths <ROOT> --max-facts 50 --max-output-bytes 32768 --json` or `wm ast query --predicate symbol|import|language|path --value <VALUE>`. Continue only with its opaque `--cursor`.
- Build local structure: `singularity-flow wm ast build --paths <ROOT> --json`; resume only with its returned handle.
- Preview cache pruning with `singularity-flow wm ast cache prune --dry-run`; apply its exact confirmation.

`--branch` uses an isolated worktree. Fetch is fast-forward-only. Builds follow `git.publish`; `--local` keeps the commit local. Never run `wm ensure` for a read or remove a live build's worktree.
Cleanup targets only stale, process-owned temporary worktrees.

Report generated time, source hash, commit, views, and stale reason. Never call a failed `wm check` current.

`wm light` is zero-token inventory, not semantic architecture, behavior, security, or impact.

Built-in AST facts are lexical `text`, never parsed syntax. `syntax` or `semantic` requires an executed, validated adapter. Required symbol gates need syntax. AST defaults to the Story cone, or changed paths without one. Use `--all` only on request. Results contain no source bodies.

In a read-only Copilot host, resolve structural status, context, or symbol queries with `sflow_resolve`, then use only its `sflow_read` handle. Gateway reads are model-free and cannot populate the cache. Required predicates run at publication and their engine/extractor receipt is revalidated at submission; manual `wm ast gate` never bypasses policy.

Never run competing builds on one branch. Composition is additive; agent views cannot remove required
views. Agents are not approval identities. Cite evidence and separate facts from assumptions.
