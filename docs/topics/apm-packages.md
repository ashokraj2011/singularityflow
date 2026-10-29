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
version: 4
---
APM (Microsoft's Agent Package Manager) installs agents, skills, instructions and prompts as packages. `apm.yml` declares them, `apm install` resolves each one to a commit and writes its files for Copilot (agents, instructions and prompts into `.github/`, skills into `.agents/skills/`), and `apm.lock.yaml` records every file it wrote with its SHA-256. SFlow reads what APM left, says whether it is still intact, commits an install for review, and lets its agents draft your workflow's steps.

## Purpose and prerequisites

Use this topic when a repository gets its agents from APM packages, for example from your organisation's catalog. `apm.yml`, `apm.lock.yaml` and the deployed files are committed together, so every clone and every Story uses the same agents. `singularity-flow apm status` needs no APM CLI and no network: it reads the committed files. `singularity-flow apm install` needs the APM CLI (macOS: `brew install apm`; Windows: `winget install --id Microsoft.APM --exact`) at the version `apm.yml` pins.

## Use it from each surface

- **Shell:** `sflow apm status` prints the locked packages, what each one deployed and whether it is intact; `sflow apm install <PACKAGE>` installs with APM and commits the result on an `apm/` branch; `sflow apm attach <AGENT> --step <STEP> --propose` makes an APM agent draft a step.
- **Copilot:** ask it to run `singularity-flow apm status` or `singularity-flow apm install <PACKAGE> --dry-run`. Installing changes which agents run, so Copilot never runs the install itself; run it in your own terminal.
- **VS Code:** run the same commands in the integrated terminal. In **Workflow Studio**, an agent APM deployed can be chosen to draft a step like any other; only its steps change, never its file.

## Guided workflow

1. From the base branch's checkout, preview with APM: `singularity-flow apm install reviewer@acme-catalog --dry-run`.
2. Install: `singularity-flow apm install reviewer@acme-catalog`. APM runs with its own output; then SFlow checks every deployed file against the new lock and commits exactly what APM changed on `apm/install-reviewer`. The first install also records the APM CLI version in `apm.yml` (`x-sflow.apm-cli`), so every machine installs with the same one.
3. Push the branch and open the pull request it prints (`git push -u origin apm/install-reviewer`, `gh pr create --fill`). Reviewers see the new agents, skills and instructions as files.
4. Once it is merged, choose the steps its agents draft: `singularity-flow apm attach reviewer --step verification --propose` (or choose it in Workflow Studio). The step's previous agent gives it up, and `workflow.yml` records the step under `apm.agents`; the agent's own file is never edited. A developer may also pick an APM agent for one Story: `singularity-flow start <WORK-ID> --agent reviewer`.
5. Later, run `singularity-flow apm status` before relying on the agents. Each package is listed with its commit and what it deployed; a deployed file edited by hand or deleted is reported with the package it came from, and agents in `.github/agents` that APM did not deploy are listed as the repository's own.

## State and safety

- `apm status` fetches, installs and writes nothing. The only process it starts is `apm --version`, from the home directory, to say which APM CLI this machine has.
- `apm install` commits only the paths APM changed (`apm.yml`, `apm.lock.yaml`, `.gitignore` and the target directories), on an `apm/` branch, never on a Story's branch, and pushes nothing. It refuses before APM runs when those paths have uncommitted changes or this machine's APM CLI is not the pinned version, and commits nothing when APM fails or its files do not match its own lock.
- An agent APM deployed is used only as APM wrote it: starting a Story or a step with one whose file no longer matches `apm.lock.yaml` is refused, naming `apm install`. A Story keeps the copy it started with.
- An agent APM deployed that SFlow cannot read as an agent (for example one with no `description`) is left out of SFlow's agents and listed by `apm status`; it never stops configuration from loading. An agent written in this repository is still refused when it is invalid.
- Every deployed path comes from the lock and is checked before it is read: a path outside the repository, an absolute path or a symbolic link is refused, never followed.
- A file is intact when its bytes match the lock's SHA-256, read as APM hashes it: text with CRLF line endings read as LF, binary files as they are.
- A declared package is reported as not locked only when its form names a GitHub repository, a marketplace, a registry or a local path; a dependency on another host is never guessed at.

## Troubleshooting

- **"changed since apm install wrote it"**: the deployed copy was edited. `apm install` writes the locked file again; a change worth keeping belongs in the package itself.
- **"is not a regular file"**: a symbolic link or another kind of file stands where APM wrote a file. Remove it and run `apm install`.
- **"is missing"**: the file was deleted or never committed on this clone. Run `apm install`, then commit what it wrote.
- **"declares … but apm.lock.yaml does not lock it"**: `apm.yml` changed after the last install. Run `apm install` and commit the lock.
- **"still locks …, which apm.yml no longer declares"**: run `apm prune`.
- **"SFlow will not read"**: the lock names a path outside the repository or an absolute path. Reinstall from a trusted source and check the package.
- **"apm.agents names … but APM did not deploy …"**: the binding names an agent written in this repository; give it its steps in its own `sflow-phases` and `sflow-default-for` metadata instead.
- **"… and a Story uses it only as APM wrote it"**: the deployed agent was edited by hand; `apm install` restores it.
- **"was installed by APM …; change it in its package"**: Workflow Studio changes only which steps an APM agent drafts.
- **"No APM CLI on this machine's PATH"**: install the APM CLI to change packages; reading them needs nothing.
- **"This repository installs with apm …; this machine has apm …"**: install the pinned version, or change `x-sflow.apm-cli` in `apm.yml` in its own reviewed change.
- **"Commit or stash these first"**: the install's commit holds only what APM changed; commit or stash your own changes to those paths.
- **"This checkout is Story …'s"**: install from the base branch's checkout; Stories started after the pull request is merged have the agents.

## Related topics

- `sflow explain importing-assets`
- `sflow explain agents-and-routing`
- `sflow explain skill-master`
