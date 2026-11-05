---
id: environment-bindings
title: Test environments without committing their values
aliases:
  - env
  - qa-bindings
  - uat-bindings
  - environment-local
  - environment-files
  - env-files
related:
  - secrets
  - configuration
  - visual-verification
commands:
  - env
version: 7
---
An environment binding separates a names-only repository declaration from values held in private machine state. Put the closed declaration in `singularity/environments.yml`, bind values through standard input or an approved reference, and inspect only redacted status metadata. SFlow refuses declared local files at commit, candidate, publication, document-intake, and World Model boundaries. A missing binding is unavailable and never a pass. An environment-linked check runs on this machine only when the capability policy `localIntegrationEvidence` is `allowed` and the binding is complete: its values go to that process only, its output is redacted, and the run is recorded as `local-integration`, never as governed or isolated evidence. With the policy `off` (the default) it stays blocked.

## Purpose and prerequisites

Use this topic when a repository check needs a named QA, UAT, or similar execution environment without putting credentials or machine-local files in Git. The approved configuration must contain a strict, names-only `singularity/environments.yml`; every entry under `checks` must name an exact quality-command ID reachable from an approved workflow. Bindings are private machine state, so each developer or runner binds the declared names independently.

Before binding, select the intended workspace and repository, confirm that its approved configuration is current, and review the declaration. Saving the declaration through Configuration Center creates the normal approved-configuration proposal; it does not write secret values or silently change an active Story's pinned configuration.

## Use it from each surface

- **Shell:** `singularity-flow env status`, `singularity-flow env audit`, `singularity-flow env bind <name> --stdin`, and `singularity-flow env unbind <name>`; `singularity-flow env files` for environment files.
- **Copilot:** `/sf-environment` can explain status and audit. Binding and removing values are the person's own steps: it gives them `singularity-flow env bind <name> --stdin` or `singularity-flow env unbind <name>` for their terminal (the Copilot guard refuses both in every turn) and must never ask for a value in chat.
- **VS Code:** use the terminal command until an approved SecretStorage-backed binding control is available. Never put a secret in a webview command argument.

## Guided workflow

1. Review the approved declaration and verify that each check mapping uses the exact ID of a configured quality command. Change the declaration through Configuration Center and merge its approved-configuration proposal before relying on it.
2. Run `singularity-flow env status --json`. It shows missing names, never values.
3. Pipe a bounded JSON object to `singularity-flow env bind <name> --stdin`. Do not use command-line `NAME=value` arguments.
4. Run `singularity-flow env audit --json` before candidate freeze or publication.
5. If a check reports that an approved isolated runner is unavailable, keep the result owed; do not substitute a local pass. A capability may instead allow local integration evidence (`policy.localIntegrationEvidence: allowed`, through a capability proposal); see `sflow explain run-and-test`.

## Environment files

Frameworks read per-environment settings from files such as `application-uat.yml`, `.env.uat` or `appsettings.UAT.json`. An exact `localFiles` path (no glob characters) is an environment file; `env files add <ENV> <PATH> --personal` adds one only you use. SFlow keeps the real file in a private store below the Git common directory (shared by every worktree), in a workspace folder set with `env files root <ENV> <DIR>`, or at a file you link with `env files link <ENV> <PATH> --to <FILE>`.

1. Run `singularity-flow env files --json` to see each file's status (`missing`, `ready`, `linked`, `unmanaged`, `placed-here`) and location, never its contents. `env files suggest` lists framework candidates and drafts `localFiles` for the configuration proposal.
2. Create a missing file with `singularity-flow env files create <ENV> <PATH> --from-template` (or without the flag for an empty file), then open the printed location and fill in the values. `env files path <ENV> <PATH>` prints it again.
3. Start the application or run the tests in that environment. The run places the files into the checkout (a symbolic link; a refreshed copy on Windows), excludes each path once in `.git/info/exclude`, and blanks secret-looking values as `[redacted:FILE-KEY]` in output. A missing file refuses the run with `ENV_FILE_MISSING` before anything starts and names both fixes.
4. A regular file already at the path is never overwritten; move it into the store with `env files adopt <ENV> <PATH>`.

The commit, publication and document-intake gates refuse every environment-file path, even after `git add -f`. See `docs/ENVIRONMENT-BINDINGS.md` ("Environment files") for the full contract.

## What is private with no setup

Two things need no declaration (`docs/SPEC-ENVIRONMENT-FILES-v2.md`).

