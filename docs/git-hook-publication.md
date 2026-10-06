# Local Git hook failures during Story publication

Story intake checks transport access with a `git push --dry-run --no-verify` probe. It creates no remote Story branch and does not run local application hooks. This is not test evidence or proof that provider receive policy will allow the eventual push. Earlier fetches or local caches may already have changed.

Actual publication, including the combined Story/ledger push, still runs the repository's hooks and uses its existing exact ref leases. A local `pre-push` failure is classified separately from credentials, network failures, and provider-side receive hooks. A failed combined push does not immediately rerun a known broken local hook through the sequential fallback.

For `.husky/pre-push: line 7: pm: command not found`, inspect line 7: `pm` could be a typo or a missing approved tool. SFlow does not assume it means `npm`, install a package manager, edit the hook, or disable hooks globally. If Node/package-manager commands work in a terminal but fail from VS Code or IntelliJ, verify the IDE-launched environment; version managers may require Husky's user initialization for GUI launches. Restart the IDE after repairing that environment.

Review both redacted, bounded output streams and any reported Git-visible changes. The publication observation covers paths and metadata, not ignored files or byte-exact source integrity. An unavailable observation does not mean the worktree was unchanged. Hook-generated files and authored work are retained; no automatic cleanup is performed.

If publication retained a governed commit, repair the hook/runtime and use the displayed synchronization/recovery route for that exact operation. Do not recreate the Story, amend the retained commit, or push unrelated refs to work around the failure. An ambiguous remote outcome still requires the existing exact-ref reconciliation; hook diagnostics do not waive it. Retry only when the diagnosed condition has changed.
