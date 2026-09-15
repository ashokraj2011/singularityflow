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

1. Ask first for the exact credential-free Git URL.
2. Run `singularity-flow capability inspect-repository <GIT-URL> --json`; add `--lead <LEAD-URL>` only after explicit selection.
3. Branch before collecting details:
   - `already-mapped`: show matches and stop without proposing a duplicate.
   - `known-repository-unassigned`: ask whether to map it.
   - `ambiguous`: show choices and inspect again with the selected `--lead`.
   - `unreachable`: report and stop. Do not reinterpret an unverified absence as a new repository.
   - `not-onboarded`: show `checkedLeads`; require complete coverage.
   - `inconclusive`: show `pendingMatches`; stop unless coverage is complete, no authority exists, and the target is reachable.
4. Continue only after an explicit request for a new mapping. Run `singularity-flow capability organisation <LEAD-URL> --json`; show parents, then ask only for missing ID, name, kind, parent, Jira/team, roots, and clone policy. `delivery` uses the URL; `collection` does not.
5. Run:

   `singularity-flow capability map <ID> --lead <LEAD-URL> --kind <KIND> [--name TEXT] [--parent ID] [--repository URL] [--jira-project KEY] [--teams A,B] --json`

6. Report branch/base/commit. Run `singularity-flow capability proposal <REVIEW-BRANCH> --lead <LEAD-URL> --json`, show the diff, then ask approval.
7. Only after the contributor explicitly approves, run:

   `singularity-flow capability activate <REVIEW-BRANCH> --lead <LEAD-URL> --confirm <FULL-PROPOSAL-COMMIT> --json`

8. For `CAPABILITY_PROPOSAL_PACKAGED_COMPATIBILITY_REQUIRED`, run only its exact `repair-proposal` after confirmation. Show repaired paths/new SHA and review the new diff. It upgrades proven package bytes; custom bytes require normal review. Never auto-activate.
9. `CAPABILITY_CONFIGURATION_UNPROTECTED` needs consent for `--acknowledge-unprotected`; otherwise use external review. After that merge, run the same exact-hash `singularity-flow capability activate` command again. Use `singularity-flow capability fsck` for invalid history.
10. Activation is staged. For audit/projection recovery run only its returned exact action; never merge/reset again. A recovery conflict requires reported history, not current HEAD.
11. Report success only when configuration, audit, projection, and required links are complete.

## Boundaries

- Do not create a workspace. Never hand-edit maps or use raw Git for proposals. `singularity-flow capability publish` is a projection-repair command; it is not activation.
