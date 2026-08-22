---
name: sflow-worldmodel
description: Build, verify, inspect, and compose the repository-owned world model used to ground governed phase prompts.
disable-model-invocation: true

---

# Manage the repository world model

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Resolve paths under singularity/work-items/<WORK-ID>/ in this repository; never search outside it. Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.

- Configure/inventory: `wm init`; `wm light [--phase PHASE] [--local]`.
- Build/readiness: `singularity-flow wm build [--phase PHASE] [--task TEXT] [--depth light|quick|standard|deep] [--workers N]`; `wm availability ... --json`; `wm ensure ... --json`.
- Inspect/compose: `wm check [--branch BRANCH] [--remote REMOTE]`; `wm context <PHASE> [--task TEXT] [--evidence]`; `wm compose [--agent ID] [--phase ID] [--work-id ID] [--task TEXT] [--evidence] [--dry-run|--render-only]`.
- Recovery: `singularity-flow wm cleanup --json` removes stale, process-owned temporary worktrees (`--force` only on request); `wm recovery publish <ID> --confirm <ID>` reuses retained output without another model call.
- AST status: `wm ast doctor|status --json`.
- Bounded reads: `wm ast context --paths <ROOT> --max-facts 50 --max-output-bytes 32768 --json`; `wm ast query --predicate symbol|symbol-id|import|references|hierarchy|module|language|path --value <VALUE>`. Continue only with its cursor.
- Packs: `wm ast pack list|doctor [PACK]`; install/remove only after preview and exact confirmation.
- Semantic binding: preview `wm ast warm --semantic --provider <PACK> --project <KIND:ROOT> --profile <PROFILE> --dry-run`; run only after its exact confirmation. It may execute disclosed repository configuration offline, never on a read.
- AST cache: `wm ast build --paths <ROOT> --json`; resume only with its handle. Preview pruning with `wm ast cache prune --dry-run` before exact confirmation.
- Evidence audit: `wm ast evidence reproduce --receipt <RECEIPT-PATH> --json` (`replay` remains a compatibility alias).

Prefix commands with `singularity-flow`. `--branch` uses an isolated worktree; fetch is fast-forward-only. Builds follow `git.publish`; `--local` stays local. Never use `wm ensure` for a read or run competing builds. `wm light` is inventory, not semantics. Report time, source hash, commit, views, and stale reason.

JavaScript/TypeScript facts are lexical `text`. Java, Python, Kotlin, and Swift use the bundled verified syntax pack unless policy is off/text-only. Optional semantic packs require a complete project/toolchain binding and never erase syntax. Required symbol gates need syntax. Default scope is the Story cone or changed paths; use `--all` only on request. Results contain no source bodies. Preview may read dirty bytes but cannot govern. Recorded context/gates require exact committed in-cone objects.

For read-only Copilot, resolve AST reads/replay with `sflow_resolve`, then use its `sflow_read` handle. Gateway reads never fill cache. Publication retains the toolchain and inputs; submission revalidates. A manual gate cannot bypass policy. Replay returns `identical`, `different`, or `unavailable` without substitution.

Composition is additive; agents cannot remove required views or approve. Separate facts from assumptions.
