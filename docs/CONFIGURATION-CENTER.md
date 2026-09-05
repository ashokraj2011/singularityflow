# VS Code Configuration Center

Singularity Flow configuration has one visual entry point in VS Code: **Configuration → Open Configuration Center**. The center separates three things that are easy to confuse:

- **People** are real contributors. Git email and, where supported, authenticated GitHub login determine whether a person may approve or reject.
- **Governed agents** are AI instruction roles used to compose a phase prompt. They never grant human approval authority.
- **MCP servers** are tools owned and started by VS Code or Copilot. Flow stores only the shared allowlist and evidence policy; it never stores the server's credential in `workflow.yml`.

The installed tutorials are `sflow explain configuration`, `sflow explain workflow-authoring`, `sflow explain agents-and-routing`, `sflow explain world-model`, and `sflow explain mcp-integration`.

## Visual coverage

| Area | Visual editor | Governed storage |
|---|---|---|
| Capabilities and repository ownership | Capability Designer | `singularity/capabilities.yml` and the state branch |
| Story workflows, phases, gates and artifacts | Workflow and Artifact Designers | `singularity/workflow.yml` and `singularity/templates/` |
| Repository and work-type Auto enablement | Auto mode | `singularity/workflow.yml` |
| Agents, mappings, remote Markdown, prompts, skills and prompt packs | Agent Delivery & Instruction Designer | `.github/agents/`, `singularity/agent-mappings.yml`, `singularity/agents.lock.yml`, `singularity/prompts/`, repository skills and packs |
| People and Story approval groups | People & approvals | `singularity/workflow.yml` |
| People and Initiative approval groups | People & approvals | `singularity/portfolio.yml` |
| MCP phase/agent/tool policy | MCP tools | `singularity/workflow.yml` |
| MCP process, transport and secrets | VS Code MCP host UI | `.vscode/mcp.json` plus host-owned secret storage |
| Jira and Teams credentials | Secure integration actions | VS Code `SecretStorage` |
| Prompt audit | Prompt audit | workspace-local audit records |

## Capability Auto policy

Auto has three policy layers. First open **Configuration Center → Auto mode**, turn on the
repository master switch, and choose **Plan only** or **Bounded execution** for each eligible work
type. Save, then use **Review & publish configuration**; the edit does not apply until the approved
configuration is published and projected to the state branch.

Then open **Configuration → Capabilities**, select a capability, and use **Auto policy** to choose
**Inherit**, **Disabled**, **Plan only**, or **Bounded execution**. Bounded capability controls also
set protected-scope handling, maximum touched paths, and maximum concurrent flights. Saving creates
the normal reviewed capability proposal; the application branch is not edited, and the setting does
not apply until review/merge into `sflow/config` and projection to the state branch.

Both legacy and receipt-managed maps expose this control. On a managed map, **Propose Auto policy**
creates a capability-change receipt and review branch; it never edits the approved map in place.
The terminal equivalent is `singularity-flow capability auto <ID> --eligibility
inherit|disabled|plan-only|bounded`, with optional protected-scope and numeric limits.

Capability policy is monotonic: it may make Auto stricter but cannot enable Auto when repository
policy is off or when the selected workflow type is ineligible. The screen shows declared and
effective values side by side and calls out an ancestor override.

The command palette entry **Singularity Flow: Auto Mode Settings** opens the two upper layers
directly. A refused `auto` command links to the same screen and supplies read-only policy inspection
commands; it never changes policy or retries automatically.

## Recovery from refused commands

Every unstructured CLI refusal now includes a bounded **Recovery plan** with up to three
deterministic steps. In VS Code the same plan opens as a result card. Action buttons place the exact
command into a terminal for review without pressing Enter. They never bypass confirmation, execute
automatically, or claim that files were preserved when the refusing operation supplied no effects
record. Commands that already return the structured result contract retain their gate checklist,
preservation evidence, and legal next actions.

Every governed save goes through `singularity-flow configuration save`. The CLI validates the complete resulting file before writing it, so a visual edit cannot leave an unknown phase, authority, agent, or MCP policy behind. YAML comments and unrelated keys are retained.

Saving is authoring, not publication. Once one or more files change, the
Configuration tree adds **Unpublished configuration**, shows the exact paths, and
offers **Review & publish configuration**. The preview names the current branch
and complete commit scope. Publication calls the same scoped engine transaction as
`singularity-flow configuration publish`: it refuses unrelated working-tree or
staged files, refuses the protected application branch, creates one commit, and
pushes only the current governed review branch.

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
It is collected when a person creates their first workspace, then can be changed here. The profile is
machine-local VS Code configuration and is not committed to the workspace or lead repository.

An approval authority is a named group of real identities. Story authorities may deliberately allow any configured Git identity. Initiative authorities require named members because Initiative gates must not silently become open to every local identity. Existing authority scope is fixed in the editor; create a separate group when both Story and Initiative workflows need an equivalent authority.

The **Add my current Git identity** card reads the same repository Git/GitHub identity that the
approval kernel will use. It defaults to all configured Story and Initiative authorities; choose
one authority or one scope only when intentionally narrowing that grant. Existing matches are enriched rather than duplicated. **Add, commit
& push** updates an isolated checkout of the approved `sflow/config` authority, validates the
complete workflow and portfolio, retains the exact commit for push recovery, and publishes it. It
never edits, stages, or commits the active Story/Initiative checkout. **Allow self-approval** and
**Automatically add a new Git identity** are enabled by default for normal team configuration and
disabled by default for the regulated profile. The latter publishes a new identity into all Story
and Initiative groups before a newly started Story pins its configuration. Either control can be
disabled here; published changes never rewrite an existing Story's immutable snapshot.

## MCP tools

Add a governed server policy with:

- the exact host reference used by VS Code or Copilot;
- eligible governed agents and phases;
- allowed, unqualified tool names;
- whether the server is required;
- host approval and evidence-capture behavior.

The screen joins that policy to host discovery and shows whether the matching server is configured. **Add Playwright host starter** creates a reviewable `.vscode/mcp.json` only when one does not already exist. Review and trust the process through VS Code's MCP controls.

The repository policy and host setup are intentionally separate: sharing the repository must never share a developer's token or silently start a process.
