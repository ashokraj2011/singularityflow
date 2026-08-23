---
name: sflow-mcp
description: Inspect governed MCP assignments, scaffold deterministic Figma or Playwright host entries, run explicit live browser smoke checks, and record immutable MCP/design evidence without exposing credentials.
disable-model-invocation: true
argument-hint: "status | doctor | attest <server> | smoke playwright --url <url> | scaffold figma|playwright | record <server> --tool <tool> | design-sources status"
---

# Govern MCP tools

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

- List governed assignments and detected host configuration: `singularity-flow mcp status`.
- Diagnose static host and policy readiness without contacting a server: `singularity-flow mcp doctor`.
- After reviewing, trusting, starting, and authenticating the server in the host, create a machine-local readiness receipt: `singularity-flow mcp attest <SERVER> --confirm <SERVER>`.
- With explicit network/browser consent, prove the Playwright protocol, required tools, browser launch, authorized navigation, snapshot, same-origin result, and close: `singularity-flow mcp smoke playwright --url <AUTHORIZED-URL>`. In an active origin-bound phase, this also records generation-bound navigation evidence from the MCP host's observed final URL.
- Merge an explicit VS Code host entry without replacing unrelated servers: `singularity-flow mcp scaffold playwright` or `singularity-flow mcp scaffold figma` (`--local` selects Figma's desktop endpoint).
- Record a material tool call: `singularity-flow mcp record <SERVER> --tool <TOOL> --phase <PHASE> [--output <PATH>] [--note TEXT]`. Do not manually record `browser_navigate` for an origin-bound Story; only the live smoke can issue that receipt. A `browser_snapshot` record must include the saved Playwright snapshot, and Flow verifies its reported `Page URL` against the Story authorization.
- Record pinned Figma metadata: `singularity-flow mcp record figma --kind design-source --tool get_metadata --phase design-intake --output <XML> --file-key <KEY> --file-version <VERSION> [--node 1:3]`.
- Inspect the exact approved source set downstream prompts will use: `singularity-flow mcp design-sources status`.

The host owns normal MCP transport, trust, and credentials. Singularity Flow owns the agent/phase/tool allowlist and provenance. `ready` means the checked host entry and policy match a current local attestation; a phase with `requireSmoke` additionally requires a receipt less than 24 hours old whose origin matches the Story authorization. Figma `get_metadata` is recorded as XML (`figma-mcp-metadata-xml`), not mislabelled as REST JSON. Never print environment variables, copy secrets into `workflow.yml`, silently replace `.vscode/mcp.json`, or claim that a declared provenance record proves more than the referenced output hash.

For Playwright, honor the repository or corporate `.npmrc`; do not override the npm registry in the generated configuration. Keep VS Code/Copilot approval prompts enabled.
