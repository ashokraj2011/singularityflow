---
name: sflow-grounding
description: Background grounding rules the workflow agent loads before phase reasoning or repository questions after a Story is attached.
disable-model-invocation: true
user-invocable: false
---
# Singularity Flow grounding

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.


Before phase reasoning, identify the work or Epic ID, phase, governed agent, real Git identity and exact
objective. Use the canonical skill's composed prompt and stay within the phase write scope. Its composition order is authoritative:

1. active phase contract and artifact template;
2. selected governed-agent prompt;
3. mandatory phase world-model views;
4. additional governed-agent world-model views;
5. rule-selected repository domains and task guides;
6. locked agent Markdown;
7. approved upstream input projections (the complete artifact or an approval-bound agent brief) and evidence.

For repository questions after attachment, first request `context.brief` (or
`singularity-flow session context --work-id <ID> --slice brief --json`); expand only the one
`world-model`, `ast` or `evidence` slice needed, keeping source revision and byte/token accounting.
Label facts, approved decisions, assumptions, proposals and open questions.

If a required view is missing, stale or unreachable, keep Flow's unavailable context and use ordinary
repository access.
Show the exact mutation command emitted by Flow and wait for explicit contributor authorization before optional `singularity-flow wm ensure ...`, disclosing its source, depth, provider and
publication target; phase work continues meanwhile. Context-integrity errors block. Never infer `--task` from a Story objective.

An approved agent brief serves ordinary reasoning; expand a source section by its `sfref:v1:` handle only
for exact wording, and the complete artifact still governs. Fill an artifact's `## Agent brief` with a
compact, evidence-based handoff (the kernel binds the downstream copy); never write a replacement brief in chat.

Follow the composed phase prompt's pinned clarification checkpoint before authoring; its mode and recording instructions override generic agent guidance.

When the composed prompt includes compatible structural facts, use the model-free `wm.ast.query` gateway
read before broad search for symbols, imports, or relationships. Request at most 50 facts and 32 KiB
initially; follow `nextCursor` only while needed. If structural context is absent, unsupported, text-only,
or unavailable, use ordinary repository access without retrying AST.
A lexical `text` symbol is advisory discovery evidence, not proof of a declaration; syntax or semantic claims require the named extractor and its assurance.

On `Out of sequence`, stop and relay its full state, reason and required next command. Show a complete
`Soft sequence warning` and let the human decide in the terminal; never type `continue`, set confirmation
variables or self-confirm. Never edit workflow state, metadata, status or approval files to bypass a gate.
