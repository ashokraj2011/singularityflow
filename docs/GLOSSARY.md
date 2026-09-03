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

## Core concepts

| Term | Meaning | Stored in | Authoritative for |
|---|---|---|---|
| Workspace | A machine-local directory and selection of governed capabilities/repositories | Global CLI registry and workspace manifest | Which local clones and repository are active |
| Capability | A stable description of what the organisation builds; capabilities may group other capabilities or be delivered by repositories | Lead repository `singularity/capabilities.yml` | Organisational ownership, policy inheritance, repository/Jira routing |
| Work item / Story | One repository-scoped delivery unit, normally identified by a Jira key or supplied Work ID | `singularity/work-items/<ID>/` on its lifecycle branch | Story phase, artifacts, events, approvals, and progress |
| Initiative / Epic | A cross-repository planning and governance unit that may create many Stories | `singularity/initiatives/<ID>/` on its lifecycle branch | Epic outputs, evidence, Story breakdown, contracts, and aggregate progress |
| Workflow | The ordered phase graph and policies applied to a work type | `singularity/workflow.yml`; resolved snapshot in active state | Phase order, templates, inputs, gates, checks, and approval requirements |
| Phase contract | The instructions and deterministic requirements for one workflow phase | Workflow definition, templates, and generated phase context | What the phase must read, produce, check, and submit |
| Artifact template | The configurable Markdown structure for a generated deliverable | `singularity/templates/` | Required headings and managed output shape |
| Governed agent | A software execution contract for Copilot: purpose, instructions, tools, phases, and world-model views | `.github/agents/*.agent.md` | How Copilot approaches the active phase |
| Human identity | The real contributor or approver | Git identity, GitHub login, and configured authority groups | Attribution and approval authority |
| Skill | A user-invoked Copilot playbook such as `/sf-submit`; it calls deterministic CLI commands and explains what Copilot may author | Installed plugin/personal skill directory; optional repository skills | How a named Copilot interaction is carried out |
| Prompt | A reusable Markdown instruction fragment | `singularity/prompts/` or repository configuration | Additional authoring rules supplied to composition |
| Prompt pack | A named, ordered bundle of prompts/skills/templates for a particular way of working | Repository configuration or a trust-pinned remote Agent Markdown declaration | Which reusable instruction set is assembled together |
| World model | A generated, hash-bound description of the current repository | `singularity/world-model/` | Repository facts used to ground impact, design, implementation, and verification |
| Phase input | An approved artifact from an earlier phase injected into a later phase | Phase definition and per-generation `context/inputs-*.json` | Traceable upstream decisions supplied to generation |
| Approval authority | A configured group of real identities permitted to approve | `approvalAuthorities` in workflow/portfolio configuration | Whether an approval decision is valid |
| Capability ledger | Optional append-only proof/mirror of high-value lifecycle events on an orphan `state` branch | Orphan Git branch | Audit proof and reconciliation, never active operational state |
| Generation | One numbered attempt at a phase. Rejecting a phase and reworking it produces generation 2, and so on; artifacts, telemetry and review packets are all recorded per generation | `phases.<id>.generation` in the work item, and `-gen<N>` suffixes on stored records | Which attempt an artifact, approval or telemetry record belongs to |
| Generation-start receipt | Immutable local proof of the source/tree and change-set boundary established before code authoring; it is not a lifecycle event | `singularity/work-items/<ID>/context/generation-start/` | Which exact authoring boundary a later artifact publication consumed |
| Closed vocabulary | Immutable registry that owns finite first-party symbolic members such as lifecycle event types | `src/vocabularies/` and its generated manifest | Whether a producer may create authority using a symbolic member |
| Publication | The atomic unit of a governed change: take the subject lock, run preflight, write state, commit, push, append to the ledger. Either all of it happens or none of it does | `src/publication-unit-of-work.mjs` | Whether a lifecycle transition actually took effect |
| Configuration branch | The orphan `sflow/config` branch holding governed configuration, with no shared history with any code branch. A Story pins its hashes at start, so later edits stop it rather than silently change it | Orphan Git branch | What configuration a Story is judged against |
| Grounding | How a phase handles World-Model context: `off` omits it, `warn` reports integrity findings, and `enforce` strictly verifies any context consumed. Unavailability itself is non-blocking | `worldModel.grounding` | Whether repository facts are included and how their provenance is verified |
| Pinned resolution | The snapshot of configuration hashes a Story takes when it starts | `resolution` in the work item | Why an old Story is unaffected by today's configuration edit |
| Review packet | The hashed record of exactly what a reviewer was shown when they approved | `singularity/work-items/<ID>/submissions/` | That an approval refers to specific bytes, not to a moving artifact |

## How the concepts combine

When a phase runs, Singularity Flow composes context in this order:

```text
phase contract and artifact template
+ governed agent instructions
+ configured prompt pack fragments
+ required repository world-model views
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

### Prompt versus world model

A prompt tells Copilot how to reason or format work. A world model records what is
currently true about the repository. Prompts are designed; world-model views are
generated from source and checked for staleness.

### Workspace versus lifecycle branch

A workspace is local convenience and selection state. The lifecycle branch owns
shared operational state. Deleting the local workspace cannot erase the remote
Story or Initiative history.

### Capability map versus capability ledger

The capability map describes ownership and relationships. The optional capability
ledger records append-only proof events. Neither replaces Story or Initiative
state.
