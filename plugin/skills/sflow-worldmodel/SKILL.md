---
name: sflow-worldmodel
description: Build, verify, inspect, and compose the repository-owned world model used to ground governed phase prompts.
disable-model-invocation: true

---

# Manage the repository world model

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.

Use the requested operation:

- Configure/inventory: `wm init`; `wm light [--phase PHASE] [--local]`.
- Build/readiness: `singularity-flow wm build [--phase PHASE] [--task TEXT] [--depth light|quick|standard|deep] [--workers N]`; `wm availability ... --json`; `wm ensure ... --json`.
- Inspect/compose: `wm check [--branch BRANCH] [--remote REMOTE]`; `wm context <PHASE> [--task TEXT] [--evidence]`; `wm compose [--agent ID] [--phase ID] [--work-id ID] [--task TEXT] [--evidence] [--dry-run|--render-only]`.
- Recovery: `singularity-flow wm cleanup --json` removes stale, process-owned temporary worktrees (`--force` only on request); or list/inspect `wm recovery`, then `wm recovery publish <ID> --confirm <ID>` without another model call.
- AST status: `wm ast doctor|status --json`.
- Bounded reads: `wm ast context --paths <ROOT> --max-facts 50 --max-output-bytes 32768 --json`; `wm ast query --predicate symbol|import|language|path --value <VALUE>`. Continue only with its opaque cursor.
- AST cache: `wm ast build --paths <ROOT> --json`; resume only with its handle. Preview pruning with `wm ast cache prune --dry-run` before exact confirmation.
- Evidence audit: `wm ast evidence replay --receipt <RECEIPT-PATH> --json`.

Prefix commands with `singularity-flow`. `--branch` uses an isolated worktree; fetch is fast-forward-only. Builds follow `git.publish`; `--local` stays local. Never use `wm ensure` for a read, remove a live build worktree, or run competing builds. `wm light` is inventory, not semantic analysis. Report generated time, source hash, commit, views, and stale reason.

Built-in AST facts are lexical `text`; higher assurance requires a digest-verified protocol-v2 adapter. Required symbol gates need syntax. Default scope is the Story cone or changed paths; use `--all` only on request. Results contain no source bodies. Preview may read dirty bytes but cannot satisfy governance. Recorded context and gates require exact committed in-cone objects and must not downgrade.

In read-only Copilot, resolve AST reads/replay with `sflow_resolve`, then use only its `sflow_read` handle. Gateway reads are model-free and never populate cache. Publication retains a content-addressed toolchain and exact-input derivation; submission revalidates it. Manual gate does not bypass policy. Replay returns `identical`, `different`, or `unavailable` without substitution.

Composition is additive; agents cannot remove required views and are not approval identities. Cite evidence and separate facts from assumptions.
