# Skill efficiency and context hygiene

Singularity Flow separates deterministic lifecycle control from probabilistic
authoring. The Node CLI owns state, validation, Git publication, and reports;
Copilot skills provide the human interaction and generation layer.

## Catalog policy

`plugin/skills/registry.yml` is the authoritative inventory for public skills.
Every skill has:

- a behavioral class;
- an output contract;
- a 500-estimated-token warning threshold;
- an 800-estimated-token hard ceiling.

Only the registry's eleven read-only documentation, diagnostics, Home, status,
progress, receipt, and recommendation skills may be selected automatically from
natural-language requests. Every other skill sets `disable-model-invocation:
true` and remains directly available through its `/sf-*` or `/sflow-*` command.
That frontmatter prevents automatic skill selection; it does not mean that a
Copilot skill runs without its host model.

Every skill also carries a generated execution boundary. Relative paths resolve
from the root reported by Flow, Story artifacts remain under
`singularity/work-items/<WORK-ID>/`, and filesystem-wide discovery is forbidden.
The same boundary declares the kernel-model policy: deterministic CLI work uses
`--no-model`; only explicitly classified conditional skills may name a
model-capable operation, and those require contributor consent.

Run the deterministic audit locally or in CI:

```bash
npm run audit:skills
```

Use `npm run audit:skills:write` only when intentionally reapplying registry
frontmatter, descriptions, and output-contract markers. Review the resulting
skill diffs before committing.

## Skill classes

| Class | Purpose | Output contract |
|---|---|---|
| conversational | Help, status, and next-action guidance | Read-only evidence and ordered actions |
| echo | Reports and diagnostics | CLI output verbatim; no re-narration |
| interactive | Explicit human selection | Never infer or preselect |
| review | Approval and rejection | Show exact artifacts, hashes, identity, and confirmation |
| generative | Requirements, design, implementation, and verification | Clarify, compose governed context, author, then publish |
| mutation | Deterministic lifecycle changes | CLI validates and mutates; skill relays the exact result |

The output and execution contracts are visible near the top of every `SKILL.md`. They prevent a
small relay skill from expanding a deterministic CLI result into another long
model-written report, while preserving the fuller contracts required for
generation, selection, and approval.

## Utility work versus generation

Use the bundled `sflow-utility` agent for read-only status, progress, next steps,
inbox, reports, logs, and doctor-style requests. It has no editing tool and stops
when a request would mutate lifecycle state. Copilot model selection is
session-level, so organizations may run that agent in a session configured with
an approved lower-cost model.

Do not route requirements, design, coding, verification, comparison, or approval
reasoning to the utility agent. Those operations use the phase's governed agent,
artifact template, approved inputs, and repository world model.

When no conversational interpretation is needed, call the CLI directly from a
terminal or VS Code action. A deterministic command such as `sflow status --json`
does not benefit from an extra model turn.

## Phase context boundaries

The plugin no longer injects a `sessionStart` model prompt. Its remaining
`subagentStart` command hook maps an exact native Copilot agent name to governed
Flow context without blocking tools.

After an approved phase, follow the pinned `contextPolicy` printed by the CLI:

- `new`: run `/clear`, then `/sf-next`;
- `compact`: run `/compact`, then `/sf-next`;
- `keep`: continue in the current conversation.

The next phase reconstructs context from committed artifacts, approved inputs,
the selected governed agent, templates, locked remote Markdown, and required
world-model views. Conversation history is therefore a convenience, not a state
transfer mechanism. For long planning turns, compact immediately before the
generation step after clarifications have been recorded in governed context.

## Measuring impact

`npm run audit:skills` reports estimated body tokens for comparison over time.
This estimate uses characters divided by four; it is a catalog budget, not a
provider billing value. Use Copilot's metadata-only OpenTelemetry export and the
committed phase telemetry records for actual provider/model/token measurements.

Compare representative workflows before and after a change using the same model,
repository state, work type, and task. Track:

- input, cached-input, output, and total tokens;
- model and provider;
- phase duration and clarification count;
- artifact quality, rework, and rejected generations.

Token reduction is not accepted when it removes clarification, artifact display,
approval confirmation, identity warnings, or publication safety.
