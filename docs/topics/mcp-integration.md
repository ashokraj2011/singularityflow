---
id: mcp-integration
title: MCP integration
aliases: [mcp, playwright, github-mcp, figma]
commands: [mcp]
related: [visual-verification, configuration]
---
The host (VS Code / Copilot) owns MCP servers, transports, credentials, and trust prompts; Flow owns governance: `mcpServers` in workflow.yml declares which agents, in which phases, may use which tools (allowlisted), with what approval and evidence capture. Flow never starts a server and never touches credentials. `sflow mcp scaffold <server>` writes the host entry; `sflow mcp doctor` verifies readiness offline (ready · needs-host-setup · misconfigured); `sflow mcp record` pins tool outputs as hash-bound evidence — remote fetches are HTTPS-only, credentialed URLs rejected, and persisted URLs stripped of query and hash. A record is an agent declaration; the hash proves which bytes were reviewed and published.
