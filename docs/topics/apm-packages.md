---
id: apm-packages
title: APM packages in a repository
aliases:
  - apm
  - agent-package-manager
  - apm-lock
commands:
  - apm
related:
  - importing-assets
  - agents-and-routing
  - skill-master
version: 5
---
APM (Microsoft's Agent Package Manager) installs agents, skills, instructions and prompts as packages. `apm.yml` declares them, `apm install` resolves each one to a commit and writes its files for Copilot (agents, instructions and prompts into `.github/`, skills into `.agents/skills/`), and `apm.lock.yaml` records every file it wrote with its SHA-256. SFlow reads what APM left, says whether it is still intact, commits an install for review, lets its agents draft your workflow's steps, and publishes your own agents to your organisation's APM marketplace.

## Purpose and prerequisites

Use this topic when a repository gets its agents from APM packages, for example from your organisation's catalog. `apm.yml`, `apm.lock.yaml` and the deployed files are committed together, so every clone and every Story uses the same agents. `singularity-flow apm status` needs no APM CLI and no network: it reads the committed files. `singularity-flow apm install`, `apm marketplace init` and `apm publish` need the APM CLI (macOS: `brew install apm`; Windows: `winget install --id Microsoft.APM --exact`) at the version `apm.yml` pins.

Your organisation's marketplace is one Git repository in APM's monorepo-hybrid shape: its `apm.yml` has a `marketplace:` block, each package lives in `plugins/<name>/` (its own `apm.yml` and `.apm/` folder), and `apm pack` compiles the Copilot index `.github/plugin/marketplace.json`. Every change to it is a pull request its reviewers approve.

## Use it from each surface

- **Shell:** `sflow apm status` prints the locked packages, what each one deployed and whether it is intact; `sflow apm install <PACKAGE>` installs with APM and commits the result on an `apm/` branch; `sflow apm attach <AGENT> --step <STEP> --propose` makes an APM agent draft a step; `sflow apm marketplace init --name <NAME> --owner <OWNER>` starts a marketplace in its repository's checkout; `sflow apm publish <AGENT>... --marketplace <CHECKOUT>` publishes this repository's agents to it.
- **Copilot:** ask it to run `singularity-flow apm status`, or a `--dry-run` of `apm install`, `apm marketplace init` or `apm publish`. Installing changes which agents run and publishing what other teams run, so Copilot never runs them itself; run them in your own terminal.
- **VS Code:** run the same commands in the integrated terminal. In **Workflow Studio**, an agent APM deployed can be chosen to draft a step like any other; only its steps change, never its file.

## Guided workflow

1. From the base branch's checkout, preview with APM: `singularity-flow apm install reviewer@acme-catalog --dry-run`.
2. Install: `singularity-flow apm install reviewer@acme-catalog`. APM runs with its own output; then SFlow checks every deployed file against the new lock and commits exactly what APM changed on `apm/install-reviewer`. The first install also records the APM CLI version in `apm.yml` (`x-sflow.apm-cli`), so every machine installs with the same one.
3. Push the branch and open the pull request it prints (`git push -u origin apm/install-reviewer`, `gh pr create --fill`). Reviewers see the new agents, skills and instructions as files.
4. Once it is merged, choose the steps its agents draft: `singularity-flow apm attach reviewer --step verification --propose` (or choose it in Workflow Studio). `workflow.yml` records the step under `apm.agents`, and no agent file is edited: the step's previous agent keeps it in its own file and drafts it again whenever the APM agent cannot be used. This works for SFlow's own workflows too. A developer may also pick an APM agent for one Story: `singularity-flow start <WORK-ID> --agent reviewer`.
5. Later, run `singularity-flow apm status` before relying on the agents. Each package is listed with its commit and what it deployed; a deployed file edited by hand or deleted is reported with the package it came from, and agents in `.github/agents` that APM did not deploy are listed as the repository's own.

## Publish your own agents

1. Once, create the marketplace repository on your Git host and clone it. In its checkout: `singularity-flow apm marketplace init --name acme-catalog --owner "Platform Team" --description "Agents our teams may use"`. APM's own `apm marketplace init` writes the `marketplace:` block; SFlow sets it to compile the Copilot index, removes APM's example package, pins the APM CLI and adds `.github/workflows/apm-marketplace.yml`, which runs `apm pack --check-clean`, `apm marketplace check` and `apm audit` on every pull request (with `microsoft/apm-action` at the pinned version). It is committed on `apm/marketplace-init`; push it and open its pull request. Protect the marketplace's default branch so every change needs a review and those checks.
2. In a repository whose agents others should use, commit them, then preview from its base branch's checkout: `singularity-flow apm publish reviewer --marketplace ../acme-catalog --dry-run`. Several agents become one package with `--package <NAME>`; `--skill <ID>` adds a skill none of them attaches.
3. Publish: `singularity-flow apm publish reviewer --marketplace ../acme-catalog`. SFlow writes `plugins/reviewer/` (the agent, the skills it attaches, and an `apm.yml` that records the commit it came from), lists it in the marketplace's `apm.yml`, runs `apm pack`, and commits on `apm/publish-reviewer-1.0.0` in the marketplace's checkout. Push it and open the pull request it prints.
4. To publish a change, commit it here and publish again: it becomes the next patch version (or the `--version` you give, later than the published one). The same files publish nothing.
5. Each machine registers the marketplace once with `apm marketplace add <owner>/<repository>`; then any repository installs from it: `singularity-flow apm install reviewer@acme-catalog`.

What travels: the agent's file without this repository's step choices (`sflow-phases`, `sflow-default-for`) and without its `## Attached skills` table. The skills it attaches travel as the package's own; APM deploys them to `.agents/skills`, where Copilot finds each one by its description. A repository that installs the package chooses the agent's steps with `apm attach`.

## State and safety

- `apm status` fetches, installs and writes nothing. The only process it starts is `apm --version`, from the home directory, to say which APM CLI this machine has.
- `apm install` commits only the paths APM changed (`apm.yml`, `apm.lock.yaml`, `.gitignore` and the target directories), on an `apm/` branch, never on a Story's branch, and pushes nothing. It refuses before APM runs when those paths have uncommitted changes or this machine's APM CLI is not the pinned version, and commits nothing when APM fails or its files do not match its own lock.
- An agent APM deployed is used only as APM wrote it: starting a Story or a step with one whose file no longer matches `apm.lock.yaml` is refused, naming `apm install`. A Story keeps the copy it started with.
- APM never blocks the rest of SFlow. Without the APM CLI, only `apm install`, `apm marketplace init` and `apm publish` need it. A binding in `apm.agents` applies only while its agent is installed and exactly as APM wrote it; otherwise (no `apm.lock.yaml`, the agent uninstalled, edited by hand, or unreadable) it waits, the step keeps the agent its workflow already had, and `apm status` says why. A new Story is never offered an APM agent whose file changed, and one that does not match is never a reason a Story cannot start.
- An agent APM deployed is never read for its own steps (`sflow-phases`, `sflow-default-for`): only `workflow.yml` binds it, so no package can name a step this repository lacks or give a step a second agent.
- An agent APM deployed that SFlow cannot read as an agent (for example one with no `description`) is left out of SFlow's agents and listed by `apm status`; it never stops configuration from loading. An agent written in this repository is still refused when it is invalid.
- Every deployed path comes from the lock and is checked before it is read: a path outside the repository, an absolute path or a symbolic link is refused, never followed.
- A file is intact when its bytes match the lock's SHA-256, read as APM hashes it: text with CRLF line endings read as LF, binary files as they are.
- A declared package is reported as not locked only when its form names a GitHub repository, a marketplace, a registry or a local path; a dependency on another host is never guessed at.
- `apm marketplace init` and `apm publish` change only the marketplace's checkout, on an `apm/` branch, and push nothing; the repository you publish from is not changed. Publishing refuses before writing anything when the agents or skills have uncommitted changes, when this checkout is a Story's, when a file looks like it holds a secret, when a skill uses SFlow instructions or an agent names remote resources or is a user-defined agent (none of those travel in a package yet), when the agent came from APM, and when `plugins/<name>/` was not published by SFlow.
- SFlow replaces a package folder it published whole, so nothing from an earlier version lingers. `apm pack` failing commits nothing.

## Troubleshooting

- **"changed since apm install wrote it"**: the deployed copy was edited. `apm install` writes the locked file again; a change worth keeping belongs in the package itself.
- **"is not a regular file"**: a symbolic link or another kind of file stands where APM wrote a file. Remove it and run `apm install`.
- **"is missing"**: the file was deleted or never committed on this clone. Run `apm install`, then commit what it wrote.
- **"declares … but apm.lock.yaml does not lock it"**: `apm.yml` changed after the last install. Run `apm install` and commit the lock.
- **"still locks …, which apm.yml no longer declares"**: run `apm prune`.
- **"SFlow will not read"**: the lock names a path outside the repository or an absolute path. Reinstall from a trusted source and check the package.
- **"… would draft …, but …; until then each step keeps its workflow's own agent"** (`apm status`): the binding is waiting. Run `apm install` (and commit what it writes), or remove the binding with Workflow Studio. A binding naming an agent written in this repository never applies; give that agent its steps in its own `sflow-phases` and `sflow-default-for` metadata instead.
- **"… and a Story uses it only as APM wrote it"**: you chose an APM agent whose deployed file was edited by hand; `apm install` restores it. Without the choice, the Story starts with the workflow's own agents.
- **"was installed by APM …; change it in its package"**: Workflow Studio changes only which steps an APM agent drafts.
- **"is not an APM marketplace"**: run `singularity-flow apm marketplace init` in that checkout, or check out the branch where it was merged.
- **"Commit these first, so the package is what a reviewer saw here"**: commit the agents and skills you are publishing.
- **"The marketplace has this package at …; publish a later version"**: give a later `--version`, or none for the next patch.
- **"was not published by SFlow"** or **"already lists … from …"**: the marketplace has that name already; publish under another `--package` name.
- **"These look like secrets and would be published"**: remove them from the agent or skill and commit; nothing was written.
- **"No APM CLI on this machine's PATH"**: install the APM CLI to change packages; reading them needs nothing.
- **"This repository runs apm …; this machine has apm …"**: install the pinned version, or change `x-sflow.apm-cli` in `apm.yml` in its own reviewed change.
- **"Commit or stash these first"**: the install's commit holds only what APM changed; commit or stash your own changes to those paths.
- **"This checkout is Story …'s"**: install from the base branch's checkout; Stories started after the pull request is merged have the agents.

## Related topics

- `sflow explain importing-assets`
- `sflow explain agents-and-routing`
- `sflow explain skill-master`
