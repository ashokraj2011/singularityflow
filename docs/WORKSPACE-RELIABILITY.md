# Workspace reliability plane

Singularity Flow recovery begins before a Story or repository exists. A workspace setup is an
integrity-checked machine-local session, Git publication is an exact commit-to-ref intent, and
automatic healing is limited to deterministic operations with declared postconditions.

## Bootstrap and recovery

`workspace prepare` records the requested destinations, remotes, branches, clone strategy,
initialization choice, attempt budgets, and a plan hash before creating the destination. Machine and
remote preflight classify blockers; `workspace bootstrap resume` rechecks the recorded plan under an
expiring lease and continues the same staged-clone journal. Required repository failure never becomes
ready. `abandon` retains the diagnostic record and never deletes a workspace or clone.

The default operation budgets are three preflight attempts, two materialization attempts, and one
initialization attempt. Expired leases and verified orphan staging roots have closed, bounded healers.
Healers cannot call other healers, and no receipt may claim success without its postcondition.

## Existing clones

Adoption is explicitly selected and previewed. The proof covers the canonical repository root,
origin fingerprint, current and default branch, dirty bytes, worktrees, submodules, case collisions,
and SFlow configuration. A dirty tree needs its exact content hash. The workspace manifest points to
the external clone; all consumers use the shared repository resolver. No Git state or file is changed.

## Transport intents

Pre-Story publication records the exact local commit, expected prior remote object, configured
remote, and destination `refs/heads/...`. Retry observes the remote first. An already-published exact
commit completes without pushing; divergence refuses; an unreadable target remains outcome-unknown.
Force, hook bypass, TLS bypass, and credentials in URLs are forbidden. Attempts and circuit cooldown
are persisted, while the local commit is always retained.

## Diagnostics and surfaces

`workspace doctor` is local by default and `--network` is explicit. With `--network`, a repeatable
`--repository` option can name exact credential-free URLs when there is no unfinished bootstrap
session. Proxy and certificate checks report source names only and leave credentials and trust
configuration to Git and the operating system. My Work renders without a repository and offers the
same sealed recovery destinations used by other gateway hosts: continue setup, use an existing clone,
prepare a workspace, run diagnostics, or explore registered workspaces. VS Code owns the forms;
lifecycle and recovery law remains in core.

Native CI exercises the reliability contracts on Windows, macOS, and Linux with Node 20 and the
current supported Node release. Network fixtures use local bare remotes and never live credentials.
