# Singularity Flow glossary

This page distinguishes the product concepts that appear together during prompt
composition but serve different purposes.

## One word per thing

The product accumulated several words for the same concept. These are the decisions. The **canonical**
word is the one to use in prose, help text, labels and commit messages; the others still appear in
flags, directory names, phase IDs and skill names, where renaming them would break repositories that
already exist.

| Canonical | Also written as | Where the other words legitimately survive |
|---|---|---|
| **Initiative** | Epic | `--epic`, the `epic-*` phase IDs, `sflow-epic-*` skills, `epicBranch`. Same record, at `singularity/initiatives/<ID>/`. There is no separate Epic level — an Initiative decomposes directly into Stories. |
| **Story** | work item | Storage is `singularity/work-items/<ID>/`, and `--work-id` names it. A Story *is* a work item; prefer Story when talking to a person. |
| **Workflow** | work type, profile, template | `--work-type` selects which workflow applies. "Profile" means a named workflow in `singularity/workflow.yml`; "template" means an artifact template and is a different thing entirely — do not use it for a workflow. |
| **Phase sequence** | rail, phase graph | "Rail" is the visual presentation of a phase sequence, not a separate concept. |
| **Next step** | next action, what's next, continuation | The narration plane calls this `next`. One label: **Next**. |
| **Flow Gate** | governance gate, phase gate, readiness gate | `gate` fields, gate IDs and refusal codes. In a sentence about one phase, plain "gate" is enough: "two gates are still open". |
| **Flow Ledger** | capability ledger, governance ledger, state branch | The orphan `state` / `sflow/state` branch and the `ledger` command family. |
| **Flow Policy** | governance policy, governance rules, rules | `singularity/workflow.yml`, `approvalAuthorities`, the `constitution` files and their keys. The **Constitution** keeps its name: it is the part of the Flow Policy people write as prose. |
| **Approval group** | approval authority, authority group | The `approvalAuthorities` key and `--authority` style flags. The people in it give a **sign-off**; the button that records one says **Approve…**. |
| **Agent** | governed agent | `.github/agents/*.agent.md` and the `agents` commands. Write **Flow agent** only where other Copilot agents appear beside it. |
| **Land as a Story** | governed landing | `singularity-flow land` and the `adhoc` command family. |
| **Ad hoc work** | ungoverned work, ad-hoc mode | The `adhoc` command family. The alternative is a **Story**, not a mode: the product already has Auto mode, model mode and Copilot mode. |
| **Evidence**, **receipt** | governance evidence, governed evidence, delivery receipt | Directory and record names such as `generation-start/` and `submissions/`. No prefix: they are already unambiguous. |

### "Flow" is a prefix for three things

**Flow Gate**, **Flow Ledger** and **Flow Policy** name things the product owns that would otherwise
read as generic Git, CI or configuration words. Nothing else takes the prefix: not the work itself
(it is a Story or an Initiative, and starting one is **Start new work**), not people, and not a
mode. "Flow state" is not a term. **Flow Impact**, the impact-study feature, keeps the name it
already had.

### "Governed" is retired from what people read

Everything in Singularity Flow is governed, so the adjective tells the reader nothing. Say the
thing instead: a workspace, a repository, a Story ID, a change, an agent. Where two things need
telling apart, name both (**Ad hoc work** and a **Story**). The words survive in machine names:
identifiers, flags, file and branch names, schema fields, skill names and refusal codes, where
renaming would break repositories that already exist. Architecture documents may still use
"governance" for the idea itself when that idea is the subject.

## Core concepts