- **Always-local names:** `.env`, `.env.*`, `application-local.yml|yaml|properties` and `*.local.yml|yaml|json|properties|toml|ini`. A commit that adds one is refused, Copilot is refused it, and it cannot become a document or a specification source. Git stops offering it through the clone's `.git/info/exclude`. Templates such as `.env.example` and `.env.local.sample` are shared. A file with one of these names that a team already tracks stays shared config, and `env audit` asks for its class. A repository can add names with `neverCommit` and cannot remove these.
- **A real value in shared config:** for example an unquoted `password: Xq7m…` in `application.yml`, `config.yaml` or `src/test/resources/application-test.yml`. `password: ${DB_PASSWORD}` is fine. Copilot is refused the file until the value is gone, and a document is refused. A commit refuses a new value. One already in Git only warns, so nothing stops a merge. `SINGULARITY_FLOW_CONFIG_VALUES=warn` holds refusal off for a machine or a CI job that needs time.
- **Plain chats too:** in a repository that uses SFlow, a Copilot chat with no `/sf-` command is refused the same files. The capability that owns a file can turn that off with `singularity-flow capability plain-chat <ID> --secrets allow`, which is a reviewed proposal. A `/sf-` command is always refused, and `/sf-pause` turns the check off on your machine. See [Capability mapping](capability-management.md).
- **A class for `.env.*`:** a file with such a name is private until a person says otherwise. `singularity-flow env files classify` lists each one with its class. `singularity-flow env files classify <PATH> shared --reason <why>` records that it is safe to share, in the file, so the diff shows it. Its values are still read, and it is refused while it holds a real one. Copilot may not run this.

To clear a finding:

1. An untracked file: `singularity-flow env files add <ENV> <PATH> --personal`, then `singularity-flow env files adopt <ENV> <PATH>`. It moves to the private store and links back, so tests still find it.
2. A tracked file: commit `${NAME}` and keep the value in an always-local file such as `application-local.yml` or `.env`, or in `env bind` where the repository declares the name.
3. A committed always-local file: `git rm --cached <PATH>`, then a commit that names no paths. Your copy stays, and the gates let that removal through. If the team means to keep it in Git, classify it as shared instead.
4. A false alarm: put `# sflow-allow-secret: <why>` on the line or the line above it. It shows in the diff and is reviewed.

`singularity-flow env audit` lists all of this with no declaration. A value already in the last publication is in Git's history, so rotate it; history is never rewritten automatically.

## State and safety

The declaration is public repository configuration; binding values are local private state outside every worktree. Status, audit output, packets, receipts, exports, logs, and World Model inputs may contain names and approved fingerprints, but never secret values or secret hashes. `env bind` and `env unbind` mutate only local binding state. Configuration save and proposal activation validate the declaration's closed schema and its exact quality-command links before approved authority can move.

The current developer-local runner can prove that a binding exists, but it is not an independently attested isolated runner. Unless the capability allows local integration evidence, an environment-dependent gate remains unavailable rather than being recorded as passed; when it is allowed, the run is labelled `local-integration` with the environment, the commit and who ran it, and every bound secret in its output is shown as `[redacted:NAME]`.

## Troubleshooting

- If `env status` says an environment is partial, bind only the listed missing names through standard input and recheck status.
- If Configuration Center reports an unknown quality-command ID, copy the exact `id` from a reachable workflow phase's `qualityCommands`; do not use a display label or shell command text.
- If a declaration changed after a binding was created, rebind it so the local record is tied to the current declaration fingerprint.
- If audit names a declared local file, remove it from the index and every artifact. Adding it to `.gitignore` alone does not satisfy the gate.
- If a check says that isolated execution is unavailable, preserve that result and configure an approved runner; do not reinterpret a developer-local run as evidence.
- If a Copilot or VS Code action cannot accept secret input safely, use the displayed shell command. Never paste the value into chat, a webview, or a command-line argument.
- If a run says `ENV_FILE_MISSING`, run one of the two commands it names. If it says `ENV_FILE_TRACKED`, the path is in Git: remove it from the repository before using it as an environment file. If it says `ENV_FILE_IN_USE`, stop the application it names first.

## Related topics

Continue with `sflow explain secrets`, `sflow explain configuration`, and `sflow explain visual-verification`. See `docs/ENVIRONMENT-BINDINGS.md` for the declaration schema, fingerprint, storage, runner, and deferred-capability boundaries.
