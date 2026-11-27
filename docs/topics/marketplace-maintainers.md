---
id: marketplace-maintainers
title: Setting up a marketplace repository for your organisation
aliases:
  - marketplace-owners
  - lifecycle-records
  - codeowners
  - marketplace-channels
commands:
  - marketplace
related:
  - importing-assets
  - apm-packages
  - skill-master
version: 3
---
A marketplace repository shares agents and skills across an organisation. This guide is for the people who keep one: how to name an owner for each item, record who approved each change of its lifecycle, declare who guards those records, and publish stable and beta channels. SFlow reads all of it at the commit a team trusts, and shows it everywhere the item is.

## Purpose and prerequisites

Use this topic when you maintain a marketplace repository: an `apm.yml` at its root whose `marketplace.packages` list `agents/<name>` and `skills/<name>`, each with its own `apm.yml`. Every addition here is optional and backward compatible: a marketplace without them behaves as before, and an SFlow build from before them reads a marketplace that has them without a refusal. Nothing here needs a server.

## Use it from each surface

- **Shell:** `sflow marketplace catalog` shows each item's owner in its own column and a lifecycle line, with who and when, for each item that is not generally available; `--json` gives `owner`, `lifecycleRecord`, `channel` and the marketplace's own `findings` for each row. `sflow marketplace browse <ID>` shows an owner and lifecycle line under each entry, and `sflow skill catalog` names each skill's owner and lifecycle.
- **Copilot:** `/sf-marketplace` shows the owner, lifecycle and channel of each item in its table.
- **VS Code:** **Singularity Flow: Marketplace** has an **Owner** column and an Owner filter; the lifecycle column shows the state, the **Stable** or **Beta** channel and **Not guarded** where no code owner guards an approval, and its **Who and when** detail names who approved it, when, and opens its reviewed change in your browser. The **All skills** page and Workflow Studio's Library and conversion review show the same owner and lifecycle.

## Guided workflow

1. **Add an owner to each item.** In each item's `apm.yml`, add an `owner:` block: `team` (a short lower-case ID such as `web-qa`), `name` (what people see), `handle` (the team's code-owner handle, as CODEOWNERS writes it), `contact`, `issues` (the https address of the team's issues page, where feedback goes) and `feedback-labels`. With no block, SFlow names the code owners of the item's folder, else its `maintainer-email`, else the marketplace's owner, and says which.
2. **Give each item a lifecycle record.** Create `lifecycle.yml` beside each `apm.yml`, with `state` and a `history` of moves: each entry has `from`, `to`, `at` (YYYY-MM-DD), `by` or `approved-by`, and `change` (the https address of its reviewed pull request). A deprecated item adds `deprecation:` with `replaced-by`, `reason` and `sunset`. Keep `lifecycle-state` in `apm.yml` equal to `state` if APM tools read it. The states are proposed, early (experimental or beta), approved, ga (generally available), deprecated and retired; the moves are proposed → approved or retired, approved → ga, deprecated or proposed, ga → deprecated, deprecated → ga or retired.
3. **Declare the code owners.** In `.github/CODEOWNERS` (GitHub) or `CODEOWNERS` (GitLab), give the governance group every lifecycle record and each team its own items. GitHub and GitLab use the last rule that matches, so the lifecycle rule comes last: `**/lifecycle.yml @acme/marketplace-stewards`. GitLab's sections are joined.
4. **Make the host enforce it.** SFlow cannot see branch protection, so it says the marketplace *declares* code owners, never that the host enforced them. On GitHub, protect the default branch and both channel branches and require review from code owners; on GitLab, protect the branches and turn on code-owner approval; on Azure DevOps, set required reviewers by path in the branch policy and keep a `CODEOWNERS` file as the declaration SFlow reads.
5. **Change a lifecycle** with a pull request that changes only the item's `lifecycle.yml`: set `state`, add one `history` entry with this pull request's address as its `change`, and, for a deprecation, the `deprecation:` block. Its code owners approve it. A team sees the new state when its pin next moves.
6. **Publish channels.** Declare them in `channels.yml` beside the root `apm.yml`, under a top-level `channels:` key: `beta: { ref: channels/beta }` and `stable: { ref: channels/stable, after: beta }`. Keep them out of `apm.yml`: APM 0.35's `apm pack` refuses a `channels` key in its `marketplace:` block, and SFlow no longer reads it there. Create both branches, protected and fast-forward only, move beta first, and move stable only to a commit already on beta. Never rewrite a channel. A team that trusts a channel's ref sees **Stable** or **Beta** on each item.

## State and safety

- A lifecycle record is data. SFlow checks that it holds together and never refuses an item for it: each problem is a finding the marketplace owns, shown on the catalog row and in the conversion review's feedback, with its fix. The checks: the record against the `apm.yml`'s `lifecycle-state` (`marketplace-lifecycle-mismatch`), each move against the moves above (`marketplace-lifecycle-jump`), the last entry against `state`, each `from` against the entry before, the dates against each other and the commit, every `approved-by` against the record's code owners, and whether any code owner guards it (`marketplace-lifecycle-unguarded`).
- An approval no code owner guards still counts as approved, and every surface labels it **Not guarded**.
- The state that counts is the one at the commit a team trusts now, not the one recorded when a skill was imported: a skill deprecated since is never offered once the pin moves. A deprecated or retired item is never offered by a task; a retired one cannot be installed.
- A deprecated or retired item a team still uses (in its skill library, an agent's imports, a workflow made from it or attaching it, or an open Story) is flagged on its Marketplace and All skills pages, in Workflow Studio, by `singularity-flow check`, and in a task's plan and a Story's start, and nothing is removed. Name its replacement in `replaced-by` as an item this marketplace lists, neither deprecated nor retired: only then do teams get **Replace with…**, through the same reviewed import.
- An `issues` address that is not https is dropped, with a `marketplace-metadata` finding. SFlow reads at most 50 history entries of a record, `CODEOWNERS` up to 64 KiB and 2,000 rules.

## Troubleshooting

- **An item shows "Lifecycle not guarded by code owners".** No CODEOWNERS rule with an owner covers its `lifecycle.yml` (or, with no record, its `apm.yml`). Add the lifecycle rule last in CODEOWNERS.
- **"Owner named in apm.yml; CODEOWNERS names someone else for its folder".** The `owner.handle` is not among the code owners of the item's folder. Make the two agree.
- **The owner says "(from maintainer-email)".** The item has no `owner:` block and no code owner of its folder: add the block.
- **"apm.yml declares marketplace.channels, which SFlow does not read there".** Move the channels from `apm.yml`'s `marketplace:` block into `channels.yml` beside it; until then the marketplace publishes no channel SFlow can read.
- **A history entry is called a jump.** It moves between states the lifecycle does not connect, such as proposed straight to ga. Record each move in its own reviewed change.

## Related topics

- `sflow explain importing-assets` — trusting a marketplace, the catalog, and the conversion review.
- `sflow explain apm-packages` — APM packages as the APM CLI left them.
- `sflow explain skill-master` — the skill library a marketplace skill is imported into.
