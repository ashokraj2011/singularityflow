---
name: sflow-mcp
description: Inspect governed MCP assignments, scaffold merge-safe Figma or Playwright host entries, and record immutable MCP/design evidence without exposing credentials.
disable-model-invocation: true
argument-hint: "status | doctor | attest <server> | scaffold figma|playwright | record <server> --tool <tool> | design-sources status"
---

# Govern MCP tools

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, configured/missing host status, evidence path and hashes. Never claim that the host started, a tool ran, or evidence was committed unless the corresponding command reports it.

- List governed assignments and detected host configuration: `singularity-flow mcp status`.
- Diagnose static host and policy readiness without contacting a server: `singularity-flow mcp doctor`.
- After reviewing, trusting, starting, and authenticating the server in the host, create a machine-local readiness receipt: `singularity-flow mcp attest <SERVER> --confirm <SERVER>`.
- Merge an explicit VS Code host entry without replacing unrelated servers: `singularity-flow mcp scaffold playwright` or `singularity-flow mcp scaffold figma` (`--local` selects Figma's desktop endpoint).
- Record a material tool call: `singularity-flow mcp record <SERVER> --tool <TOOL> --phase <PHASE> [--output <PATH>] [--note TEXT]`.
- Record pinned Figma metadata: `singularity-flow mcp record figma --kind design-source --tool get_metadata --phase design-intake --output <XML> --file-key <KEY> --file-version <VERSION> [--node 1:3]`.
- Inspect the exact approved source set downstream prompts will use: `singularity-flow mcp design-sources status`.

The host owns MCP transport, trust, process startup, and credentials. Singularity Flow owns the agent/phase/tool allowlist and provenance. `ready` means the checked host entry and policy match a current local attestation; it is not a live network probe. Figma `get_metadata` is recorded as XML (`figma-mcp-metadata-xml`), not mislabelled as REST JSON. Never print environment variables, copy secrets into `workflow.yml`, silently replace `.vscode/mcp.json`, or claim that a declared provenance record proves more than the referenced output hash.

For Playwright, honor the repository or corporate `.npmrc`; do not override the npm registry in the generated configuration. Keep VS Code/Copilot approval prompts enabled.