| Term | Meaning | Stored in | Authoritative for |
|---|---|---|---|
| Workspace | A machine-local directory and selection of capabilities/repositories | Global CLI registry and workspace manifest | Which local clones and repository are active |
| Capability | A stable description of what the organisation builds; capabilities may group other capabilities or be delivered by repositories | Lead repository `singularity/capabilities.yml` | Organisational ownership, policy inheritance, repository/Jira routing |
| Work item / Story | One repository-scoped delivery unit, normally identified by a Jira key or supplied Work ID | `singularity/work-items/<ID>/` on its lifecycle branch | Story phase, artifacts, events, approvals, and progress |
| Initiative / Epic | A cross-repository planning unit that may create many Stories | `singularity/initiatives/<ID>/` on its lifecycle branch | Epic outputs, evidence, Story breakdown, contracts, and aggregate progress |
| Workflow | The ordered phase graph and Flow Policy applied to a work type | `singularity/workflow.yml`; resolved snapshot in active state | Phase order, templates, inputs, Flow Gates, checks, and sign-off requirements |
| Phase contract | The instructions and deterministic requirements for one workflow phase | Workflow definition, templates, and generated phase context | What the phase must read, produce, check, and submit |
| Artifact template | The configurable Markdown structure for a generated deliverable | `singularity/templates/` | Required headings and managed output shape |
| Agent (Flow agent) | A software execution contract for Copilot: purpose, instructions, tools, and phases | `.github/agents/*.agent.md` | How Copilot approaches the active phase |
| Human identity | The real contributor or approver | Git identity, GitHub login, and configured approval groups | Attribution and who may sign off |
| Skill | A user-invoked Copilot playbook such as `/sf-submit`; it calls deterministic CLI commands and explains what Copilot may author | Installed plugin/personal skill directory; optional repository skills | How a named Copilot interaction is carried out |
| Prompt | A reusable Markdown instruction fragment | `singularity/prompts/` or repository configuration | Additional authoring rules supplied to composition |
| Prompt pack | A named, ordered bundle of prompts/skills/templates for a particular way of working | Repository configuration or a trust-pinned remote Agent Markdown declaration | Which reusable instruction set is assembled together |
| World model | The Repository brief: short, cited facts about the code a Story touches (rules, contracts, flows, what the change touches, risky places), read from the committed source with no build and no model | Composed into each phase prompt; `singularity-flow wm brief --phase PHASE` shows it | Repository facts used to ground impact, design, implementation, and verification; guidance, never a gate |
| Phase input | An approved artifact from an earlier phase injected into a later phase | Phase definition and per-generation `context/inputs-*.json` | Traceable upstream decisions supplied to generation |
| Approval group | A configured group of real identities permitted to sign off | `approvalAuthorities` in workflow/portfolio configuration | Whether an approval decision is valid |
| Flow Gate | A check a phase must pass before it moves on: a deterministic check (tests, evidence, coverage, publication) or a sign-off by an approval group | The workflow definition, evaluated by the engine at each transition | Whether a transition may happen |
| Flow Policy | The rules a Story is held to: its workflow, Flow Gates, sign-off requirements and Constitution, as approved on the configuration branch and pinned when the Story starts | `singularity/workflow.yml`, `approvalAuthorities`, `constitution` on `sflow/config` | What a Story is judged against |
| Flow Ledger | Optional append-only proof/mirror of high-value lifecycle events on an orphan `state` branch | Orphan Git branch | Audit proof and reconciliation, never active operational state |
| Generation | One numbered attempt at a phase. Rejecting a phase and reworking it produces generation 2, and so on; artifacts, telemetry and review packets are all recorded per generation | `phases.<id>.generation` in the work item, and `-gen<N>` suffixes on stored records | Which attempt an artifact, approval or telemetry record belongs to |
| Generation-start receipt | Immutable local proof of the source/tree and change-set boundary established before code authoring; it is not a lifecycle event | `singularity/work-items/<ID>/context/generation-start/` | Which exact authoring boundary a later artifact publication consumed |
| Closed vocabulary | Immutable registry that owns finite first-party symbolic members such as lifecycle event types | `src/vocabularies/` and its generated manifest | Whether a producer may create authority using a symbolic member |
| Publication | The atomic unit of a change: take the subject lock, run preflight, write state, commit, push, append to the Flow Ledger. Either all of it happens or none of it does | `src/publication-unit-of-work.mjs` | Whether a lifecycle transition actually took effect |
| Configuration branch | The orphan `sflow/config` branch holding the approved configuration and Flow Policy, with no shared history with any code branch. A Story pins its hashes at start, so later edits stop it rather than silently change it | Orphan Git branch | What configuration a Story is judged against |
| Grounding | The repository context a phase prompt carries: the Repository brief. It is guidance and never blocks; `worldModel.knowledge.prompt: off` leaves it out everywhere, and a work type's `intelligence.worldModel: off` for that work type | `worldModel.knowledge`, `intelligence.worldModel` | Whether repository facts are included |
| Pinned resolution | The snapshot of configuration hashes a Story takes when it starts | `resolution` in the work item | Why an old Story is unaffected by today's configuration edit |
| Review packet | The hashed record of exactly what a reviewer was shown when they approved | `singularity/work-items/<ID>/submissions/` | That an approval refers to specific bytes, not to a moving artifact |

## How the concepts combine

When a phase runs, Singularity Flow composes context in this order:

```text
phase contract and artifact template
+ agent instructions
+ configured prompt pack fragments
+ the Repository brief for the phase
+ approved upstream phase inputs
+ locked remote Markdown dependencies, if configured
+ verification/conformance evidence, when applicable
```

The skill initiates this process. The Node.js CLI resolves and verifies the
inputs. Copilot authors content. The CLI validates, commits, and pushes the
result. A human identity—not the agent—submits, approves, or rejects it.

## Frequently confused pairs

### Agent versus human role

An agent is software configuration. A person may use any allowed agent, but that
does not change who the person is or grant approval rights. Approval groups match
the person's recorded identity.

### Skill versus agent

A skill is the command-oriented playbook the user invokes. An agent is the
phase-specific execution contract injected into the authored prompt. For example,
`/sf-submit` is a skill; `implementation.agent.md` can be the active agent.

A skill in the **skill master** is different: a named set of instructions kept once in
`singularity/skill-library/<id>/SKILL.md`. Any number of agents attach it, for some of their
steps: in their own `## Attached skills` table, or for any agent (a seeded workflow's included)
in `singularity/skill-library/attachments.yml`. In those steps its instructions are part of the
agent's prompt. See `sflow explain skill-master`.

### Workflow build versus workflow

A workflow build is a machine-local workspace for making one workflow: what was found in the
material it started from, the proposals made, and the person's decisions. It is kept on this
computer for 14 days and changes nothing until it is finished. The workflow it makes becomes part
of the configuration only through the usual reviewed proposal. A **proposal** in a build is one
small piece offered by Copilot or a person; only a person accepts it. See
`sflow explain workflow-build`.

### Prompt versus world model

A prompt tells Copilot how to reason or format work. A world model records what is
currently true about the repository. Prompts are designed; the Repository brief is
read from the committed source each time a phase prompt is composed.

### Workspace versus lifecycle branch

A workspace is local convenience and selection state. The lifecycle branch owns
shared operational state. Deleting the local workspace cannot erase the remote
Story or Initiative history.

### Capability map versus Flow Ledger

The capability map describes ownership and relationships. The optional Flow Ledger
records append-only proof events. Neither replaces Story or Initiative
state.
