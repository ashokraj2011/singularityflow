---
name: sflow-capability-map
description: Propose, review, and activate one capability or an atomic team mapping.
disable-model-invocation: true

---

# Map a capability or onboard a team

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story or repository required; use only the selected lead URL. Resolve local checks with `singularity-flow workspace current --json`; never search `$HOME`.

## One capability

1. Ask first for the exact credential-free Git URL; run `singularity-flow capability inspect-repository <GIT-URL> --json`.
2. `already-mapped` stops without proposing a duplicate. Ask before `known-repository-unassigned`; resolve `ambiguous`; require complete `not-onboarded` coverage. For `unreachable`, Do not reinterpret an unverified absence as a new repository. Stop on incomplete `inconclusive`.
3. Continue only after an explicit request for a new mapping. Run `singularity-flow capability organisation <LEAD-URL> --json`; show parents, then ask only for missing ID, name, kind, parent, ownership, roots, and clone policy.
4. Confirm and run once:

   `singularity-flow capability map <ID> --lead <LEAD-URL> --kind <KIND> [--name TEXT] [--parent ID] [--repository URL] [--jira-project KEY] [--teams A,B] --json`

5. Report branch/base/commit. Run `singularity-flow capability proposal <REVIEW-BRANCH> --lead <LEAD-URL> --json`; show its diff. After the contributor explicitly approves, run `singularity-flow capability activate <REVIEW-BRANCH> --lead <LEAD-URL> --confirm <FULL-PROPOSAL-COMMIT> --json`.
6. `CAPABILITY_CONFIGURATION_UNPROTECTED` needs `--acknowledge-unprotected`; otherwise use external review, then run the same exact-hash `singularity-flow capability activate` command again. Run exact recovery actions only. `singularity-flow capability publish` is a projection-repair command, not activation.

## Team onboarding

1. Ask for team name/ID, Jira project, and lead URL. Use `/sf-repositories` with an explicit GitHub/GHE host. Rows remain **Not checked yet**. Never inspect a whole result page.
2. Select at most 20 repositories with child ID/name; resolve opaque refs through `singularity-flow repositories select`.
3. Inspect the selected repositories **one at a time** with `singularity-flow capability inspect-repository <URL> --lead <LEAD-URL> --include-proposals --json`; continue after failures. Label **Will add**, **Will link**, **Needs a choice**, or **Left out**. Setting one repository aside must not discard eligible results.
4. Stop if none qualify. Otherwise show the exact proposed tree, set-aside reasons, and complete command before mutation:

   `singularity-flow capability map-team <TEAM-ID> --lead <LEAD-URL> --name <TEAM-NAME> [--jira-project KEY] [--member <CHILD-ID>=<GIT-URL>]... [--member-name <CHILD-ID>=<NAME>]... [--link <EXISTING-ID>]... --json`

   Run it exactly once after confirmation, creating one atomic proposal.
5. Show the proposal diff and stop for explicit approval; then use the activation command above.
6. Require configuration, audit, projection, and links. Offer `/sf-workspace`; do not invoke it.

Never hand-edit maps, use raw Git, create a workspace, or start work.
