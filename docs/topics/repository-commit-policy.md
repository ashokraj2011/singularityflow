---
id: repository-commit-policy
title: Repository commit policy and hook compatibility
version: 1
commands: [git-policy]
keywords: [commit, hooks, ticket, tracking, timestamp, policy]
related: [configuration, app-review]
---

# Repository commit policy and hook compatibility

Inspect repository-specific commit rules from Configuration Center → Commit policy. **Discover effective hooks** reads the effective Git settings, hook bytes and setup files without running scripts or installing tools. **Validate and propose policy** sends a draft through existing configuration review. Saving or discovery does not activate the policy or approve work.

- Copilot: `/sf-git-policy show`
- Shell: `singularity-flow git-policy show --json`
- VS Code (model-free): `@sflow /git-policy`

`git.commitPolicy` in approved `singularity/workflow.yml` chooses `off`, `discover` or `enforce`. Off/discover keep compatibility and do not claim policy validation. Enforcement needs an approved exact-tree/message equivalent or a qualified native profile. Each destination resolves its own canonical work key, template, full message and hook coverage; the user need not reenter settled Story identity for every commit.

`singularity-flow git-policy plan --operation sha256:<OWNER-ISSUED-ID> --json` inspects an existing host-bound plan. `validate` rechecks its registered rules without committing, pushing or approving. A hand-authored JSON document cannot authorize validation. Native object production remains inside the existing commit owner.

Missing tools, unknown hooks, unsupported runtime semantics and changed dependencies are reported honestly. Do not disable hooks, invent a ticket, guess a package manager, or amend a retained commit. A timestamp is generated only by its admitted real hook. Retries reuse the same retained object rather than replaying message mutation. Unknown outcomes need the owner's existing recovery.

Metadata is subject to ordinary policy unless an exact reviewed ref/path/purpose profile applies. Portable facts are retained through the existing state ledger; local execution bindings and permissions are re-established on another laptop. No screenshot, signature or passing check substitutes for human approval or the application's **All good** confirmation.

See the shipped repository commit policy guide for configuration examples, bounded formatter rules, writer coverage and unsupported native contexts.
