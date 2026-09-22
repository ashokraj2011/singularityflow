---
id: environment-bindings
title: Test environments without committing their values
aliases:
  - env
  - qa-bindings
  - uat-bindings
  - environment-local
related:
  - secrets
  - configuration
  - visual-verification
commands:
  - env
version: 1
---
An environment binding separates a names-only repository declaration from values held in private machine state. Put the closed declaration in `singularity/environments.yml`, bind values through standard input or an approved reference, and inspect only redacted status metadata. SFlow refuses declared local files at commit, candidate, publication, document-intake, and World Model boundaries. A missing binding is unavailable and never a pass. Environment-bound execution is allowed to satisfy a gate only through an approved isolated runner; the developer-local runner is not silently promoted into that role.

## Purpose and prerequisites

Use this topic when a repository check needs a named QA, UAT, or similar execution environment without putting credentials or machine-local files in Git. The approved configuration must contain a strict, names-only `singularity/environments.yml`; every entry under `checks` must name an exact quality-command ID reachable from an approved workflow. Bindings are private machine state, so each developer or runner binds the declared names independently.

Before binding, select the intended workspace and repository, confirm that its approved configuration is current, and review the declaration. Saving the declaration through Configuration Center creates the normal approved-configuration proposal; it does not write secret values or silently change an active Story's pinned configuration.

## Use it from each surface

- **Shell:** `singularity-flow env status`, `singularity-flow env audit`, `singularity-flow env bind <name> --stdin`, and `singularity-flow env unbind <name>`.
- **Copilot:** `/sf-environment` can explain status and audit. It must direct secret entry to the terminal and must never ask for a value in chat.
- **VS Code:** use the terminal command until an approved SecretStorage-backed binding control is available. Never put a secret in a webview command argument.

## Guided workflow

1. Review the approved declaration and verify that each check mapping uses the exact ID of a configured quality command. Change the declaration through Configuration Center and merge its approved-configuration proposal before relying on it.
2. Run `singularity-flow env status --json`. It shows missing names, never values.
3. Pipe a bounded JSON object to `singularity-flow env bind <name> --stdin`. Do not use command-line `NAME=value` arguments.
4. Run `singularity-flow env audit --json` before candidate freeze or publication.
5. If a check reports that an approved isolated runner is unavailable, keep the result owed; do not substitute a local pass.

## State and safety

The declaration is public repository configuration; binding values are local private state outside every worktree. Status, audit output, packets, receipts, exports, logs, and World Model inputs may contain names and approved fingerprints, but never secret values or secret hashes. `env bind` and `env unbind` mutate only local binding state. Configuration save and proposal activation validate the declaration's closed schema and its exact quality-command links before approved authority can move.

The current developer-local runner can prove that a binding exists, but it is not an independently attested isolated runner. Until an approved runner is configured, an environment-dependent gate remains unavailable rather than being recorded as passed.

## Troubleshooting

- If `env status` says an environment is partial, bind only the listed missing names through standard input and recheck status.
- If Configuration Center reports an unknown quality-command ID, copy the exact `id` from a reachable workflow phase's `qualityCommands`; do not use a display label or shell command text.
- If a declaration changed after a binding was created, rebind it so the local record is tied to the current declaration fingerprint.
- If audit names a declared local file, remove it from the index and every governed artifact. Adding it to `.gitignore` alone does not satisfy the gate.
- If a check says that isolated execution is unavailable, preserve that result and configure an approved runner; do not reinterpret a developer-local run as governed evidence.
- If a Copilot or VS Code action cannot accept secret input safely, use the displayed shell command. Never paste the value into chat, a webview, or a command-line argument.

## Related topics

Continue with `sflow explain secrets`, `sflow explain configuration`, and `sflow explain visual-verification`. See `docs/ENVIRONMENT-BINDINGS.md` for the declaration schema, fingerprint, storage, runner, and deferred-capability boundaries.
