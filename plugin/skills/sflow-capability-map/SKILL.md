---
name: sflow-capability-map
description: Propose, review, and activate a capability in an organisation map, including first-time repository onboarding.
disable-model-invocation: true

---

# Map a capability

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

`delivery` ships from repositories; `collection` groups capabilities. The lead owns the map. Flow uses a temporary clone, so no checkout is required.

1. Run `singularity-flow capability leads --json`. Use the sole result; otherwise ask which lead URL. Never guess.
2. Run `singularity-flow capability organisation <LEAD-URL> --json`; show the tree and possible parents.
3. Ask only for missing: kebab-case ID, name, kind, optional parent, and repository URL(s). `delivery` requires repositories; `collection` forbids them.
4. Run:

   `singularity-flow capability map <ID> --lead <LEAD-URL> --kind <KIND> [--name TEXT] [--parent ID] [--repository URL] [--jira-project KEY] [--teams A,B] --json`

5. Report branch, base, and full commit; it targets `sflow/config` and is not active. Run `singularity-flow capability proposal <REVIEW-BRANCH> --lead <LEAD-URL> --json`, show all changed files and the diff, then ask approval for that exact commit.
6. Only after the contributor explicitly approves, run:

   `singularity-flow capability activate <REVIEW-BRANCH> --lead <LEAD-URL> --confirm <FULL-PROPOSAL-COMMIT> --json`

7. On `CAPABILITY_CONFIGURATION_UNPROTECTED`, explain the exception and ask explicit acceptance. Only then repeat with `--acknowledge-unprotected`.
8. If branch protection or permissions reject activation, report the preserved branch for external review. After confirmed merge into `sflow/config`, run the same exact-hash `capability activate` command again to record the audit and projection.
9. On `CAPABILITY_PROPOSAL_HISTORY_INVALID`, run `singularity-flow capability fsck --lead <LEAD-URL> --json`. Offer its two explicit recovery choices: recreate the mapping from current `sflow/config`, or discard only the unrelated-history proposal with the engine-provided exact full commit after collecting a reason. Never discard a valid proposal.
10. Run `capability organisation <LEAD-URL> --refresh --json`; report the active tree.

## Starting from nothing

For an ungoverned lead, map directly; do not bootstrap. The proposal creates the required configuration review branch without writing application or state branches.

## Boundaries

- Jira projects and teams belong to capabilities, not workspaces.
- Do not create a workspace here; offer `/sf-workspace` afterwards.
- Never hand-edit the capability or portfolio files.
- Never use raw Git to merge, push, force-push, or delete the proposal. Use exact-commit activation after human approval; it cannot bypass branch protection. `capability publish` is a projection-repair command, not an activation substitute.
- Inherited policy is monotonic; use `/sf-capabilities` to explain it.
