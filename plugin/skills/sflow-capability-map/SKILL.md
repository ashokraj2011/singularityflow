---
name: sflow-capability-map
description: Map a capability to a Git repository in an organisation's capability tree, or place a capability that groups others beneath a parent. Use when the contributor wants to describe what their organisation builds, add a new service or product to the map, or start using Singularity Flow on a repository that has never been governed.
disable-model-invocation: true

---

# Map a capability

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.

Capabilities form a tree. A `delivery` ships from repository entries; a `collection` groups related capabilities. The tree has one root and any depth.

The lead repository owns `singularity/capabilities.yml`; its `portfolio.yml` declares repositories. Flow edits it in a temporary clone, so this also works outside Git.

1. Run `singularity-flow capability leads --json` for the lead repositories this
   machine already knows. If exactly one is returned, use it. If several are,
   ask which organisation this capability belongs to. If none is, ask for the
   lead repository's clone URL — do not guess one.
2. Run `singularity-flow capability organisation <LEAD-URL> --json` and show the
   tree. This is what the capability is being added to, and it is also the list
   of possible parents.
3. Ask only for missing: kebab-case ID, display name, kind (`collection` or `delivery`), parent, and repository URL(s). A delivery requires repositories; a collection forbids them. Parent may be any capability allowed by validation; omit only for the root.
4. Run:

   `singularity-flow capability map <ID> --lead <LEAD-URL> --kind <KIND> [--name TEXT] [--parent ID] [--repository URL] [--jira-project KEY] [--teams A,B] --json`

5. Report the commit that was pushed and the tree as it now stands.

## Starting from nothing

A lead repository that has never been governed is the ordinary starting point,
not an error. The first `capability map` writes `singularity/` into it, declares
it in its own portfolio, names the orphan `state` branch, commits and pushes —
all in the same operation. Say that this happened; do not run `bootstrap`
separately first.

## Boundaries

- Jira projects and team names belong to a **capability**, not to a workspace.
  Set them here.
- A workspace is capabilities plus a local working directory. Do not create one
  from this skill; offer `/sf-workspace` afterwards.
- Do not edit `singularity/capabilities.yml` or `singularity/portfolio.yml` by
  hand. Both are validated on every write, and a hand edit skips that.
- Policy is inherited from the root toward each child and every fold is
  monotonic: a child may tighten what an ancestor set and can never loosen it.
  Use `/sf-capabilities` to explain the effect rather than reasoning about it
  from the file.
