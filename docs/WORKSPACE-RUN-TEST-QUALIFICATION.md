# Workspace Run & Test qualification

Implemented on `codex/workspace-run-test`, based on main `d0b3976d` and integrated with
main `35d32106`. Publication was explicitly requested with native Windows qualification still
pending. The Windows preflight job never started:
the hosting account reported failed payments or an insufficient spending limit. Its temporary
CI-only branch has been removed. No Windows pass is claimed.

The Mac fixtures exercise independent linked-worktree applications, personal run profiles,
dependency order and command identity, owned-service teardown, manually started service reuse,
startup failure and cancellation, occupied ports, private YAML copies and reset retention,
credential-free connection checks, exact target selection, CLI dispatch and evidence/preview
confirmation. Existing suites cover test evidence admission, environment-file exclusion from
Git and prompts, run configuration roundtrips and checkout retention. These are CLI integration
and VS Code model tests, not an installed interactive editor or application-framework matrix.

Mac validation: 234 tests passed, none failed and one optional real debugpy/Delve case was
skipped because those tools were unavailable. The final dependency-cancellation refinement
was also checked by all 19 dedicated workspace tests. Source checks, TypeScript checking, VS Code builds and
CLI/VS Code bundle-budget checks passed. The installed-editor checks below remain pending.

A small local fixture measured inventory at approximately 4 ms with zero Git processes and
zero remote calls. Separate CLI processes measured approximately 200 ms on the first invocation
and 100 ms repeated, with an already booted Node runtime and ordinary OS caching. This is not a
reboot-cold disk measurement, a large-repository benchmark or a Windows estimate.

The workspace page adds three UI modules to the existing lazy panel bundle; its module ceiling
is adjusted from 286 to 289. Its byte ceiling and the activation, status, catalog and review
byte ceilings remain unchanged. Worktree-specific helpers stay outside the startup Git helper,
so an unused Run & Test feature does not add its code to the cold startup/catalog closure.

Outstanding qualification:

1. Restore Windows CI capacity, then run the targeted fixtures and existing Run & Test,
   environment-file, checkout-retention, command-registry and packaging suites natively.
2. Exercise application start/stop, cancellation, private-file copy placement and process identity
   with Windows paths containing spaces. Verify that ACL/probe failures preserve process records.
3. Verify the installed editor page on both platforms: select a different Story while reads are
   pending, run/restart/stop, edit a private copy, review a diff, and distinguish preview tests from
   phase evidence. Check the exact checkout and task command in the first-run confirmation.
4. Recheck these results against the current main build when native Windows and installed-editor
   qualification can run; the Mac results do not substitute for those checks.

Optional real debugpy/Delve integration remains inapplicable on a host without those tools; any
such skip must be reported explicitly and is not a release qualification pass.
