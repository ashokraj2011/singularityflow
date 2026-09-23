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

1. Ask the exact credential-free Git URL; preview `singularity-flow capability onboard <GIT-URL> --dry-run --json`.
2. Relay the `repository-onboarding-plan/v1` effects, preserved data, `planId`, and Shell/Copilot actions. Use its status label; hide authority pins, SHAs, and cache leases.
3. Never infer `--migrate`, `--recreate`, or `--reset-local`; preview its `--dry-run --json` form only after explicit choice.
4. Confirm the exact effects and preserved data; run the exact Shell command returned by the plan once: `singularity-flow capability onboard <GIT-URL> --confirm-plan <PLAN-ID> --json`.
5. Keep retry.
6. Only when compatibility diagnostics are requested, run `singularity-flow capability inspect-repository <GIT-URL> --json`; it is available for one release and is not the normal front door. Status: `already-mapped`, `known-repository-unassigned`, `not-onboarded`, `ambiguous`, `unreachable`, `inconclusive`. `already-mapped`: without proposing a duplicate. `unreachable`: Do not reinterpret an unverified absence as a new repository.
7. Continue only after an explicit request for a new mapping; then ask only for missing ID, name, kind, parent, and scope. Confirm:

   `singularity-flow capability map <ID> --lead <LEAD-URL> --kind <KIND> --json`

   For `delivery`, add `--repository <GIT-URL>`; `collection` omits it.

8. Show `singularity-flow capability proposal <REVIEW-BRANCH> --lead <LEAD-URL> --json`. If the user explicitly approves, run `singularity-flow capability activate <REVIEW-BRANCH> --lead <LEAD-URL> --confirm <FULL-PROPOSAL-COMMIT> --json`. On `CAPABILITY_CONFIGURATION_UNPROTECTED`, use `--acknowledge-unprotected` or external review; then run the same exact-hash `singularity-flow capability activate` command again. `singularity-flow capability publish` is a projection-repair command.

## Team onboarding

1. Select at most 20 repositories; Never inspect a whole result page.
2. Inspect the selected repositories **one at a time** (step 6 plus lead/proposals). Label **Will add**, **Will link**, **Needs a choice**, or **Left out**. Setting one repository aside must not discard eligible results.
3. If any qualify, show the exact proposed tree and complete command before mutation:

   `singularity-flow capability map-team <TEAM-ID> --lead <LEAD-URL> --name <TEAM-NAME> --member <CHILD-ID>=<GIT-URL> --json`

   Run it exactly once after confirmation for one atomic proposal.
4. Stop for explicit approval; use step 8. Offer `/sf-workspace`; do not invoke it.
