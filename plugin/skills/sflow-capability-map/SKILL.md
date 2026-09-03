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

1. Ask first and only for the exact credential-free Git URL. Do not collect capability metadata yet.
2. Run `singularity-flow capability inspect-repository <GIT-URL> --json`; use `--lead <LEAD-URL>` only after explicit selection. Preserve its full result.
3. Branch before collecting details:
   - `already-mapped`: show lead, repository ID, and capabilities; stop without proposing a duplicate. Offer `/sf-workspace` or `/sf-capabilities`.
   - `known-repository-unassigned`: ask whether to create a capability for it.
   - `not-onboarded`: name `checkedLeads`; only a complete result permits mapping.
   - `ambiguous`: show all matches, ask for one lead, and inspect again with `--lead`.
   - `unreachable`: show failures and stop. Do not reinterpret an unverified absence as a new repository; retry with `--refresh` after repair.
   - `inconclusive`: show `pendingMatches` first and offer review of an existing proposal. Otherwise stop unless `completeness` is `no-authorities`, `proposalCoverage` is `complete`, and the target is a reachable candidate. Then ask: use it as the first map, or supply an existing lead and inspect again. Never infer either choice.
   - Unknown: report and stop.
4. Continue only after an explicit request for a new mapping. Select the lead, run `capability organisation <LEAD-URL> --json`, show parents, then ask only for missing ID, name, kind, parent, Jira/team, roots, and clone policy. `delivery` uses the URL; `collection` confirms it will not.
5. Run:

   `singularity-flow capability map <ID> --lead <LEAD-URL> --kind <KIND> [--name TEXT] [--parent ID] [--repository URL] [--jira-project KEY] [--teams A,B] --json`

6. Report branch, base, and commit. Run `singularity-flow capability proposal <REVIEW-BRANCH> --lead <LEAD-URL> --json`, show its diff, then ask approval.
7. Only after the contributor explicitly approves, run:

   `singularity-flow capability activate <REVIEW-BRANCH> --lead <LEAD-URL> --confirm <FULL-PROPOSAL-COMMIT> --json`

8. `CAPABILITY_CONFIGURATION_UNPROTECTED` needs acceptance before `--acknowledge-unprotected`. If protection rejects activation, preserve it for external review; after merge, run the same exact-hash `capability activate` command again. For invalid history, run `capability fsck` and offer its safe choices.
9. Refresh `capability organisation` and report the active tree.

## Boundaries

- Do not create a workspace; offer `/sf-workspace` afterward. Never hand-edit map files or use raw Git for proposals. `capability publish` is a projection-repair command, not activation.
