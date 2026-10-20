# Environment bindings (ENV)

Status: adopted with security amendments

Environment bindings let a repository declare the *names* needed by QA, UAT, or another runtime without putting their values in Git. The committed authority is `singularity/environments.yml`; a machine-local binding is stored below the repository's Git common directory and is shared by that repository's worktrees. Values are never included in command arguments, JSON output, prompts, receipts, exports, or bundles.

## Adopted contract

The repository declaration has a closed, versioned shape:

```yaml
schemaVersion: 1
environments:
  qa:
    requires:
      - { name: API_BASE_URL, kind: endpoint, value: "https://qa.example.test" }
      - { name: DB_CONN, kind: secret }
      - { name: FEATURE_X, kind: flag, default: "off" }
    localFiles:
      - config/qa.local.yml
      - .env.qa
checks:
  integration-tests: { environment: qa }
neverCommit:
  - "**/*.local.yml"
  - ".env.*"
```

`checks` links an environment to an existing governed quality-command ID. It does not contain a shell command. Secret requirements cannot have `value` or `default`. Shared endpoint URLs cannot contain credentials, a query, or a fragment. Environment variables that can change the loader, executable search path, Git transport, or runtime injection behavior are reserved and refused.

Bindings are supplied on standard input so a value does not enter shell history or the process argument list:

```sh
your-approved-secret-helper --format sflow-env-json qa | singularity-flow env bind qa --stdin
singularity-flow env status --json
singularity-flow env audit --json
singularity-flow env unbind qa
```

The input has the closed shape `{"bindings":{"DB_CONN":{"source":"local","value":"<supplied privately>"}}}`. The CLI refuses interactive TTY input so a value is not echoed into terminal scrollback. Pipe it from an organisation-approved secret helper; do not put a real value in the command, a shell here-document, documentation, or Copilot Chat. A reference binding records only an opaque provider reference; an unresolved provider remains `unavailable` and never becomes a passing check.

## Safety boundaries

- The declaration is approved configuration and is included in the configuration overlay. A binding is tied to the repository, the exact declaration digest, and an opaque binding revision. Changing the declaration makes the old binding unavailable rather than silently reinterpreting it.
- Private binding records use hardened sidecar storage, atomic replacement, POSIX `0700/0600`, and enforced Windows ACLs. Status and audit output contain names and fingerprints only.
- Secret rotation changes the opaque binding revision. No secret-derived hash is stored.
- `localFiles` and `neverCommit` are enforced by candidate/publication gates even when `git add -f` bypasses `.gitignore`. Document intake refuses matching input before copying it into governed artifacts.
- The draft proposed rewriting `.gitignore` during initialization. The adopted design does not mutate an application checkout merely to mirror policy: teams may add those convenience ignores themselves, while exact-tree Git gates enforce the declaration whether or not an ignore rule exists.
- Environment-local files are excluded before World Model or packet content is read. The declaration is safe input; the declared local content is not.
- A missing or partial binding is `unavailable`, never `passed`, and the required gate remains owed.
- The current developer-local signed runner is not an isolated evidence runner. Environment-linked commands run only when the capability policy `localIntegrationEvidence` is `allowed` and the binding is complete. Values go to that command's process only, never to the worktree. Output is redacted. The run is recorded as `local-integration`, never relabelled as governed or isolated evidence. With the policy `off` (the default), they stay blocked.

## Fingerprints and evidence

Safe environment metadata may contain:

- environment name;
- declaration SHA-256;
- bound requirement names;
- endpoint-only SHA-256 aggregate;
- names of secret requirements present;
- binding source class;
- opaque binding revision and resulting environment fingerprint.

It may not contain a value, a secret hash, a provider error message, or a reusable provider reference. Existing GDP `environmentSha256` fields retain their historical host-attestation meaning; ENV uses distinct metadata and does not reinterpret signed records.

## Environment files

Frameworks read per-environment settings from files (Spring `application-uat.yml`, Node `.env.uat`, Django `settings/uat.py`, .NET `appsettings.UAT.json`, Go `config.uat.yaml`). `docs/SPEC-ENVIRONMENT-FILES-v1.md` is the contract; this section is how the engine behaves.

**Which files.** An *exact* `localFiles` path (no glob characters) is an environment file SFlow can create, place and edit; globs keep their protection-only meaning. A person may add a file only they use with `env files add <ENV> <PATH> --personal`; it is recorded in this machine's registry and protected exactly like a declared one. The `environments.yml` schema is unchanged.

