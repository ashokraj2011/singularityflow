# Environment files (ENVF) — v1

Status: owner decisions recorded 2026-10-20; implementation in progress. `docs/SPEC-ENVIRONMENT-FILES-v2.md`
adds what is private with no setup. It extends
`docs/ENVIRONMENT-BINDINGS.md` (bound values) and `docs/SPEC-RUN-AND-TEST-v1.md` (starting the
application and running tests per environment).

Frameworks read their per-environment settings from files: Spring's `application-uat.yml` or
`.properties`, Node's `.env.uat`, Django's `settings/uat.py`, .NET's `appsettings.UAT.json`, Go's
`config.uat.yaml`. These files hold secrets. A person must be able to create and edit them easily, SFlow
must remember where each environment's files are on this machine, and the files must never reach Git.

## Owner decisions (2026-10-20)

1. **Default location.** SFlow keeps each repository's environment files in one private place on this
   machine. That place is outside every checkout and shared by every worktree of the repository. A
   person may instead point a file at any location they already use.
2. **Monorepos and multi-repository workspaces work the same way.** A monorepo has one store with each
   file scoped to its app. A workspace with several Git repositories has one store per repository and
   one view across them. A workspace may set one folder per environment for all of its repositories.
3. **Never in Git.** Each placed path is excluded locally in that clone's `.git/info/exclude`, so Git
   never shows it, and refused by the commit and publication gates even when forced. The team's
   `.gitignore` is never edited.

## What already exists and is reused

`singularity/environments.yml` declares, per environment:
- `requires`: names of values;
- `localFiles`: paths and globs for local files;
- `checks`.

The gates already refuse `localFiles` and `neverCommit` paths, and World Model and packet reads exclude
them. Values are bound with `env bind --stdin` into a private sidecar below the Git common directory.
None of this changes. The environments.yml schema does not change, because older engines refuse
unknown keys there.

## Model

### Declared files (team, committed, no secrets)

An **exact** path in an environment's `localFiles`, one with no glob characters, is an environment file
SFlow can create, place and edit:

```yaml
environments:
  dev:
    localFiles: [services/api/src/main/resources/application-dev.yml, apps/web/.env.dev]
  uat:
    localFiles: [services/api/src/main/resources/application-uat.yml, apps/web/.env.uat]
```

- **Globs** keep their current meaning: protection only.
- **Templates are found by name.** A file is the template of a declared path when it sits beside it and
  `.example`, `.template` or `.sample` is inserted before the last extension or appended. For example,
  `application-uat.example.yml` for `application-uat.yml`, or `.env.uat.example` for `.env.uat`. A
  template is committed and holds placeholders only. When several match, the first in that order wins.

### Personal files (this machine only)

A person may add a file only they use, with `env files add <ENV> <PATH> --personal`. It is recorded in
the machine-local registry. It is protected exactly like a declared file: excluded locally, and refused
by this machine's gates, which read the registry as well as `environments.yml`.

### Where the real file is (machine-local)

Resolution order for `(repository, environment, path)`:
1. **a linked location**: a file the person pointed to with `env files link … --to <FILE>`;
2. **the workspace's folder for that environment**, when set: `<root>/<repository-id>/<path>`;
3. **the repository's private store**:
   `<git-common-dir>/singularity-flow/environment-files/v1/<environment>/<path>`.

Rules for the store and its records:
- Directories are created 0700 and files 0600, with the hardened private-sidecar helpers. Windows uses
  the same ACL rules as environment bindings.
- The registry, `<git-common-dir>/singularity-flow/environment-files/v1/registry.json`, records per
  entry: environment, path, declared or personal, source (`store`, `linked` or `root`), the linked
  location, and when it was created or changed. It never holds contents or hashes of contents.
- Workspace folder settings are machine-local, beside the workspace registry, keyed by workspace ID.

**Files outside any repository**, such as a multi-repository workspace's root `.env`, are recorded at
workspace level and stored in a workspace-level private store. They can never be committed.

### Placing files for a run

Before `app start`, `tests run`, or a publish or submit gate run in environment `E`, SFlow places `E`'s
files into the checkout being run, including a Story worktree:

- **Which files:**
  - the files of the run's repository;
  - in a monorepo, only those under the capability's `sourceRoots`, or under the start entry's
    `workingDirectory` when the capability has none;
  - for a capability spanning repositories, each repository's own files in its own checkout.
- **How:**
  - On POSIX, the declared path becomes a symlink to the resolved real file.
  - On Windows, the file is copied, refreshed at each run, and the copy is noted.
