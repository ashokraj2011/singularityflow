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
version: 42
---
## Purpose and prerequisites

The World Model is the **Repository brief** that every phase prompt gets: a few cited bullets about
the code the Story touches, read from the committed source with no build and no model call. It
covers the rules that apply (with their messages and HTTP statuses), contracts, flows, what the
Story's change touches, and the risky places. Each bullet ends with its source as a file and line
(a line that cites nothing is left out); what could not be determined is one closing "Not known"
line that names only what this phase's sections lack.

Phase prompts get it in a repository, where it is on by default; `wm knowledge` also reads a
plain Git repository. No build, model or network access is required.

## What a phase receives

The brief is built from repository knowledge (see [the knowledge model guide](../KNOWLEDGE-MODEL.md)),
rule-like statements in README files and `docs/`, and plain-language explanations already accepted
on this machine (labelled as inferred). Items that match the Story's title, description, acceptance
criteria and changed files come first. "What a change touches" is read from the Story's own changed
lines and the files its plan names, not from the last commit. Sections are ordered for the phase's
reader (product owner, architect, developer or tester) and cut to a small per-phase budget of 2 to
4 KB; what did not fit is counted on a pointer line. The prompt receipt records the IDs of the
records the brief included and whether a model phrased them.

A rule a person has confirmed the meaning of (`wm rules confirm`) is shown in that meaning, marked
as confirmed, while the lines it was confirmed against are unchanged.

Knowledge is cached by content on this machine, so every Story worktree reuses it. Above 4,000 code
files a repository is not read whole: a phase builds only the areas the Story changes or names, and a
Story that names no area gets a warning instead of a brief.

## Guided workflow

```bash
singularity-flow wm brief --phase PHASE [--work-id ID]   # exactly what that phase receives; records nothing
singularity-flow wm brief --phase PHASE --polish         # have the model phrase it (model use on), checked
singularity-flow wm show-prompt --phase PHASE            # the whole composed prompt
singularity-flow wm knowledge brief                      # the repository brief for people, with its sources
singularity-flow wm knowledge show business              # the product owner's view
singularity-flow wm rules list                           # each rule, its status, and its drafted or confirmed meaning
singularity-flow wm rules propose                        # draft condition → outcome and intent (advisory)
singularity-flow wm rules confirm RULE-ID                # a person confirms what a rule means
```

- A phase whose prompt cannot be composed yet (its inputs are not approved) shows, with `wm brief`,
  the brief it would carry now and says why.
- `wm brief --polish` sends the model only the lines the brief selected, with what each record says.
  A sentence is kept only when it cites records of one section, and every code name, number, path,
  capitalised name and quoted text in it is in those records; it may not claim what a record says is
  missing ("tested" where no test reaches it) or judge the code. Anything else keeps its fixed
  wording, and a rule's status is always the brief's own. The phrasing is saved on this machine for
  those records and that Story change; a phase prompt reuses it while model use is on and never
  calls a model itself. With model use off the brief is the fixed wording, byte for byte.
- `wm rules propose` drafts each rule's condition, outcome and intent: a model's draft is checked the
  same way, and without a model the draft is the rule's own condition and outcome. Drafts stay on this
  machine and never reach a prompt. `wm rules confirm RULE-ID [--condition TEXT] [--outcome TEXT]
  [--intent TEXT]` records the meaning in `docs/knowledge/rule-meanings.yml`, bound to the lines the
  rule rests on; commit it with the code. When one of those lines changes, the meaning is out of date
  until a person confirms it again. Copilot turns are refused `wm rules confirm` and
  `wm knowledge confirm|correct|reject`: what the code means is a person's word.

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
  records a confirm, correct or reject review. Each phase of the Story lifecycle offers
  **What this phase sees** (`singularityFlow.showPhaseBrief`, also in Work tools → Current work
  actions): the brief that phase's prompt carries, its size against the budget, how it was made,
  and **Phrase with model**.

## State and safety

The brief is guidance. It never blocks, refuses or authorizes anything. If it cannot be built, the
prompt goes out without it and a warning says why. Previewing it with `wm brief` records nothing;
repository knowledge is a content-addressed cache on this machine, and the only committed state is a
person's review in `docs/knowledge/confirmations.yml` and a person's confirmed rule meanings in
`docs/knowledge/rule-meanings.yml`. A model's phrasing or draft is never a record, never blocks and
never approves anything; a missing or failing model leaves the fixed wording.

### Upgrading

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
