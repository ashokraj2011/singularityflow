---
name: sflow-workspace-bootstrap
description: Prepare, diagnose, resume, or abandon a recoverable Singularity Flow workspace setup before governed Story work begins.
disable-model-invocation: true
argument-hint: "[REMOTE-OR-MANIFEST|BOOTSTRAP-ID]"
---

# Prepare or recover a workspace

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository.

Use this skill when no workspace exists yet, a clone failed, authentication changed, a target was
occupied, or Home reports an unfinished workspace bootstrap.

1. If the argument starts with `bst_`, run
   `singularity-flow workspace bootstrap status <BOOTSTRAP-ID> --json`. Otherwise collect the exact
   repository/organisation URL or manifest, workspace ID, base directory, capabilities when the
   source is an organisation, and whether governed state initialization is intended. Never invent
   these values.
2. Start setup with `singularity-flow workspace prepare <SOURCE> --id <ID> --base <DIRECTORY>
   [--capability <ID>]... [--lead-capability <ID>] [--initialize] --json`.
3. Show the exact target, every repository and selected remote branch, all blocker classifications,
   and the returned bootstrap ID. The prepare step writes only machine-local recovery state; it
   does not create the workspace destination.
4. Never request a token, password, private key, proxy secret, or TLS bypass. For authentication,
   ask the contributor to use the approved Git credential helper outside the chat and then retry.
5. When preflight is ready, ask the contributor to confirm the recorded workspace ID and run the
   exact returned resume command. Resume reruns preflight before any destination mutation.
6. If resume is degraded or waiting, preserve and report the same bootstrap ID, its journal path,
   the classified finding, and every returned recovery action. Do not start a second setup for the
   same plan. If the attempt budget is exhausted after the blocker is corrected, obtain the exact
   workspace confirmation and a human reason, then run `singularity-flow workspace bootstrap retry
   <BOOTSTRAP-ID> --confirm <WORKSPACE-ID> --reason <TEXT> --json`. This opens another bounded
   recovery generation only after target ownership and plan integrity are proven.
7. Abandon only after the contributor asks, using
   `singularity-flow workspace bootstrap abandon <BOOTSTRAP-ID> --reason <TEXT> --json`. Abandoning
   the session does not delete an already-created workspace shell or repository.
8. Use `singularity-flow workspace doctor --json` for local checks. Add `--network` only with the
   contributor's explicit intent to contact pending-session remotes.

This skill never edits application files, bypasses certificate validation, adopts an existing
directory automatically, or claims that a failed push was completed.
