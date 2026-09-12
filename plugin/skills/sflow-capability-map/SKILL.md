---
name: sflow-capability-map
description: Inspect a Git URL, then propose, review, and activate its capability mapping.
disable-model-invocation: true

---

# Map a capability

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story or repository required; use only the selected lead URL. Resolve local checks with `singularity-flow workspace current --json`; never search `$HOME`.

1. Ask only for the exact credential-free Git URL; do not collect metadata yet.
2. Run `singularity-flow capability inspect-repository <GIT-URL> --json`; add `--lead <LEAD-URL>` only after explicit selection. Preserve the result.
3. Branch before collecting details:
   - `already-mapped`: show lead/repository/capabilities; stop without proposing a duplicate.
   - `known-repository-unassigned`: ask whether to create a capability for it.
   - `not-onboarded`: name `checkedLeads`; mapping requires complete coverage.
   - `ambiguous`: show matches, select one lead, and inspect again with `--lead`.
   - `unreachable`: show failures and stop. Do not reinterpret an unverified absence as a new repository.
   - `inconclusive`: show `pendingMatches` and offer review. Otherwise stop unless there are no authorities, proposal coverage is complete, and the target is reachable; ask whether it is the first map or another lead should be inspected.
   - Unknown: report and stop.
4. Continue only after an explicit request for a new mapping. Run `capability organisation <LEAD-URL> --json`, show parents, then ask only for missing ID, name, kind, parent, Jira/team, roots, and clone policy. `delivery` uses the URL; `collection` does not.
5. Run:

   `singularity-flow capability map <ID> --lead <LEAD-URL> --kind <KIND> [--name TEXT] [--parent ID] [--repository URL] [--jira-project KEY] [--teams A,B] --json`

6. Report branch, base, and commit. Run `singularity-flow capability proposal <REVIEW-BRANCH> --lead <LEAD-URL> --json`, show its diff, then ask approval.
7. Only after the contributor explicitly approves, run:

   `singularity-flow capability activate <REVIEW-BRANCH> --lead <LEAD-URL> --confirm <FULL-PROPOSAL-COMMIT> --json`

8. `CAPABILITY_CONFIGURATION_UNPROTECTED` needs acceptance before `--acknowledge-unprotected`. Preserve refusal for external review; after merge, run the same exact-hash `capability activate` command again. Run `capability fsck` for invalid history.
9. Activation is staged. `CAPABILITY_ACTIVATION_AUDIT_PENDING` means configuration is active: retry the returned exact activation only for its audit. Projection/portability pending uses returned `capability publish`; never merge/reset again. `CAPABILITY_ACTIVATION_RECOVERY_CONFLICT` requires the exact reported history, not a newer head.
10. Refresh organisation and report success only when configuration, audit, projection, and required links are complete.

## Boundaries

- Do not create a workspace; offer `/sf-workspace` afterward. Never hand-edit map files or use raw Git for proposals. `capability publish` is a projection-repair command, not activation.
