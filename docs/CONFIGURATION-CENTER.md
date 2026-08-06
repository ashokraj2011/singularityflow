# VS Code Configuration Center

Singularity Flow configuration has one visual entry point in VS Code: **Configuration → Open Configuration Center**. The center separates three things that are easy to confuse:

- **People** are real contributors. Git email and, where supported, authenticated GitHub login determine whether a person may approve or reject.
- **Governed agents** are AI instruction roles used to compose a phase prompt. They never grant human approval authority.
- **MCP servers** are tools owned and started by VS Code or Copilot. Flow stores only the shared allowlist and evidence policy; it never stores the server's credential in `workflow.yml`.

## Visual coverage

| Area | Visual editor | Governed storage |
|---|---|---|
| Capabilities and repository ownership | Capability Designer | `singularity/capabilities.yml` and the state branch |
| Story workflows, phases, gates and artifacts | Workflow and Artifact Designers | `singularity/workflow.yml` and `singularity/templates/` |
| Agents, mappings, remote Markdown, prompts, skills and prompt packs | Agent Delivery & Instruction Designer | `.github/agents/`, `singularity/agent-mappings.yml`, `singularity/agents.lock.yml`, `singularity/prompts/`, repository skills and packs |
| People and Story approval groups | People & approvals | `singularity/workflow.yml` |
| People and Initiative approval groups | People & approvals | `singularity/portfolio.yml` |
| MCP phase/agent/tool policy | MCP tools | `singularity/workflow.yml` |
| MCP process, transport and secrets | VS Code MCP host UI | `.vscode/mcp.json` plus host-owned secret storage |
| Jira and Teams credentials | Secure integration actions | VS Code `SecretStorage` |
| Prompt audit | Prompt audit | workspace-local audit records |

Every governed save goes through `singularity-flow configuration save`. The CLI validates the complete resulting file before writing it, so a visual edit cannot leave an unknown phase, authority, agent, or MCP policy behind. YAML comments and unrelated keys are retained.

## Agents and remote Markdown delivery

**Configuration → Agents & delivery** separates authoring from trust:

- **Agents** edits phase routing, instructions, tools, world-model views, and the
  structured remote skill, artifact-template, and generated-output declarations.
- **Mappings & remote** maps a native Copilot agent name to a governed Flow agent,
  then shows source drift, dependency hashes, lock state, and local cache readiness.
- **Review & trust** and **Review update** open the engine's exact-name confirmation
  in an integrated terminal. The webview cannot silently establish or widen trust.
- **Sync locked resources** verifies committed hashes and materializes the local
  cache without modifying `singularity/agents.lock.yml`.

Only public HTTPS Markdown is supported. Ordinary links in agent prose remain inert,
and a remote template affects a workflow only when its template reference explicitly
uses `agent:<agent-id>/<template-id>`.

## People and approvals

The local profile controls display and guidance only. It is not an account and cannot approve anything.

An approval authority is a named group of real identities. Story authorities may deliberately allow any configured Git identity. Initiative authorities require named members because Initiative gates must not silently become open to every local identity. Existing authority scope is fixed in the editor; create a separate group when both Story and Initiative workflows need an equivalent authority.

## MCP tools

Add a governed server policy with:

- the exact host reference used by VS Code or Copilot;
- eligible governed agents and phases;
- allowed, unqualified tool names;
- whether the server is required;
- host approval and evidence-capture behavior.

The screen joins that policy to host discovery and shows whether the matching server is configured. **Add Playwright host starter** creates a reviewable `.vscode/mcp.json` only when one does not already exist. Review and trust the process through VS Code's MCP controls.

The repository policy and host setup are intentionally separate: sharing the repository must never share a developer's token or silently start a process.
