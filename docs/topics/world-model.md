---
id: world-model
title: World Model and the Repository brief
aliases:
  - worldmodel
  - wm
  - grounding
commands:
  - wm
related:
  - agents-and-routing
  - model-independence
  - knowledge-and-remote-assets
version: 39
---
The World Model is the **Repository brief** that every phase prompt gets: a few cited bullets about
the code the Story touches, read from the committed source with no build and no model call. It
covers the rules that apply (with their messages and HTTP statuses), contracts, flows, what the
Story's change touches, and the risky places. Each bullet ends with its source as a file and line;
what could not be determined is one closing "Not known" line.

The brief is guidance. It never blocks, refuses or authorizes anything. If it cannot be built, the
prompt goes out without it and a warning says why.

## What a phase receives

The brief is built from repository knowledge (see [the knowledge model guide](../KNOWLEDGE-MODEL.md)),
rule-like statements in README files and `docs/`, and plain-language explanations already accepted
on this machine (labelled as inferred). Items that match the Story's title, description, acceptance
criteria and changed files come first. "What a change touches" is read from the Story's own changed
lines and the files its plan names, not from the last commit. Sections are ordered for the phase's
reader (product owner, architect, developer or tester) and cut to a small per-phase budget of 2 to
4 KB; what did not fit is counted on a pointer line.

Knowledge is cached by content on this machine, so every Story worktree reuses it. Above 4,000 code
files a repository is not read whole: a phase builds only the areas the Story changes or names, and a
Story that names no area gets a warning instead of a brief.

## See it

```bash
singularity-flow wm brief --phase PHASE [--work-id ID]   # exactly what that phase receives; records nothing
singularity-flow wm show-prompt --phase PHASE            # the whole composed prompt
singularity-flow wm knowledge brief                      # the repository brief for people, with its sources
singularity-flow wm knowledge show business              # the product owner's view
```

- `wm knowledge show|items|slice|status|build|eval|calls|areas` read repository knowledge;
  `confirm`, `correct` and `reject` record a person's review of one item.
- `wm knowledge brief` and `wm knowledge explain` can be model-written when model use is on; each
  statement is checked against the evidence it cites. Composing a phase prompt never calls a model.
- `wm ast ...` reads optional structural facts (`sflow explain ast-intelligence`); `wm read`,
  `wm read-views` and `wm read-contract` read views over those AST facts.
- `wm compose` (alias `wm inject`) composes a phase prompt, `wm cache status|clear` manages the
  composition cache, and `wm design-inventory --from-records` summarizes a Story's design records.

## Turn it off

- `worldModel.knowledge.prompt: off` leaves the brief out of every phase prompt (default `slice`).
- `worldModel.knowledge.maxBytes` (2048 to 32768) replaces the per-phase budgets for every phase.
- A work type's `intelligence.worldModel: off` leaves the brief out for that work type; `inherit`
  (the default) and `required` keep it.

## Source scope

For a normal repository leave the scope settings out: the brief reads the whole application tree.
In a monorepo, set `worldModel.sourceRoots` to the owned application directories and
`worldModel.sharedRoots` to the contracts and libraries they rely on; capability scopes override
application roots at the nearest child and add shared roots. `worldModel.excludedRoots` leaves paths
out of the scope, and files `singularity/environments.yml` declares environment-local (secrets,
machine settings) are never read. AST intelligence reads the same scope. `worldModel.stateBranch` and
`worldModel.remote` are kept only as compatibility aliases for the ledger's state branch and remote.
Run `sflow doctor --performance --offline` to see scoped and total file counts.

## Use it from each surface

- **Shell:** `sflow wm brief`, `sflow wm knowledge ...` and `sflow wm ast ...`. Run
  `singularity-flow wm --help` for the exact forms supported by this build.
- **Copilot:** `/sf-worldmodel` reads the brief, repository knowledge, AST facts and composed
  prompts.
- **VS Code:** **Singularity Flow: World Model Settings** opens Configuration Center's World Model
  tab: the Repository brief and a Source scope form. Saving the scope writes a validated local draft,
  or a review proposal when configuration has an external authority; review and publish it before it
  takes effect. **Singularity Flow: Repository Brief** (`singularityFlow.openRepositoryKnowledge`)
  shows every view of the brief with branch and phase pickers, and **Review Repository Knowledge**
  records a confirm, correct or reject review.

## Upgrading

The registered World Model (views such as `dev.impact` and `biz.rules`, built and published to the
state branch), the CALM architecture projection and Story architecture intent were removed. Their
commands, such as `wm build`, `wm status`, `wm migrate-views` and `capability world-model`, refuse by
name with `WMB_REMOVED` and point to the brief; `architecture` refuses with `COMMAND_REMOVED`. Their
settings (every `worldModel` key except `knowledge`, `sourceRoots`, `sharedRoots`, `excludedRoots`,
`stateBranch` and `remote`, the top-level `architectureIntent` block, and phase-level
`worldModel` views) still load: they are dropped, and `sflow doctor` names them once as
`removed-settings`. Delete them from `singularity/workflow.yml` to silence it. Old World Model files
on the state branch stay in Git, unread, and an old Story's pinned grounding is ignored, not
rewritten.

## Troubleshooting

- If a phase prompt has no brief, read the `Knowledge warning:` line from `wm compose` or
  `wm brief`. In a large repository, set `worldModel.sourceRoots` or change files in an area first.
- If the brief cites the wrong part of a monorepo, check the source scope above.
- If an item is wrong, record `sflow wm knowledge correct ITEM --note TEXT` or `reject`, and commit
  `docs/knowledge/confirmations.yml` with the code it describes.
- If a context/query result has `nextCursor`, continue with `--cursor` rather than widening the scope.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain agents-and-routing`, `sflow explain model-independence`, `sflow explain knowledge-and-remote-assets`.
