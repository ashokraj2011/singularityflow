---
id: workflow-intent
title: Intent-to-workflow creation with catalog-grounded Copilot
aliases: [intent-to-workflow, workflow-designer, workflow-catalog]
questions:
  - How does Copilot discover existing skills and instructions when creating a workflow?
  - Can different teams describe their own workflow instead of writing markup?
commands: [workflow]
related: [workflow-markup, workflow-authoring, reusable-instructions, sgos-governed-execution]
version: 4
---

## Purpose

People describe a process and review its canvas. Copilot selects exact reusable assets and creates
an inert candidate; the native compiler, import review and human approval own its meaning and
activation. This is authoring, not permission to execute the candidate or modify an active Story.

## VS Code

The designer is a two-column workspace: a Markdown writing area with formatting tools and a
read-only preview, and a searchable team library. Add a library item to the separate **Team
knowledge** list instead of inserting machine tags into the description. Description starters are
editable suggestions, not approved intent. Advanced source and file-loading controls stay collapsed.

In Workflow Studio choose **Create with Copilot…**, describe the steps, inputs, decisions, retry
limits and human checkpoints, then choose **Approved repository library** or **SFlow starters**.
The first reads the locally observed approved configuration, not dirty checkout
edits; the second is explicitly starter-only, not a fallback silently selected after an error.

The team library searches names, purposes and tags. **Add** selects a typed library reference in
Team knowledge; it does not execute the skill or change approved configuration. Source
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
handoff. Correctable draft checks stop after the initial attempt plus two corrections, or an
unchanged failure. An internal `WORKFLOW_MARKUP_COMPILER_FAILED` stops corrections immediately:
it is not a request to change the design, select another authority, or spend more model calls.
The credential-screened unchecked candidate is retained in the designer's Advanced options,
without authorizing import. Repair or align the CLI/extension and request a fresh handoff before
checking again. Unscreened transport failures and credential-blocked content are not copied into
the designer's saved source.

When the chat harness cannot expose this tool, the request includes an explicit CLI/file fallback.
Use **Load Copilot draft…** for that saved XML file; an active Story write guard must not be bypassed.
The host rejects a described draft that omits or changes the original intent or uses another catalog source.
Review the phases, routes, structural coverage, reused/derived assets and source mappings before
saving a bundle and entering normal import review. Summaries are not semantic approval.

### Review the checked design

The checked draft opens a full-width, interactive workflow canvas. Select a phase with its card or
the keyboard-accessible phase selector to inspect its task, write scope, input phases, artifact,
approval groups, rejection targets and declared checks. The canvas shows native return routes and
their limits, rather than inferring runtime behavior from prose. Editing the description, source,
selected assets or attachments invalidates the preview; no change is applied to shared workflows.
**Refine this phase with Copilot** appends an explicit change request to the existing description
and prepares a new reviewable chat handoff with the current draft. It does not silently rewrite
the intent, send a model request, approve configuration or activate the proposed changes.

**Inspect resolved guidance** reads only the chosen phase, bound to the exact source and bundle
hashes. Repeated clicks reuse a per-draft cache; late responses from another draft or repository
are discarded. It uses the native skill/instruction composer to show the static agent guidance,
skills, scopes, use conditions and instructions at their procedure steps. Optional skill definitions
are expanded for review, not evidence that runtime will eagerly send them. Story documents, World
Model context, tool availability, permissions and the final generation prompt do not exist yet and
are explicitly excluded. The displayed token figure is an approximate characters/4 estimate, not
measured provider usage. Guidance over 256 KiB is not silently truncated into a purported full prompt.

**Try a route** displays existing engine simulation scenarios: pass, repair, repeated failure,
unavailable evidence and human rejection where applicable. It does not run tests, choose a real
decision, start a Story, or record an approval. Long paths show their displayed/total length.

### Bring guidance from your laptop

Use **Attach files** for Markdown, text, MDC, JSON or YAML, or **Folder…** for an explicitly selected
guidance directory. SFlow recognizes conventional agent, skill and instruction layouts and proposes
types for other guidance. Ambiguous or malformed files remain labelled for review; Copilot must
explain their classification rather than pretending recognition is semantic verification. A type
selector permits an explicit correction, and each available file can be previewed or removed.
The review summarizes object types, flags identical captured content, and lists missing, withheld
or external references. References resolve only against the explicit capture; linked files are never
opened automatically. A missing reference is advisory, not a fabricated dependency or a pass.
The checked preview shows each source-to-object mapping before import.

Only the selected roots are captured. Dependency/build/Git directories, symbolic links, credentials
and oversized or non-text files are excluded or refused. Imported secret-waiver comments do not
authorize disclosure. Limits are 32 selections, 128 captured files, 256 KiB per file and 2 MiB per
designer. No linked URL or missing external file is fetched, and no imported command is executed.

The raw local capture stays in the open designer's memory; raw capture bodies and laptop paths are
not stored in its webview list or saved attachment state. The generated workflow draft is retained
as usual and may contain converted guidance. Native Copilot retrieves the exact selected body with the
authoring tool's `asset` action, `kind: attachment`, and its capture ID. The fallback provides
explicit read-only CLI arguments bound to the capture; changed originals require recapture. Closing
the designer discards the local capture. Reattach originals when resuming a saved draft that still
contains their source mappings.

Copilot proposes namespaced agents, skills, reusable instructions or consuming reference mappings.
An agent that describes a process must be analysed as process data, not flattened blindly into one
agent. Instruction files must be placed in skills at the intended steps; skills must be attached to
the proper agents or phases. Scope conditions such as `applyTo` are not promoted to global policy.
The draft must account for every available attachment by exact ID, content hash, proposed type and
target object. Selected library agents, skills, instructions and workflow contracts cannot silently
disappear from its reuse mapping. The preview shows these mappings for human review; classification
and structural checks are not a claim that a model proved semantic completeness.

The same read-only capture is available with:

```sh
singularity-flow workflow intent attachments --file /path/to/SKILL.md --folder /path/to/team-guidance --json
singularity-flow workflow intent attachments --file /path/to/SKILL.md --expected-source <CAPTURE-SHA256> --id <CAPTURE-ID> --json
```

For exact retrieval, repeat the same selection arguments as the original capture. This creates no
repository configuration, Story generation, approval, source edit or machine-wide instruction.

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

Catalog discovery inspects only declared approved roots and the installed package. Personal/home
directories, parents, application trees and all Git branches are not searched. External guidance
enters only through explicit file/folder attachments above or the reviewed team-import route.
URLs are not fetched. Constitution guidance
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
