---
name: sflow-mcp
description: Inspect governed MCP assignments, diagnose host configuration, scaffold Playwright MCP for VS Code, and record MCP evidence without exposing credentials.
disable-model-invocation: true
argument-hint: "status | doctor | scaffold playwright | record <server> --tool <tool>"
---

# Govern MCP tools

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, configured/missing host status, evidence path and hashes. Never claim that the host started, a tool ran, or evidence was committed unless the corresponding command reports it.

- List governed assignments and detected host configuration: `singularity-flow mcp status`.
- Diagnose required servers: `singularity-flow mcp doctor`.
- Create an explicit VS Code Playwright host configuration: `singularity-flow mcp scaffold playwright`.
- Record a material tool call: `singularity-flow mcp record <SERVER> --tool <TOOL> --phase <PHASE> [--output <WORK-ITEM-PATH>] [--note TEXT]`.

The host owns MCP transport, trust, process startup, and credentials. Singularity Flow owns the agent/phase/tool allowlist and provenance. Never print environment variables, copy secrets into `workflow.yml`, silently replace `.vscode/mcp.json`, or claim that a declared provenance record proves more than the referenced output hash.

For Playwright, honor the repository or corporate `.npmrc`; do not override the npm registry in the generated configuration. Keep VS Code/Copilot approval prompts enabled.
