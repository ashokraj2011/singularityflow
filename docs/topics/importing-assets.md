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
  - skill-master
version: 15
---
Agent skills, artifact templates, whole agents, generated-artifact sources and MCP servers can come from a link, from a marketplace the repository trusts, or from an approved MCP server. A preview shows the exact content and its SHA-256; an add names that hash, copies the bytes into the configuration in one reviewed change, and records where they came from.

## Purpose and prerequisites

Use this topic to take a skill, template, or agent someone has published at a public HTTPS link and use it in this repository's workflows. Run it in a Singularity Flow checkout. Imports change configuration, so in a repository with an approved configuration authority add `--propose` and review the proposal like any other configuration change.

## Use it from each surface

- **Shell:** `sflow import preview <LINK> --as skill|template|agent`, then `sflow import add <LINK> … --sha256 <HASH>`; `sflow imports`, `sflow imports check`, `sflow imports remove <IMPORT>`; `sflow marketplace browse <ID>` and `sflow import preview market:<ID>/<ENTRY>`.
- **Copilot:** `/sf-import`. It previews, shows the full content and hash, asks what the import is for, and adds only the reviewed bytes.
- **VS Code:** **Workflow Studio** offers the same imports; each one becomes a change in the Studio's review before it is published.

## Guided workflow

1. Preview: `singularity-flow import preview https://example.org/skills/security-review/SKILL.md --as skill`. The engine fetches the file once (public HTTPS only, private addresses refused, at most 1 MiB unless `--max-bytes` says otherwise), refuses web pages, secrets and template values it does not support, and stages the exact bytes.
2. Decide what it is for. A skill either belongs to one agent and, optionally, to some of its steps (`--agent architect --phases design`), or, without `--agent`, goes into the skill master (`sflow explain skill-master`; plain Markdown then needs `--description`). Attach a master skill with `skill attach <ID> --workflow <WORKFLOW> --phases <STEPS>` for workflow-local use, or `--agent <AGENT>` for use wherever that agent is selected. A seeded workflow's agents are read-only, so direct `import add --agent` refuses them: import the skill into the master, then attach it. In Workflow Studio, **Add from a link** on a step creates a workflow-local attachment; on an agent it creates an agent attachment. Both use the reviewed master import. A template can become the default template of steps (`--phases design`). An agent's file names its own ID; `--without-defaults` keeps it from taking over steps that already have a drafting agent.
3. Add exactly what you saw: `singularity-flow import add <LINK> --as skill --agent architect --phases design --sha256 <HASH> --propose`. Without `--sha256` the command shows the content and refuses.
4. Review the change. A skill for one agent becomes a row in the agent's `## Remote skills` table, its entry in `singularity/agents.lock.yml`, and a copy under `singularity/imports/agents/`. A skill for the skill master becomes `singularity/skill-library/<id>/SKILL.md`. A template becomes `<templatesRoot>/imported/<id>.md` and a catalog entry. `singularity/imports.lock.yml` records each source.
5. To use a marketplace, trust it once: `singularity-flow marketplace add acme --index https://catalog.example.org/sflow-marketplace.json --allowed-origin https://cdn.example.org --propose`. Browse it with `singularity-flow marketplace browse acme`, then preview and add `market:acme/<entry>` exactly like a link. Browse and preview read the marketplaces the approved configuration trusts; an edit of `workflow.yml` that is not approved yet trusts nothing. Each entry pins its file by SHA-256; a file that does not match is refused.
6. A marketplace can also be a Git repository with an APM manifest at its root (an `apm.yml` whose `marketplace.packages` list `agents/<name>` and `skills/<name>`). Trust it at one commit: `singularity-flow marketplace add acme --repo https://git.example.com/acme/sdlc-marketplace.git --ref main --propose` reads it once, checks it is a marketplace and pins the commit `main` is at now. `singularity-flow marketplace browse acme --kind agent` lists its agents and skills at that commit, from each package's own `apm.yml`: type, version, lifecycle state, PDLC phases and tasks, tags and the skills an agent depends on. SFlow reads these files itself, because APM 0.35 refuses `type: agent` and drops the PDLC keys. An agent becomes a workflow; see "Marketplace agents as workflows" below. A skill can also be taken on its own, into the skill master: `singularity-flow import preview "market:acme/<skill>" --as skill` shows its exact text at the trusted commit, and its add command imports it like any import. In Workflow Studio's Library, **Browse** gives each such skill **Add to the skill master**, which opens the same preview; VS Code's **All skills** page does the same with **Preview and add**.
7. From an approved MCP server: `singularity-flow mcp sources docs --launch` lists what its policy allows; `singularity-flow import preview mcp:docs/prompt/security-checklist --as skill --launch --arg area=payments` reads one. To install a published MCP server: `singularity-flow import add <LINK|market:…> --as mcp-server --agents architect --sha256 <HASH> --propose`, then `singularity-flow mcp host add <SERVER>`. See `sflow explain mcp-integration`.
8. Later, `singularity-flow imports check` re-reads every source. Anything that changed is staged and shown with the exact `import add … --replace` command; updating is another reviewed import. A skill from a Git repository marketplace is read at the commit the repository trusts and at the marketplace's newest commit. A newer text at the trusted commit is imported again the same way. A newer text only at the newest commit is taken in two reviewed steps: trust that commit first (`marketplace add <ID> --repo …`, Workflow Studio's **Read its newest commit**), then check again and import it. A skill the marketplace no longer has is reported, and the copy here stays until you remove it.

