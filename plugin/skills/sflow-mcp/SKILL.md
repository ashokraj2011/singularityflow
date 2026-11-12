---
name: sflow-mcp
description: Configure, diagnose, and record governed Figma or Playwright MCP use without exposing credentials.
disable-model-invocation: true
agent: agent
argument-hint: "status | doctor | probe <server> --network | warm <server> --network | verify-offline <server> | auth status|import|remove playwright | attest <server> | smoke playwright --url <url> | scaffold figma|playwright | record <server> --tool <tool> | design-sources status"
---

# Govern MCP tools

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

- Inspect with `singularity-flow mcp status`; diagnose offline with `singularity-flow mcp doctor`.
- With network consent run `singularity-flow mcp probe <SERVER> --network`.
- Acquire and verify Playwright with `singularity-flow mcp warm playwright --network`; renew its npm-offline local-start proof with `singularity-flow mcp verify-offline playwright`. This does not sandbox the server's own network access.
- Preview private Playwright login state with `singularity-flow mcp auth import playwright --storage-state <FILE> --profile <LOWER-KEBAB>`; repeat with its exact `--confirm <SHA256>`. Inspect with `singularity-flow mcp auth status playwright`; remove with `singularity-flow mcp auth remove playwright --profile <ID> --confirm <ACTIVE-SHA256>`. If corrupt state prevents normal removal, preview and confirm `singularity-flow mcp auth clear playwright`. Only IDs and counts may be displayed. Windows imports apply and verify a current-user-only ACL and fail closed if that protection is unavailable or unsafe.
- After reviewing, trusting, starting, and authenticating the host server, create a local readiness receipt: `singularity-flow mcp attest <SERVER> --confirm <SERVER>`.
- With browser consent, prove launch, tools, same-origin navigation, snapshot, and close: `singularity-flow mcp smoke playwright --url <AUTHORIZED-URL>`. An origin-bound phase also records navigation evidence.
- Story lacks its authorized origin: preview `singularity-flow story target-origin <WORK-ID> --url <AUTHORIZED-URL>`; show the origin and confirm command.
- Merge an explicit VS Code host entry, keeping unrelated servers: `singularity-flow mcp scaffold playwright` or `singularity-flow mcp scaffold figma` (`--local` selects Figma's desktop endpoint). It writes only `.vscode/mcp.json`; Copilot CLI users must add the same entry to their Copilot CLI MCP configuration.
- Record output with `singularity-flow mcp record <SERVER> --tool <TOOL> --phase <PHASE> [--output <PATH>] [--note TEXT]`. Only live smoke can record origin-bound navigation; snapshots must report an authorized `Page URL`.
- Record pinned Figma metadata: `singularity-flow mcp record figma --kind design-source --tool get_metadata --output <XML> --file-key <KEY> --file-version <VERSION> [--node 1:3]` (capture step only).
- Inspect the exact approved source set downstream prompts use: `singularity-flow mcp design-sources status`.

The host owns transport, trust and credentials; Flow owns allowlisting and provenance. `ready` binds host, policy, and authentication-profile digest. A Playwright phase also requires a valid exact-package warm proof; `requireSmoke` needs a receipt under 24 hours old on the Story origin. Never print environment variables, put secrets in `workflow.yml`, silently replace `.vscode/mcp.json`, or overstate a hash receipt.

For Playwright, honor the repository or corporate `.npmrc`; do not override the npm registry in the generated configuration. Keep VS Code/Copilot approval prompts enabled.
