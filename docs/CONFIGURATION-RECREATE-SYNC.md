# Recreate & sync configuration

Use **Recreate & sync configuration** in the main VS Code panel or Configuration Center.
The click authorizes one operation for the selected repository's configuration authority; it
does not open a merge, confirmation dialog, or model conversation.

The operation reads today's `sflow/config` and all pending workflow, capability, and onboarding
proposals on that authority. It reconstructs their intended edits instead of merging historical
YAML text. Formatting-only changes are ignored. Unchanged proposal values never overwrite newer
approved values. Explicit changes win at the changed key; unrelated settings survive. Overlapping
proposals are processed oldest first, then by branch identity for equal commit timestamps.

The complete result is validated before publication. Custom workflows, agents, skills, reusable
instructions, templates, test settings and capabilities are retained when they are in the approved
configuration or pending proposals. Unsaved editor drafts are not proposals and are not included.

One atomic server update creates:

- One ordinary descendant configuration commit, with no Git merge/rebase or history rewrite.
- Commit-addressed backup tags under `sflow-config-recreate/` for the previous approved commit
  and every original proposal commit; an occupied tag with different history is never replaced.
- A configuration recreation log documenting original identities and replaced current values.
- Exact retirement of the original proposal branches, only in the same transaction as their
  backups and the updated configuration.

The caller's application files, HEAD, working tree, index, Story pins, approvals and ledger are not
changed. Known authority references in the selected workspace are refreshed to the exact new
commit; linked Story/worktree pins and references to other authorities are preserved. Missing
repositories are not cloned. If reference refresh needs attention, the result says so and clicking
again retries only the remaining sync, without another configuration commit. The UI reloads the
current authority after success. This is configuration synchronization,
not Story migration, factory reset, package upgrade, or an automatic merge into application `main`.
Credentials, server-side hooks, branch protection and server review requirements are never bypassed.
Configuration validation owns the isolated candidate; application worktree hooks are not run.
An atomic-update refusal preserves the original refs. No success is reported without a fresh
observation proving the new commit, backups and branch retirement. Click again after resolving
remote access or a concurrently moved authority; a completed retry is a no-op.

Terminal preview (read-only):

```sh
singularity-flow configuration recreate-sync --json
```

Terminal execution (the flag is authorization, no further questions):

```sh
singularity-flow configuration recreate-sync --apply --json
```

Copilot: `/sf-configuration recreate-sync --apply`. The main-panel action needs no model.

## Implementation boundary

The isolated Git owner has a reviewed entry in `scripts/git-bypass-baseline.json`. Local calls are
timeout- and output-bounded; remote observation, fetch and atomic push use the shared remote Git
boundary. A blob-filtered clone materializes configuration only. Exact-byte index writes bypass
worktree filters, and a recursive tree diff proves that no application or Story path changes,
including when application blobs have intentionally not been downloaded. Tests exercise that
partial-clone boundary, dirty caller preservation, concurrent proposal movement, atomic refusal,
lost acknowledgement reconciliation and double-click coalescing. No audit rule is disabled.

To inspect preserved history, use the backup tag returned in `backupRefs`. No original proposal
commit is deleted from history. Restoring that history is a separate deliberate operation.