**Where the real file is.** For each `(repository, environment, path)`, in order: a linked file (`env files link … --to <FILE>`, authoritative while linked); the workspace's folder for the environment when set and the file is there (`<root>/<repository-id>/<path>`); else the repository's private store `<git-common-dir>/singularity-flow/environment-files/v1/<environment>/<path>`, shared by every worktree. When none has the file, `create` writes it to the folder when one is set, else to the store. Store directories are 0700 and files 0600 through the hardened private-sidecar helpers, with enforced Windows ACLs as bindings use. The registry (`…/v1/registry.json`) records per entry the environment, path, declared or personal, source (`store`, `linked` or `root`), the linked location, and when it was created and changed: paths and metadata, never contents or hashes. Workspace folder settings (`roots.json`, keyed by workspace ID) and files outside every repository (a workspace's root `.env`, recorded with `--workspace`) live beside the workspace registry under `environment-files/v1/`, the latter in `workspaces/<workspace-id>/`.

**Templates.** The template of a path sits beside it with `.example`, `.template` or `.sample` inserted before the last extension or appended (`application-uat.example.yml`, `.env.uat.example`); the first in that order wins. `env files create <ENV> <PATH> --from-template` copies it (at most 1 MiB) into a new private file and prints the file's location to open; nothing is ever overwritten.

**Placing.** Before `app start`, `tests run` (capability and Story scope) and a publication or submission gate run in environment `E`, SFlow places `E`'s files of the run's repository into the checkout being run, a Story or candidate worktree included: in a monorepo only those under the capability's `sourceRoots`, else under the start entry's or command's working directory. On POSIX the path becomes a symbolic link to the real file; on Windows the file is copied, refreshed at each run, and the run notes the copy (a copy someone edited is left alone). The exact path is added once to the clone's common `.git/info/exclude`, under a comment naming SFlow; the team's `.gitignore` is never edited. A regular file already at the path is never overwritten: the run uses it, reports it as unmanaged and offers `env files adopt`, which moves it into the store and links it back. A tracked file at the path is a declaration error (`ENV_FILE_TRACKED`). When two environments declare the same path the link switches, except while an application started from SFlow in the other environment still uses it in that checkout (`ENV_FILE_IN_USE`, naming `app stop`). A missing file refuses the run before anything starts with `ENV_FILE_MISSING`, whose details are `{ environment, path, template, commands, missing }` and whose two commands create it (from the template when there is one) or link an existing file. A gate run blocks just that command with the same code. A repository without an exact `localFiles` path and without a registry pays two `lstat` calls and loads nothing more.

**Values in output.** A run that places files reads each one once (at most 1 MiB, never following a link) with a bounded parser for YAML, `.properties`, `.env`, JSON, TOML, INI and Python string literals. Values under a key that looks secret (password, secret, token, key, credential, private, auth) and values that look secret are added to the run's redactor and shown as `[redacted:FILE-KEY]` (for example `[redacted:APPLICATION_UAT_YML-SPRING_DATASOURCE_PASSWORD]`) in the application's output, the tests' output and the reports kept, exactly as bound values are. Booleans, numbers and placeholders such as `${DB_PASSWORD}` are not treated as secrets. Values are never stored, hashed or printed.

**Protection.** The commit, publication and document-intake gates match the registry's paths as well as `environments.yml`, even after `git add -f`; a scoped commit also checks force-added paths the clone ignores. Document intake refuses a placed file by its own path and refuses any file inside the store or at a linked location. World Model, grounding and knowledge reads skip registry paths like `localFiles`. An unreadable or invalid registry fails closed (`ENVIRONMENT_POLICY_UNAVAILABLE`).

| Command | What it does |
|---|---|
| `env files [ENV] [--repository ID \| --workspace] [--json]` | A read: per repository, app (capability by `sourceRoots`, or the repository) and environment, each file's path, origin, template, source, location, status (`missing`, `ready`, `linked`, `unmanaged`, `placed-here`), whether it is excluded, and what it is placed for. `--workspace` adds every member repository and the workspace-level files. |
| `env files create <ENV> <PATH> [--from-template]` | Creates the real file (empty, or from the template), places it, prints its location. |
| `env files link <ENV> <PATH> --to <FILE>` / `--clear` | Uses an existing readable regular file that is not tracked anywhere and not inside a checkout of this repository; refuses directories, link loops and unreadable files. `--clear` stops using it. |
| `env files adopt <ENV> <PATH>` | Moves an unmanaged regular file at the path into the store and links it back. |
| `env files add <ENV> <PATH> --personal` / `remove … --personal` | Adds (and excludes) or removes a personal file; removing keeps the real file and removes only SFlow's link. |
| `env files path <ENV> <PATH> [--json]` | A read: the resolved real location for an editor. |
| `env files root <ENV> <DIR>` / `--clear` | Sets or clears the active workspace's folder for an environment; it must be outside every member repository. |
| `env files place <ENV> [--capability ID \| --workspace]` | Places now what a run would place. |
| `env files suggest [--json]` | A read of file names only: Spring, Node, Django, FastAPI, Flask, .NET, Go and Rails candidates with their templates, and an `environments.yml` `localFiles` draft (with the merged document when every environment is already declared) for the configuration proposal. |

Every command also takes `--repository ID` (a member of the active workspace, from any member checkout) or `--workspace` (the workspace's own level) where it names a file, works from any checkout including Story worktrees, and refuses options it does not list. The JSON shapes are `sflow-env-files`, `sflow-env-file-path`, `sflow-env-file-created|linked|unlinked|adopted|added|removed`, `sflow-env-files-root`, `sflow-env-files-placed` and `sflow-env-files-suggest`, each with `schemaVersion: 1`; they hold paths and statuses only.

## Delivery boundary

This adoption implements the declaration, hardened local binding/status/audit surface, commit and document admission, World Model exclusion, quality-command linkage, and explicit unavailable behavior. Declaration changes use the normal approved-configuration proposal path; there is deliberately no `env declare` shortcut that silently edits authority. Actual secret resolution and materialization are enabled only through a separately approved isolated-runner authority with bounded output redaction and cleanup evidence. Until then, refusing execution is the intended safe behavior, not missing functionality disguised as success.
