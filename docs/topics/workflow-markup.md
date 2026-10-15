---
id: workflow-markup
title: Create workflows with Copilot and checked tags
aliases: [tagged-workflow, workflow-tags]
questions:
  - Can I describe branches and loops using tags?
  - How do I turn a tagged description into a workflow bundle?
commands: [workflow]
related: [workflow-intent, workflow-authoring, workflow-decisions, reusable-instructions]
version: 4
---

## What this does

Tagged authoring is a declarative XML subset, not executable HTML. It compiles to the same portable
JSON bundle as Workflow Studio export. The existing importer handles collision choices, exact plan
confirmation, proposals and activation. Compilation never starts a Story, executes tests, approves
a phase, contacts a URL or grants authority.

Version 1 extends one **installed Story starter**. Map every starter phase once, in its existing
order, to a new namespaced phase with an explicitly declared custom agent. Artifact and template
contracts, code permissions, planned claims, approvals and optional inputs remain intact. Arbitrary
graph restructuring, Initiative/SGOS declarations, standalone checkpoint nodes and global cycle
counters are outside this version.

Descriptions may express branches in natural language. Copilot proposes explicit tags; the
deterministic compiler does not guess conditions, thresholds, destinations, groups or limits.

Version 2 is the intent-to-workflow authoring format. It binds an exact approved or installed
catalog, supports asset reuse and preserves structural intent coverage. See
`singularity-flow explain workflow-intent` before drafting. The selected workflow contract still
owns its phase count, order and obligations; a family label never grants new runtime support.

## Version 2 catalog binding and reuse

Get a fully bound, dependency-complete example with `singularity-flow workflow intent example
--source installed --json`. The checked-in `examples/demo-intent-workflow.xml` is its template;
the command fills its digest and source placeholders from the exact captured owner.

The root takes `version="2"`, `catalog="sha256:..."` and `catalog-source="approved"` or `installed`.
`extends` names an exact workflow in that catalog. The compiler rechecks the entire catalog binding
before writing a bundle; a changed source is a fresh-review condition, not a hash to auto-replace.

- `<agent id="NEW-NAMESPACED-ID" from="CATALOG-AGENT-ID" />` derives a new agent with the exact
  parent prompt and applicable skills. An optional description adds workflow-specific guidance;
  optional tools may narrow, not expand, the parent's tools. Remote dependencies require the existing
  reviewed authoring route. Independent testing and code repair cannot derive from the same parent.
- `<skill id="NEW-NAMESPACED-ID" from="CATALOG-SKILL-ID" />` copies the exact procedure and
  instruction references. `<instruction id="NEW-NAMESPACED-ID" from="CATALOG-INSTRUCTION-ID" />`
  copies the exact guidance. Neither takes replacement body text; declare new content deliberately.
- `<skill ref="EXISTING-LIBRARY-SKILL-ID" />` under an agent or phase selects existing retained
  guidance. It is not a procedural `command-skill`. Ordinary bundle dependency closure includes the
  selected instructions; no model needs to copy their bodies. A custom skill can place an existing
  catalog instruction with `<instruction>EXISTING-ID</instruction>`.
- One `<intent family="CATALOG-FAMILY">` contains a `<description>` with the exact original user
  description, one or more `<requirement id="ID" maps-to="phase:ID decision:ID">statement</requirement>`
  rows and explicit empty `<pattern ref="PATTERN-ID" />` elements. Each target must exist. Node
  target prefixes include workflow, phase, agent, skill, instruction and decision. The VS Code
  host compares the original description, not a model rewrite, before offering import.

The mapping is structural only and requires human semantic review. Unsupported patterns report a
capability requirement instead of silently becoming sequential. The existing version 1 syntax and
repository-independent compiler remain supported for explicit manual authoring.

## Use it from each surface

**VS Code:** Workflow Studio → **Create with Copilot…**. Describe the steps, pass/fail routes,
retry limits and human checkpoints in your own words. **Create draft with Copilot…** prefills a
reviewable chat request; send it in Copilot when ready. Copilot reads the installed grammar, asks
only concrete missing questions, creates a new XML draft, validates it, and summarizes its phases,
routes and exact saved path. It does not import or activate anything. The request is not silently sent.

Choose **Load Copilot draft…** and select that saved XML file. SFlow captures only the selected
bounded local file, preserves its exact UTF-8 bytes, and automatically checks the draft and routes.
There is no repository-wide scan or automatic watch. Review the phases, decisions and source-to-node
mappings. The markup editor is collapsed under **Advanced: inspect or edit markup**; no one needs
to write XML to begin. **Check draft & routes** can revalidate manual edits. Plain prose is not
interpreted by the deterministic compiler. Unsupported starter topology must be explained by Copilot,
not silently replaced or represented as if it were supported.

**Save bundle & review import…** rechecks exact source and bundle hashes, then opens the normal
import review. After activation, use the ordinary workflow canvas. Existing Stories retain pins.

**Shell:**

```sh
singularity-flow workflow markup example
singularity-flow workflow markup compile ./workflow.xml --json
singularity-flow workflow markup compile ./workflow.xml --out ./demo.sflow-workflows.json --json
singularity-flow workflow import ./demo.sflow-workflows.json --dry-run --propose --json
```

