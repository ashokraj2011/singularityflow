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
version: 2
---
APM (Microsoft's Agent Package Manager) installs agents, skills, instructions and prompts as packages. `apm.yml` declares them, `apm install` resolves each one to a commit and writes its files for Copilot (agents, instructions and prompts into `.github/`, skills into `.agents/skills/`), and `apm.lock.yaml` records every file it wrote with its SHA-256. SFlow reads what APM left and says whether it is still intact.

## Purpose and prerequisites

Use this topic when a repository gets its agents from APM packages, for example from your organisation's catalog. Install packages with the APM CLI (`apm install`), then commit `apm.yml`, `apm.lock.yaml` and the deployed files together, so every clone and every Story uses the same agents. `singularity-flow apm status` needs no APM CLI and no network: it reads the committed files.

## Use it from each surface

- **Shell:** `sflow apm status` prints the locked packages, what each one deployed and whether it is intact; `sflow apm status --json` returns the same as `sflow-apm-status`.
- **Copilot:** ask it to run `singularity-flow apm status`; it reads only. Installing and updating packages stay APM's own commands.
- **VS Code:** run the same command in the integrated terminal.

## Guided workflow

1. Add a package with APM: `apm install acme/review-pack` or, from a marketplace, `apm install reviewer@acme-catalog`.
2. Read the result: `singularity-flow apm status`. Each package is listed with its commit and the agents, skills, instructions and prompts it deployed; agents in `.github/agents` that APM did not deploy are listed as the repository's own.
3. Commit `apm.yml`, `apm.lock.yaml` and the deployed files in one change. Status names any that are not committed and the `git add` that commits them.
4. Later, run `singularity-flow apm status` again before relying on the agents. A deployed file edited by hand or deleted is reported with the package it came from.

## State and safety

- Nothing is fetched, installed or written. The only process started is `apm --version`, from the home directory, to say which APM CLI this machine has.
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
- **"No APM CLI on this machine's PATH"**: install the APM CLI to change packages; reading them needs nothing.

## Related topics

- `sflow explain importing-assets`
- `sflow explain agents-and-routing`
- `sflow explain skill-master`
