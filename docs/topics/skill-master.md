---
id: skill-master
title: Skill master and attached skills
aliases:
  - skill-library
  - attached-skills
  - shared-skills
questions:
  - How do I share one skill between several agents?
  - How do I tell an agent to use a skill in a step?
  - Where are the skills my agents attach kept?
commands:
  - skill
related:
  - agents-and-routing
  - importing-assets
  - workflow-authoring
version: 1
---
The skill master is the repository's collection of named skills. A skill is written once and attached to any number of agents. Each attachment says in which steps the agent uses the skill and when. In those steps the skill's instructions are part of the agent's prompt, with an instruction to read each skill and carry it out when it applies.

## Purpose and prerequisites

Use this topic to write a checklist, a house style or a review procedure once and have several agents follow it. For example, the developer can run a security review before it publishes code, and QA can run the same review when it verifies. Run the commands in a governed checkout. The skill master is configuration, so in a repository with an approved configuration authority add `--propose` and review the proposal like any other configuration change.

## What a skill is

A skill is a `SKILL.md` file in the open Agent Skills format, at `singularity/skill-library/<id>/SKILL.md`:

```markdown
---
name: security-review
description: Checks a change for common security mistakes. Use it before code is published.
metadata:
  sflow-label: Security pass
---

1. List every input the change accepts.
2. Check each one for validation and encoding.
3. Report the findings as a checklist.
```

- `name` is the skill's ID, in lower-case kebab-case. It is also the name of the skill's folder.
- `description` says what the skill does and when to use it, in at most 1024 characters.
- `metadata.sflow-label` is an optional display name. Without it, the ID is shown as words.
- The instructions follow the front matter. A skill is at most 256 KiB.

An agent attaches skills in its own `## Attached skills` table:

```markdown
## Attached skills

| Skill | Phases | When to use it |
|---|---|---|
| security-review | implementation | After you write the code, before you publish it |
| house-style | * | - |
```

`Phases` lists the steps the skill applies in; `*` means every step the agent drafts. `When to use it` is one line of at most 300 characters, or `-` for none. In each step a skill applies to, the agent's prompt gains an **Attached skill instructions** section. It holds every such skill: its name, its description, when to use it and its instructions.

These skills are not the compiled skill packages under `singularity/skills/` that skill steps bind. Nor are they the Copilot `/sf-` skills that draft a step.

## Use it from each surface

- **Shell:**
  - `sflow skill list` and `sflow skill show <ID>` show the skills and the agents that use each one.
  - `sflow skill create <ID> --description "<what and when>" --from <FILE>` and `sflow skill edit <ID>` write and change a skill.
  - `sflow skill attach <ID> --agent <AGENT> [--phases a,b] [--use "<when>"]` and `sflow skill detach <ID> --agent <AGENT>` change who uses it.
  - `sflow skill remove <ID>` deletes it.

  Every change accepts `--dry-run` and `--propose`.
- **Copilot:** `/sf-help` followed by the `skill` commands above. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:**
  - **Workflow Studio → Skill master** lists every skill and the agents that use it.
  - **New skill** writes a skill, and **Add from a link** imports one.
  - **Attach to an agent** chooses the agent, its steps and when to use the skill.
  - An agent's card shows its skills and offers **Attach a skill**.

  Each change is part of the Studio's review before it is published.
- **Import:** `sflow import add <LINK> --as skill --sha256 <HASH>` without `--agent` adds a published skill to the skill master. A `SKILL.md` keeps its exact bytes. Plain Markdown needs `--description` and becomes the instructions of a new `SKILL.md`. See `sflow explain importing-assets`.

## Guided workflow

1. Write the skill:

   ```bash
   singularity-flow skill create security-review \
     --description "Checks a change for common security mistakes. Use it before code is published." \
     --from ./security-review.md --propose
   ```

2. Attach it, once for every agent that should use it:

   ```bash
   singularity-flow skill attach security-review --agent developer --phases implementation \
     --use "After you write the code, before you publish it" --propose
   ```

3. Review the proposal. It holds one `SKILL.md` and one new row in each agent's `## Attached skills` table.
4. Check it. `singularity-flow skill show security-review` lists the agents that use the skill, and `singularity-flow workflow validate` checks every attachment.
5. To change the skill, run `singularity-flow skill edit security-review --from ./security-review.md --propose`. Every agent that attaches it uses the new text in Stories started after the change.

## State and safety

- **Stories keep their text.** A Story keeps the exact skill text it started with, under the agent that attaches it, just as it keeps the agent itself.
  - A later edit, detach or removal changes only Stories started after it.
  - A Story still works when the skill master no longer has the skill.
  - The agent context audit records each skill a prompt used, by hash, with a copy of its text.
- **Broken attachments are refused.** Configuration refuses an agent that attaches a skill the skill master does not have (`SKILL_LIBRARY_MISSING`), or names a step that does not exist (`AGENT_PHASE_UNKNOWN`). A broken attachment never reaches a prompt.
- **Removal detaches.** Removing a skill detaches it from every agent in the same change. An agent with no skills left loses its `## Attached skills` section.
- **Export and import.** Workflow export carries the skills the exported agents attach (bundle v5). On import, a same-name skill with different text is a conflict: keep yours, replace it or rename theirs. A renamed skill is renamed in the agents' tables too. See `sflow explain workflow-authoring`.
- **Attaching edits the agent file.** An agent with locked remote resources keeps its lock current. A packaged agent is first copied into the repository.

## Troubleshooting

- **"attaches skill … but it is not in the skill master"**: create or import the skill, or detach it with `singularity-flow skill detach <ID> --agent <AGENT>`.
- **"names skill … but sits in the folder of …"**: the `name` in `SKILL.md` must match its folder.
- **"The skill master already has a skill called …"**: choose another ID, or change the existing skill with `skill edit`.
- **"was written in this repository, not imported"**: an import cannot replace a skill written here; import it under another ID.
- **"this Story's snapshot did not keep it"**: an older version started the Story without keeping the agent's skills. The Story goes on without the skill; start a new Story to use it.

## Related topics

- `sflow explain agents-and-routing`
- `sflow explain importing-assets`
- `sflow explain workflow-authoring`