`compile -` reads private stdin. `--out` creates a **new** file and refuses replacement. Separately
review and confirm the exact destination import plan. Portable-ready means definition, dependency,
startability and native route checks passed—not destination compatibility, application test success,
approval or activation.

**Copilot:** `/sf-workflows markup example` or `/sf-workflows markup compile ./workflow.xml --json`.
There is no dedicated `@sflow` markup command. VS Code Check and shell compilation are model-free;
optional Copilot drafting uses the selected chat model.

## Document shape

Use `examples/demo-tagged-workflow.xml` in the installed package or the example command. The root
requires `version="1"`, `id`, `label`, and `extends="INSTALLED-STARTER-ID"`. New phase, agent, skill
and instruction IDs begin with `<workflow-id>-`. Every declared dependency must be used.

- `<description>` is literal intent. A phase description becomes a **workflow-local guidance skill**
  and reaches that phase's composed prompt without leaking into other workflows.
- `<instruction id="..." description="...">text</instruction>` declares reusable guidance.
- `<skill id="..." description="...">procedure <instruction>ID</instruction></skill>` places a
  reference at its point of use. CDATA can hold literal markup examples.
- `<agent id="..." description="..." tools="read search edit">` contains one `<description>`
  prompt and optional empty `<skill ref="ID" />` attachments. Explicit tools are declarations,
  never executed by compilation. Agent skills follow the custom agent wherever used.
- `<phase id="..." from="STARTER-PHASE" agent="CUSTOM-AGENT">` keeps its starter contract. It
  accepts a description, phase-local skill references, approval, and one decision or loop. Optional
  `next` is only a sequential assertion; nonsequential routes need a decision.
- `<approval authority="quality-reviewers" on-reject="PHASE-ID" />` names an installed **human
  group**, not an agent or the generic word `human`. It does not grant membership or approval.
- `<omit responsibility="implement" reason="..." authority="quality-reviewers" />` explicitly
  declares a responsibility left out at a route or endpoint. The normal human applicability decision
  remains required for each Story; this is not a risk waiver.

Unmentioned starter decisions are retained with remapped targets. A phase's decision or loop
**replaces** its inherited decision. Explicit sequential `next` removes that inherited decision,
subject to native route/obligation checks. No prose “if” silently creates executable behavior.

## Decisions and loops

Place a branch inside the deciding phase:

```xml
<decision id="demo-result" label="What did fresh tests establish?"
          source="verdict" values="pass fail unavailable"
          max-attempts="3" by="quality-reviewers">
  <when id="pass" equals="pass" next="demo-close" />
  <when id="fail" equals="fail" next="demo-repair" />
  <otherwise id="unavailable" next="demo-test" />
</decision>
```

Destinations are exact declared phases, `next`, or `end`. `source` is the recorded decision input
name, not `test.outcome`, a script or a provider assertion. Submission records a value; approval
binds it before the native rule runs. Branches end with one `<otherwise>`. Missing evidence never
becomes a pass. A route that skips implementation also needs the applicable explicit omission;
see the full example.

Backward **rule** routes need `max-attempts` from 1 to 20. Bounds belong to each native decision,
not a global cycle counter. Exhaustion pauses for the decision's human group; the normal reviewed
additional-round policy applies. Human rejection keeps the starter's authorized rework policy.

```xml
<loop id="demo-recheck" label="Repeat until ready"
      source="ready" values="yes no" goal="yes" back="demo-earlier-phase"
      max-attempts="3" by="quality-reviewers" />
```

A loop continues to the next phase when its goal holds, otherwise returns to the named earlier
phase. For Test → Repair → Test in four phases, use branch decisions like the full example:
Test can select later Repair, while Repair has its own bounded return to Test.

```xml
<decision id="demo-human-direction" kind="ask" label="Choose the reviewed route"
          by="quality-reviewers">
  <option id="continue" label="Continue" next="next" />
  <option id="repair" label="Return for repair" next="demo-repair" />
</decision>
```

An ask is a human choice, not an automatic loop. Membership and exact question binding stay kernel
enforced. Approvals, fresh evidence, independent review and integrity checks are unchanged.

## Validation and preservation

Unknown tags/attributes, duplicates, unmatched tags, unsupported conditions and unresolved
references fail with source lines. Quoted attributes, XML comments, CDATA and predefined/numeric
Unicode entities are supported. DTDs, external entities, processing instructions, executable tags,
includes and expressions are refused. Limits: 256 KiB, 2,048 nodes, depth 16. Credential-shaped
content is refused.

Only an isolated disposable tree is written during compilation. The normal loader, startability
checker, route simulator and **existing bundle compiler** validate the result. Scratch trees are
removed on success and failure. Source files, repository configuration and Stories remain unchanged.
The bundle carries referenced agents, skills, instructions and templates with normal digests.
The result binds source SHA-256 and spans for explicit nodes/routes. Inherited contracts remain
owned by the installed starter; they are not attributed to prose the user never wrote.
The source hash includes its original BOM and line endings. Generated text assets use LF consistently,
so Windows CRLF input cannot produce mixed-line-ending portable assets.
