---
name: sflow-capability-map
description: Map a capability to a Git repository in an organisation's capability tree, or place a capability that groups others beneath a parent. Use when the contributor wants to describe what their organisation builds, add a new service or product to the map, or start using Singularity Flow on a repository that has never been governed.
---

# Map a capability

What an organisation builds is a tree of capabilities. A capability that names a
repository is a leaf that **ships**; one that names no repository **groups** the
capabilities beneath it. The tree has exactly one root and may go to any depth,
like a directory.

The map lives in `singularity/capabilities.yml` in the **lead repository**, and
the repositories capabilities ship from are declared in its
`singularity/portfolio.yml`. Nothing is checked out to edit either: the lead is
cloned to a temporary directory, edited, pushed and discarded. So this works from
a directory that is not a Git repository at all.

1. Run `singularity-flow capability leads --json` for the lead repositories this
   machine already knows. If exactly one is returned, use it. If several are,
   ask which organisation this capability belongs to. If none is, ask for the
   lead repository's clone URL — do not guess one.
2. Run `singularity-flow capability organisation <LEAD-URL> --json` and show the
   tree. This is what the capability is being added to, and it is also the list
   of possible parents.
3. Establish, asking only for what context has not already answered:
   - the identifier, lower-case kebab-case, like `payments-api`;
   - the display name;
   - the kind — one of `portfolio`, `domain`, `product`, `service`, `platform`,
     `component`, or a kind the map already uses. Do not invent a new spelling
     of one that is already there;
   - the parent, which must be a capability that groups rather than one that
     ships. Omit it only for the root;
   - the repository clone URL, when this capability ships from one. Omit it for
     a capability that groups others — declaring a repository for a capability
     that does not have one is how a portfolio fills up with repositories nobody
     clones.
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
  from this skill; offer `/sflow-workspace` afterwards.
- Do not edit `singularity/capabilities.yml` or `singularity/portfolio.yml` by
  hand. Both are validated on every write, and a hand edit skips that.
- Policy is inherited from the root toward each child and every fold is
  monotonic: a child may tighten what an ancestor set and can never loosen it.
  Use `/sflow-capabilities` to explain the effect rather than reasoning about it
  from the file.
