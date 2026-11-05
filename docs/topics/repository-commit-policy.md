---
id: repository-commit-policy
title: Repository commit policy and hook compatibility
version: 2
commands: [git-policy]
keywords: [commit, hooks, ticket, tracking, timestamp, policy]
related: [configuration, app-review]
---

# Repository commit policy and hook compatibility

Inspect repository-specific commit rules from Configuration Center → Commit policy, and check that SFlow's commits satisfy them without disabling a repository's hooks.

## Purpose and prerequisites

`git.commitPolicy` in approved `singularity/workflow.yml` chooses `off`, `discover` or `enforce`. Off/discover keep compatibility and do not claim policy validation. Enforcement needs an approved exact-tree/message equivalent or a qualified native profile. Each destination resolves its own canonical work key, template, full message and hook coverage; the user need not reenter settled Story identity for every commit.

## Use it from each surface

- **Shell:** `singularity-flow git-policy show --json`
- **Copilot:** `/sf-git-policy show`
- **VS Code:** `@sflow /git-policy`, or Configuration Center → Commit policy.

## Guided workflow

1. **Discover.** **Discover effective hooks** reads the effective Git settings, hook bytes and setup files without running scripts or installing tools.
2. **Propose.** **Validate and propose policy** sends a draft through existing configuration review. Saving or discovery does not activate the policy or approve work.
3. **Inspect a plan.** `singularity-flow git-policy plan --operation sha256:<OWNER-ISSUED-ID> --json` inspects an existing host-bound plan.
4. **Recheck.** `validate` rechecks its registered rules without committing, pushing or approving. A hand-authored JSON document cannot authorize validation. Native object production remains inside the existing commit owner.

## State and safety

Metadata is subject to ordinary policy unless an exact reviewed ref/path/purpose profile applies. Portable facts are retained through the existing state ledger; local execution bindings and permissions are re-established on another laptop. No screenshot, signature or passing check substitutes for human approval or the application's **All good** confirmation.

## Troubleshooting

Missing tools, unknown hooks, unsupported runtime semantics and changed dependencies are reported honestly. Do not disable hooks, invent a ticket, guess a package manager, or amend a retained commit. A timestamp is generated only by its admitted real hook. Retries reuse the same retained object rather than replaying message mutation. Unknown outcomes need the owner's existing recovery.

## Related topics

`configuration` for how a policy change is reviewed, and `app-review` for accepting a delivered application. See the shipped repository commit policy guide for configuration examples, bounded formatter rules, writer coverage and unsupported native contexts.
