---
id: importing-assets
title: Importing skills, templates, and agents
aliases:
  - imports
  - import-from-link
  - marketplaces
commands:
  - import
  - imports
  - marketplace
related:
  - agents-and-routing
  - knowledge-and-remote-assets
  - workflow-authoring
version: 3
---
Agent skills, artifact templates, whole agents, generated-artifact sources and MCP servers can come from a link, from a marketplace the repository trusts, or from an approved MCP server. A preview shows the exact content and its SHA-256; an add names that hash, copies the bytes into the configuration in one reviewed change, and records where they came from.

## Purpose and prerequisites

Use this topic to take a skill, template, or agent someone has published at a public HTTPS link and use it in this repository's workflows. Run it in a governed checkout. Imports change configuration, so in a repository with an approved configuration authority add `--propose` and review the proposal like any other configuration change.

## Use it from each surface

- **Shell:** `sflow import preview <LINK> --as skill|template|agent`, then `sflow import add <LINK> … --sha256 <HASH>`; `sflow imports`, `sflow imports check`, `sflow imports remove <IMPORT>`; `sflow marketplace browse <ID>` and `sflow import preview market:<ID>/<ENTRY>`.
- **Copilot:** `/sf-import`. It previews, shows the full content and hash, asks what the import is for, and adds only the reviewed bytes.
- **VS Code:** **Workflow Studio** offers the same imports; each one becomes a change in the Studio's review before it is published.

## Guided workflow

1. Preview: `singularity-flow import preview https://example.org/skills/security-review/SKILL.md --as skill`. The engine fetches the file once (public HTTPS only, private addresses refused, at most 1 MiB unless `--max-bytes` says otherwise), refuses web pages, secrets and template values it does not support, and stages the exact bytes.
2. Decide what it is for. A skill belongs to one agent and, optionally, to some of its steps (`--agent architect --phases design`). A template can become the default template of steps (`--phases design`). An agent's file names its own ID; `--without-defaults` keeps it from taking over steps that already have a drafting agent.
3. Add exactly what you saw: `singularity-flow import add <LINK> --as skill --agent architect --phases design --sha256 <HASH> --propose`. Without `--sha256` the command shows the content and refuses.
4. Review the change. A skill becomes a row in the agent's `## Remote skills` table, its entry in `singularity/agents.lock.yml`, and a copy under `singularity/imports/agents/`. A template becomes `<templatesRoot>/imported/<id>.md` and a catalog entry. `singularity/imports.lock.yml` records each source.
5. To use a marketplace, trust it once: `singularity-flow marketplace add acme --index https://catalog.example.org/sflow-marketplace.json --allowed-origin https://cdn.example.org --propose`. Browse it with `singularity-flow marketplace browse acme`, then preview and add `market:acme/<entry>` exactly like a link. Each entry pins its file by SHA-256; a file that does not match is refused.
6. From an approved MCP server: `singularity-flow mcp sources docs --launch` lists what its policy allows; `singularity-flow import preview mcp:docs/prompt/security-checklist --as skill --launch --arg area=payments` reads one. To install a published MCP server: `singularity-flow import add <LINK|market:…> --as mcp-server --agents architect --sha256 <HASH> --propose`, then `singularity-flow mcp host add <SERVER>`. See `sflow explain mcp-integration`.
7. Later, `singularity-flow imports check` re-reads every source. Anything that changed is staged and shown with the exact `import add … --replace` command; updating is another reviewed import.

## State and safety

- Imported bytes are never fetched again. Stories, other machines and CI read the copies in the configuration, so a Story runs the same skill and template whether or not the link still works.
- The bytes written are exactly the previewed bytes: no newline is added and nothing is re-encoded, so their hash stays true.
- A vendored skill edited by hand no longer matches its lock; its agent refuses it until it is imported again. Templates and agents may be adapted after import; `imports` reports them as edited or customized.
- Adding a skill to an agent that already names remote resources nobody has trusted is refused; run `singularity-flow agents lock <AGENT>` first.
- No credentials, cookies or tokens are ever sent. Links with embedded credentials, private hosts and `localhost` are refused.
- A marketplace index can only list files from its own origin and the origins `workflow.yml` allows for it; anything else refuses the whole index.
- An MCP server is started or contacted only with `--launch`, for an item its governed `sources` allow; its answer is vendored and never re-read.

## Troubleshooting

- **"Review the content first"**: the add had no `--sha256`. Read the preview it printed and repeat the command it gave.
- **"changed since it was previewed"**: the source now serves different bytes. Preview again and review them.
- **"is a web page, not Markdown"**: use the link to the raw file, not the page that displays it.
- **"nobody has trusted yet"**: the agent names other remote resources without a current lock; run `singularity-flow agents lock <AGENT>` and import again.
- **"was written in this repository, not imported"**: an import cannot replace local work; import under another ID.
- **"not allowed to use"**: the marketplace index lists a file from an origin the repository did not allow; ask its owner, or add the origin with a reviewed `marketplace` change.
- **"publishes … but its file is …"**: the marketplace's file does not match its published hash; nothing was imported.

## Related topics

- `sflow explain agents-and-routing`
- `sflow explain knowledge-and-remote-assets`
- `sflow explain workflow-authoring`
