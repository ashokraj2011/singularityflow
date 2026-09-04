# Progressive capability disclosure

Most repositories need no capability setup. Run:

```bash
singularity-flow init
singularity-flow start WORK-123
```

With no approved `singularity/capabilities.yml`, SFlow deterministically treats the repository as
one delivery capability named **This repository**, with the stable ID `repository-root`. New Stories
pin its exact repository identity, configuration, policy, scope, approvals, dependencies, and
resolver digest. A later organisation change cannot move an active Story's boundary.

## See the current boundary

```bash
singularity-flow capability show
singularity-flow capability show services/payments
singularity-flow why services/payments
```

These commands are deterministic and model-free. They show the owning capability, permitted Story
scope, required people, and the reason for the decision. In VS Code, open **Configuration →
Capabilities**. The simple screen shows **This repository** until more structure is approved.

## Add detail only when it becomes useful

```bash
singularity-flow capability add payments --owns services/payments/** --team payments
singularity-flow capability protect services/ledger --approver ledger-reviewers \
  --reason "ledger changes require an independent review"
singularity-flow capability depend model-serving@latest --from payments --contract inference-api
```

The first command that needs explicit structure materializes a version-2 map containing the same
`repository-root`, proves that root policy and fallback ownership are unchanged, and creates a
review branch. It does not activate the map. Inspect the returned branch and exact commit, merge it
through normal repository controls, then run the returned `capability activate` command. Existing
Stories keep their pinned rules; only Stories started after activation use the new map.

Ownership accepts a repository-relative directory or one trailing `/**` shorthand. Other globbing,
absolute paths, traversal, links that escape the repository, equal-specificity owners, and unrelated
overlapping owners are refused before a proposal is published. The longest matching approved
directory prefix owns a path; anything else falls back to `repository-root`.

A dependency input such as `@latest` is discovery only. A proposal is created only after SFlow has
an exact published contract ID, version, content SHA-256, publication SHA-256, and publisher
authority. The stored dependency never moves automatically. Activation revalidates that exact
publication rather than resolving `latest` again.

## Existing capability maps

Version-1 maps remain readable and keep their established mixed human/tool editing behavior. An
upgrade never rewrites them. To opt into receipt-managed changes:

```bash
singularity-flow capability adopt-managed --lead <LEAD-URL> --preview
singularity-flow capability adopt-managed --lead <LEAD-URL> --confirm sha256:<PLAN>
```

Preview is read-only. Confirmation creates a review proposal that preserves effective policy,
ownership, dependencies, comments where YAML editing permits, proposal history, and all active
Story pins. A direct edit to an activated managed map is refused unless its exact change receipt is
present and matches the reviewed before and after states.

The advanced hierarchy, multi-repository mapping, clone strategy, world-model composition, and
architecture views remain available from the capability detail and expert documentation. They are
not prerequisites for initialization or a first Story.
