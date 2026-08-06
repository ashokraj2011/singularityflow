# Governed MCP tools

Model Context Protocol (MCP) tools let a governed Singularity Flow agent use a
capability supplied by its host, such as Playwright browser automation. The host
and Singularity Flow have deliberately separate responsibilities:

| Concern | Owner |
|---|---|
| Start the MCP process, connect transports, hold credentials, prompt for trust | VS Code or Copilot CLI |
| Select which governed agents and phases may use a server | `singularity/workflow.yml` |
| Limit the tool names presented to the agent | Agent Markdown `tools` plus the workflow allowlist |
| Inject the effective policy into the phase prompt | Singularity Flow prompt composition |
| Preserve durable results and their hashes | Work-item artifacts and MCP evidence records |

Singularity Flow never starts an MCP server during a read-only status command and
never copies host credentials into Git, prompts, snapshots, or its VS Code UI.

## Configure Playwright

New repositories include an optional governed Playwright declaration. Create the
matching VS Code host configuration from the repository root:

```bash
singularity-flow mcp scaffold playwright
```

This creates `.vscode/mcp.json` with the official `@playwright/mcp` package. It
refuses to replace an existing file. In VS Code, use **MCP: List Servers** to
review, trust, and start it. The equivalent visual entry is **Configuration → MCP
tools → Configure MCP host**.

For Copilot CLI, add the same server with its MCP configuration command and verify
it with `copilot mcp list`. Host-level configuration is machine-local; the
repository policy is shared.

Corporate npm registries remain authoritative. Configure the registry through the
normal npm mechanisms before starting the server, for example:

```bash
npm config set registry https://artifactory.example.invalid/api/npm/npm-virtual/
# or for one process
NPM_CONFIG_REGISTRY=https://artifactory.example.invalid/api/npm/npm-virtual/ code .
```

The generated MCP file does not override `.npmrc`, `NPM_CONFIG_REGISTRY`, proxy,
CA, or authentication settings.

## Govern the server

`singularity/workflow.yml` names the host server and constrains its use:

```yaml
mcpServers:
  playwright:
    label: Playwright browser automation
    hostReference: playwright
    agents: [qa, product-designer]
    phases: [verification, visual-verification, conformance]
    tools:
      - browser_navigate
      - browser_snapshot
      - browser_click
      - browser_take_screenshot
    required: false
    approval: confirm
    evidence:
      captureToolCalls: true
      captureResults: true
```

The matching Agent Markdown must allow the namespace:

```yaml
---
name: qa
tools: [read, search, "playwright/*"]
---
```

Use `server/tool` or `server/*` in Agent Markdown. Keep unqualified tool names in
the workflow declaration; Singularity Flow combines them with `hostReference`.
Assignments are additive to the phase contract, repository world-model views,
approved upstream inputs, and remote Markdown skills.

## Diagnose and audit

```bash
singularity-flow mcp status
singularity-flow mcp doctor
```

Status reads server **names only** from supported host configuration files. It
does not return commands, URLs, environment variables, tokens, or headers.

After a material MCP call, save any durable screenshot or report inside the
active work-item directory and record its provenance:

```bash
singularity-flow mcp record playwright \
  --tool browser_take_screenshot \
  --phase verification \
  --output singularity/work-items/WORK-123/artifacts/verification/home.png \
  --note "Authenticated home screen"
```

The record is written under
`singularity/work-items/<WORK-ID>/context/mcp/` and is committed by normal phase
publication. The governance gate rechecks the pinned server, phase, allowed tool,
output location, size, and SHA-256.

The host does not expose every tool-call event to Singularity Flow. A provenance
record is therefore an explicit agent declaration, not proof that Flow intercepted
the transport. The hash does prove which durable bytes were reviewed and
published.

## Copilot skill

Use `/sf-mcp` (the packaged `sflow-mcp` skill) for status, diagnostics, safe
Playwright scaffolding, and evidence recording. The skill is deterministic and
does not invoke a model merely to relay command output.
