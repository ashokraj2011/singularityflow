---
name: sflow-capability-map
description: Map a capability to a Git repository in an organisation's capability tree, or place a capability that groups others beneath a parent. Use when the contributor wants to describe what their organisation builds, add a new service or product to the map, or start using Singularity Flow on a repository that has never been governed.
disable-model-invocation: true

---

# Map a capability

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.

Capabilities form a tree. A `delivery` ships from repositories; a `collection` groups capabilities. The tree has one root and any depth.

The lead repository owns `singularity/capabilities.yml`; `portfolio.yml` declares repositories. Flow edits a temporary clone, so this works outside Git.

1. Run `singularity-flow capability leads --json` for the lead repositories this
   machine knows. If exactly one is returned, use it. If several are,
   ask which organisation this capability belongs to. If none is, ask for the
   lead repository's clone URL — do not guess one.
2. Run `singularity-flow capability organisation <LEAD-URL> --json` and show the
   tree and possible parents.
3. Ask only for missing: kebab-case ID, display name, kind (`collection` or `delivery`), parent, and repository URL(s). A delivery requires repositories; a collection forbids them. Parent may be any capability allowed by validation; omit only for the root.
4. Run:

   `singularity-flow capability map <ID> --lead <LEAD-URL> --kind <KIND> [--name TEXT] [--parent ID] [--repository URL] [--jira-project KEY] [--teams A,B] --json`

5. Report the review branch, base, and commit. State that the proposal targets
   `sflow/config`; application branches and state were not changed. It is not
   active yet.
6. Ask the contributor to review and merge the branch through the repository's
   normal controls. After they confirm the merge, run:

   `singularity-flow capability publish --lead <LEAD-URL> --json`

   Then re-read `capability organisation` and report the active tree.

## Starting from nothing

An ungoverned lead repository is a normal starting point. The first map writes
the proposed `singularity/` configuration to a review branch based on
`sflow/config`; it never pushes an application or state branch. Existing
configuration is preserved and only missing starter files and the capability
change are added. Do not run `bootstrap` first.

## Boundaries

- Jira projects and team names belong to a **capability**, not to a workspace.
  Set them here.
- A workspace is capabilities plus a local working directory. Do not create one
  from this skill; offer `/sf-workspace` afterwards.
- Do not edit `singularity/capabilities.yml` or `singularity/portfolio.yml` by
  hand. Both are validated on every write, and a hand edit skips that.
- Do not merge, force-push, or delete the review branch. The contributor's
  repository controls decide what reaches `sflow/config`. Do not run
  `capability publish` before the contributor confirms the review branch was
  merged there.
- Policy is inherited from the root toward each child and every fold is
  monotonic: a child may tighten what an ancestor set and can never loosen it.
  Use `/sf-capabilities` to explain the effect rather than reasoning about it
  from the file.
