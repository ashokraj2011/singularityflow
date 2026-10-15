---
id: workflow-intent
title: Intent-to-workflow creation with catalog-grounded Copilot
aliases: [intent-to-workflow, workflow-designer, workflow-catalog]
questions:
  - How does Copilot discover existing skills and instructions when creating a workflow?
  - Can different teams describe their own workflow instead of writing markup?
commands: [workflow]
related: [workflow-markup, workflow-authoring, reusable-instructions, sgos-governed-execution]
version: 1
---

## Purpose

People describe a process and review its canvas. Copilot selects exact reusable assets and creates
an inert candidate; the native compiler, import review and human approval own its meaning and
activation. This is authoring, not permission to execute the candidate or modify an active Story.

## VS Code

In Workflow Studio choose **Create with Copilot…**, describe the steps, inputs, decisions, retry
limits and human checkpoints, then choose **Approved repository configuration** or **Installed
starters only**. The first reads the locally observed approved configuration, not dirty checkout
edits; the second is explicitly starter-only, not a fallback silently selected after an error.

The expandable catalog searches names, purposes and tags. **Use in intent** inserts a typed
reference such as `[skill:team-angular-tests]`; it does not attach or execute the skill. Source
changes invalidate the checked draft. The prepared Copilot request carries catalog metadata and
exact retrieval instructions, not every skill body. Send the request yourself. Model-off settings
disable that handoff; discovery, loading and compilation remain model-free.

Copilot must preserve the exact original description, identify concrete unknowns, select supported
patterns and map requested behavior to generated nodes. It retrieves selected bodies and their
dependencies, uses namespaced derived agents rather than editing shared ones, and creates new
definitions only for genuine gaps. On compatible native-chat hosts, Copilot uses
`#sflowWorkflowAuthoring` to submit its draft directly to the open designer. This optional tool reads
the exact catalog and checks an in-memory candidate; it cannot edit repository files, execute
arbitrary commands, import a bundle or approve configuration. Its session and revision bind the
current designer. Editing the intent, changing repository or closing the designer invalidates the
handoff. Checks stop after the initial attempt plus two corrections, or an unchanged failure.

When the chat harness cannot expose this tool, the request includes an explicit CLI/file fallback.
Use **Load Copilot draft…** for that saved XML file; an active Story write guard must not be bypassed.
The host rejects a described draft that omits or changes the original intent or uses another catalog source.
Review the phases, routes, structural coverage, reused/derived assets and source mappings before
saving a bundle and entering normal import review. Summaries are not semantic approval.

## Read-only catalog commands

```sh
singularity-flow workflow intent catalog --source approved --kind skill --query angular --json
singularity-flow workflow intent catalog --source installed --kind instruction --json
singularity-flow workflow intent show skill <ID> --source approved --expected-source <CATALOG-SHA256> --json
singularity-flow workflow intent example --source installed --json
```

Catalog filters include `--kind`, `--query`, one exact `--tag`, `--limit` (1..64) and `--cursor`.
Later pages and `show` require the exact `--expected-source` from the preceding catalog. A stale
binding preserves the draft and requires a fresh review; never silently replace its digest.
Names are typed: an agent and skill can share a name without being interchangeable.

Copilot equivalents preserve these arguments, for example `/sf-workflows intent catalog --source
approved --kind skill --query angular --json`. No dedicated `@sflow` command is registered for this
authoring flow. The VS Code catalog and shell operations themselves are model-free. No ACP or MCP
connection is required: the handoff uses native chat, the optional extension tool and the available
terminal tool. Native tool availability does not mean the model has invoked it or verified the intent.

The catalog exposes agents, prompt-library skills, reusable instructions, procedural `command-skill`
definitions, phases, workflows, templates, human authority names, registered constitutions, quality
command declarations, execution task names and MCP policies. Command declarations are not resolved
runners, task names do not qualify providers, and MCP policies do not establish a host connection.
Procedural Copilot skills are invoke-only and cannot be attached as prompt-library skills. Agent
skills expose phase selectors and conditions; skills expose referenced instruction IDs. Definitions
and dependency hashes remain exact. The source binding also covers retained descriptor bytes and
the interpretation implementation; changing them requires a fresh capture. Discovery verifies
neither membership nor host/tool permission. Bodies rejected by credential screening are unavailable
for retrieval.

Only declared approved roots and the installed package are inspected. Personal/home directories,
parents, application trees and all Git branches are not searched. External team directories must
first use the existing reviewed team-import route. URLs are not fetched. Constitution guidance
does not become an ordinary optional skill or an authority override.

## Tags and scope

Skills, reusable instructions and agent front matter may include discovery metadata:

```yaml
metadata:
  sflow-tags: [framework:angular, activity:test, evidence:screenshot]
```

Use at most 32 lower-case tags, each at most 80 characters. Tags help search; they are not policy,
execution conditions, permissions or approval grants. Catalog-generated framework tags are search
hints, not proof that a tool is installed. Skill/instruction edits preserve existing tags.

Version 2 markup can derive a new local agent from a catalog agent, clone a library skill or
instruction with `from`, or attach an existing library skill with `ref`. Derivation preserves the
parent prompt, applicable attached skills, instruction references, use conditions and World Model
view hints. It cannot expand parent tools or silently drop/fetch remote dependencies. Shared
references remain shared for future configuration changes; choose a namespaced `from` copy when
independent customization is wanted. Existing Stories keep their retained snapshots. Workflow-local
attachments keep their use conditions and remapped steps without leaking to other workflows that
use the same phase. Inherited MCP policies intersect the original phase and agent restrictions;
derivation does not grant the repair agent its independent tester's tools.

## Workflow families and capabilities

The navigation vocabulary covers software changes, visual acceptance, research/documents,
read-only reviews, migrations, parallel work, cross-repository programs, events and batches.
Family labels are discovery hints, not executable semantics or evidence of suitability.

The markup route supports the exact phase contract/order of a selected catalog workflow, explicit
branches, human choices, bounded backward routes and human checkpoints. A requested parallel,
foreach, subprocess, event-wait or compensation pattern refuses with a concrete capability finding.
It must not be serialized, omitted or called successful to pass validation. SGOS already declares
richer graph concepts; installed adapters, registry pins, resource contracts and independent
verification still require separate qualification. This authoring feature does not replace SGOS,
Story, repository or configuration authority.

Loop limits are native per-decision round limits, not a shared global repair budget. A request for
one global budget requires an explicit compatible policy; it must not be described as implemented
by unrelated per-decision counters.

For a different phase topology, use the existing workflow canvas or reviewed workflow-authoring
package route, then select that approved workflow contract. Do not fabricate empty implementation
phases for documentation or review workflows, or remove a responsibility without the existing
explicit omission and human applicability policy.

## Validation and next steps

Compilation checks native definitions, startability, dependency closure and route simulation.
Version 2 also checks exact catalog binding, target identities, finite loop declarations and the
original intent's structural coverage. It does not prove semantic completeness, run application
tests, validate credentials or establish production readiness. The original intent, structural
mapping and source bindings are retained in the workflow description, so normal export/import
keeps that authoring trace as prose, not a new executable policy field.

Version 2 CLI compilation returns a summary, not a second full bundle in chat. Use an explicit
`--out <NEW-BUNDLE.json>` when a portable file is wanted; direct API callers still receive the bundle.

Each generated workflow still needs normal destination collision review and authorized approval.
Required tests, source independence, integrity checks and active Story pins remain unchanged.