## Marketplace agents as workflows

A marketplace agent's `agent.md` is a whole process: a hard gate first, a table of the skill each stage uses for each answer, numbered stages, rules and an output format. `singularity-flow workflow from-agent acme/qa-test-automation-agent` turns it into a workflow and changes nothing; `--out FILE` writes it as a workflow bundle, and `--propose` shows its import as a configuration proposal with the one command that makes it.

- **Stages:** each numbered heading (`## 2. Test Case Creation`) is a step, in order. Headings inside fenced code, such as an Output Format's `##` lines, are ignored. An optional stage that does what the step before it does (Unit Test Gap Fill after Test Automation) runs inside that step.
- **Hard gates** ("(Hard Gate)", "STOP and WAIT", "MUST ask"): a gate before the first stage becomes the person's questions at the first step, with its choices ("Which channel ...? Choose one: web, android"). A later gate that only asks a person to approve or choose what the stage before it made (Test Case Review) becomes that step's person approval.
- **The answer is a Story value:** a choice the agent records under a name ("Record the answer as `channel`") is recorded when the first step is submitted (`--decision channel=web`), by a decision after that step whose every route goes on to the next step. The person gives it; the agent never does.
- **Skills:** the step-to-skill table attaches each skill to its step for its answer ("when channel is web"); every skill an agent depends on becomes a library skill. Once the Story records the answer, each later step is given only that answer's skills: choosing android gives the android skills, web the web ones. The agent's own table of every answer's skill paths is replaced by that line.
- **What each step is for:** from the PDLC tasks of the skills it uses, then a stage named like one of the agent's tasks, then the step intents rules on its name, words and place, with the agent's PDLC phases leaning (discovery: intake, design; elaboration: intake, requirements, design; delivery: plan, code, test; review: review, test; release: release, report; operations: code, report). A stage none of these settles is asked about once, with two to four choices, each a whole command with `--answer STEP=INTENT`; SFlow never guesses.
- **The result:** a version 4 workflow in which every step says what it is for, so each step's settings come from its intent. Importing it needs `version: 4` at the top of `singularity/workflow.yml`; the import says so.
- **The conversion review** (`--review`; Workflow Studio's **Make a workflow** shows it):
  - where the agent came from: marketplace, commit, version, lifecycle state, maintainer;
  - every stage of `agent.md` and what it became: a step, part of one, the first step's questions, or a step's approval;
  - what SFlow changed;
  - what needs your answer;
  - the checks: every stage accounted for, nothing waiting, and a walk of a Story of it with no loop or stop.

  The workflow is made only when the review is clean.
- **Feedback for the marketplace:** each finding the marketplace owns comes with its fix. Examples: a skill a stage names but the agent does not depend on, a dependency no stage uses, a stage SFlow could not classify, a proposed lifecycle state, a missing `maintainer-email`. SFlow's own choices are not included.
  - `--feedback FILE` writes the findings as Markdown for the maintainers. In Studio, the same comes from **Save as Markdown** and **Copy**.
  - **Open an issue** opens a new issue in the agent's own repository (`source-repository`) in your browser, filled in. You submit it; SFlow never posts.
- **Where it came from, and updates:** the import writes a `workflow:<id>` record to `singularity/imports.lock.yml`. It holds the marketplace, the commit, the agent's version, a SHA-256 of `agent.md`, of its `apm.yml` and of each skill, and your answers.
  - `singularity-flow imports check`, or Workflow Studio's **Check for updates**, reads the marketplace at its newest commit and says what changed, for example "skill web-xray-creation changed".
  - `workflow from-agent <MARKETPLACE/AGENT> --update`, or **Review update**, converts the agent again with your recorded answers. The review then shows only what changed, with the changed lines of `agent.md` and of each skill. A stage whose own words changed is asked again.
  - Its import updates the workflow in place. It replaces what the earlier import wrote, where nobody changed it here since. A file changed here since, or one another workflow uses, is asked about, and keeping your own is suggested.
  - Updating is an import like any other, reviewed before it is written. Stories already running keep the workflow they started with. An agent the marketplace no longer has is reported, and its workflow stays until you retire it.
  - A workflow imported before its source was recorded is compared with the marketplace's pinned commit; updating it records its source.

| PDLC task | Step intent | Why |
|---|---|---|
| problem-framing | intake | the request in the requester's own words |
| requirements-analysis, user-story-writing, acceptance-criteria-writing | requirements | numbered, testable pieces later steps cite |
| test-case-creation | requirements | a test design document: test cases traced to acceptance criteria; nothing runs yet |
| architecture-discovery, architecture-design | design | mapping the system as it is is part of design |
| decision-records | document | an ADR is a decision record |
| api-implementation, ui-implementation | code | |
| unit-testing, contract-testing, e2e-testing, ui-test-automation | code | tests are code a code step writes; running them is a test step |
| feature-toggle-management | code | a toggle change is a code change |
| documentation | document | |
| static-analysis | test | it runs the analyzers and records what they found |
| accessibility-review, coding-standards-review, security-review, pr-review | review | it judges the delivered change |
| release-notes, changelog, pr-description, release-readiness | release | |

## State and safety

- Imported bytes are never fetched again. Stories, other machines and CI read the copies in the configuration, so a Story runs the same skill and template whether or not the link still works.
- The bytes written are exactly the previewed bytes: no newline is added and nothing is re-encoded, so their hash stays true.
- A vendored skill edited by hand no longer matches its lock; its agent refuses it until it is imported again. Templates and agents may be adapted after import; `imports` reports them as edited or customized.
- Adding a skill to an agent that already names remote resources nobody has trusted is refused; run `singularity-flow agents lock <AGENT>` first.
- No credentials, cookies or tokens are ever sent. Links with embedded credentials, private hosts and `localhost` are refused.
- A marketplace index can only list files from its own origin and the origins `workflow.yml` allows for it; anything else refuses the whole index.
- A Git repository marketplace is read at the commit `workflow.yml` pins, with Git and the sign-in a `git clone` of it uses. Nothing is checked out and nothing in it is run. To trust a newer commit, run the same `marketplace add --repo` again: it moves the pin, as a reviewed change.
- An MCP server is started or contacted only with `--launch`, for an item its `sources` allow; its answer is vendored and never re-read.

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
- `sflow explain skill-master`
