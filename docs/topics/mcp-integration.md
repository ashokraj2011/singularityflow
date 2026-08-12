---
id: mcp-integration
title: MCP integration
version: 2
aliases: [mcp, playwright, github-mcp, figma]
commands: [mcp]
related: [visual-verification, configuration]
---
MCP setup has two layers. VS Code or Copilot owns the server process, transport,
credentials and trust prompt. Flow owns the repository policy: `mcpServers` in
`workflow.yml` declares which governed agents, phases and exact tools may use the
host server, with what approval and evidence capture. The host server ID and Flow
`hostReference` must match. Flow never stores MCP credentials or silently starts a
server from read-only commands.

Use **Configuration → MCP tools** or `singularity-flow mcp scaffold <server>` for a
merge-safe host starter. Then use `mcp status` and `mcp doctor`; review/start the
server in the host and attest it if policy requires. Save material MCP outputs and
run `mcp record` to pin them as hash-bound evidence. A record is an agent
declaration—not transport interception—but its SHA-256 proves exactly which bytes
were reviewed and published. See [Configure and use MCP](../MCP-INTEGRATION.md).
