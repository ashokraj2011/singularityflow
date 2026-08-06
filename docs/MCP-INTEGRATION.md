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

This merge-safely adds an exact, release-managed `@playwright/mcp` package version
to `.vscode/mcp.json`. Unrelated entries are preserved. A conflicting `playwright`
entry requires explicit `--replace-server`; the complete file is never replaced.
In VS Code, use **MCP: List Servers** to review, trust, and start it. The equivalent
visual entry is **Configuration → MCP tools → Configure MCP host**.

Figma can be scaffolded in the same way:

```bash
singularity-flow mcp scaffold figma          # https://mcp.figma.com/mcp
singularity-flow mcp scaffold figma --local  # Figma desktop endpoint
```

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
singularity-flow mcp attest playwright --confirm playwright
```

Status reads server **names only** from supported host configuration files. It
does not return commands, URLs, environment variables, tokens, or headers.
Doctor performs static checks only and does not contact the MCP server or package
registry. Readiness remains `needs-host-setup` until the user reviews, trusts,
starts, and authenticates the host entry, then creates a machine-local attestation.
The attestation is invalidated by any host-entry or governed-policy hash change.
It states what the user confirmed; it is not transport interception or network proof.

After a material MCP call, save any durable screenshot or report inside the
active work-item directory and record its provenance:

```bash
singularity-flow mcp record playwright \
  --tool browser_take_screenshot \
  --phase verification \
  --output singularity/work-items/WORK-123/artifacts/verification/home.png \
  --note "Authenticated home screen"
```

The original file is copied under
`singularity/work-items/<WORK-ID>/context/mcp/outputs/`; its typed record is written
under `context/mcp/records/`. Both are committed by normal phase publication. The
governance gate rechecks the pinned server, phase, governed agent, allowed tool,
output location, size, and SHA-256.

For Figma `get_metadata`, use `--kind design-source` and record the exact file key,
opaque version, and colon-form node IDs. The payload is XML and defaults to
`figma-mcp-metadata-xml`; it is not Figma REST JSON. See
[Mobile model intake](MOBILE-MODEL-INTAKE.md).

The host does not expose every tool-call event to Singularity Flow. A provenance
record is therefore an explicit agent declaration, not proof that Flow intercepted
the transport. The hash does prove which durable bytes were reviewed and
published.

## Copilot skill

Use `/sf-mcp` (the packaged `sflow-mcp` skill) for status, diagnostics, safe
Playwright scaffolding, and evidence recording. The skill is deterministic and
does not invoke a model merely to relay command output.