- **Exclusion:** the exact path is added once to that clone's `.git/info/exclude` (shared by its
  worktrees), with a comment naming SFlow.
- **Never overwritten:**
  - A regular file already at the path is left alone. The run reports it as "unmanaged" and offers
    `env files adopt`, which moves it into the store and links it back.
  - A tracked file at the path is refused, as a declaration error.
- **Shared paths:** when two environments declare the same path (for example `.env`), the link
  switches to the chosen environment. A run is refused while an application started from SFlow in
  another environment still uses it.
- **Missing files:** a run whose environment file is missing is refused before anything starts. The
  refusal names the file and the two ways to fix it: create it from the template, or use an existing
  file.

### Secrets in output

When a run places environment files, SFlow reads each file's values with a bounded parser:
YAML/YML, `.properties`, `.env`, JSON, TOML and INI.

- Values under keys that look secret (the `app-suggestions` rule: password, secret, token, key,
  credential, private, auth) and values that look secret are added to the run's redactor.
- They are blanked as `[redacted:FILE-KEY]` in the application's and the tests' output, as bound values
  are.
- Values are never stored, hashed or printed.

### Protection

- **Gates:** the commit, publication and document-admission gates match the registry's paths as well
  as `environments.yml`.
- **No reads:**
  - World Model, packet, grounding and knowledge reads skip placed files and the store.
  - Copilot's guard refuses reading or editing any environment file, the store, a linked location or
    a workspace folder, through file tools, search tools, delegation, and shell commands that name
    them.
  - Copilot may run `env files` reads and `env files create --from-template`. It may never `link`,
    `adopt`, `root`, edit or read contents.

## Commands

| Command | What it does |
|---|---|
| `env files [ENV] [--repository ID \| --workspace] [--json]` | A read. Per repository, app and environment: each file with its path, declared or personal, template, source, real location (a path only), status (`missing`, `ready`, `linked`, `unmanaged`, `placed-here`), and whether it is excluded. With `--workspace`: every member repository plus workspace-level files. |
| `env files create <ENV> <PATH> [--from-template] [--repository ID]` | Creates the store file (from the template, or empty), places it, and prints its private location to open. |
| `env files link <ENV> <PATH> --to <FILE>` | Uses an existing file. It must be a readable regular file, and not tracked in any repository. |
| `env files adopt <ENV> <PATH>` | Moves an unmanaged file at the path into the store and links it back. |
| `env files add <ENV> <PATH> --personal` / `env files remove <ENV> <PATH> --personal` | Adds or removes a personal file. |
| `env files path <ENV> <PATH> [--json]` | A read: the resolved real location, for an editor to open. |
| `env files root <ENV> <DIR> \| --clear` | Sets or clears the workspace folder for an environment. |
| `env files place <ENV> [--capability ID]` | Places the files into this checkout now (runs do it themselves). |
| `env files suggest [--json]` | A read. Framework-known candidates (Spring, Node `.env.*`, Django/Flask/FastAPI, .NET `appsettings.*.json`, Go, Rails) with their templates, plus an `environments.yml` `localFiles` draft for the configuration proposal. It never reads values. |

Every command works from any checkout of the repository, including Story worktrees, and against the
active workspace's member repositories.

## VS Code: Environment files

A page, also reachable from the Run & test section and the Run/Debug Configurations editor:

- **Layout:** grouped by repository, then app (capability or source root), then environment tabs
  (DEV | UAT | …). Each file shows its status, source and location.
- **Actions per file:** **Create from template**, **Open** (edits the real file in a normal editor
  tab), **Use existing file…**, **Adopt**, **Reveal**, **Stop using linked file**.
- **Workspace level:** **Set folder for UAT…** and **Add personal file…**, plus a "Declare for the
  team" draft through the configuration proposal.
- **Before a run:** starting or testing in an environment with a missing file shows the two fixes
  instead of failing in a terminal.
- **Safety:** the page never shows contents. Editing happens in VS Code's own editor on the real file.

## Milestones

1. **Engine:**
   - the registry and the store;
   - resolution and placement, with the local exclude;
   - gates reading the registry;
   - the redaction of file values;
   - the `env files` commands;
   - workspace and multi-repository scope;
   - documentation in ENVIRONMENT-BINDINGS.md and the topic.
2. **VS Code:** the Environment files page, the run pre-flight, and the entries from Run & test and the
   editor.
3. **Copilot:** the guard's refusals, and the `/sf-environment` skill offering `env files` reads and
   create-from-template.
4. **Verification:**
   - a monorepo fixture (Spring-style and Node apps) and a two-repository workspace fixture;
   - Story worktree placement;
   - a real VS Code check;
   - the full suite.
