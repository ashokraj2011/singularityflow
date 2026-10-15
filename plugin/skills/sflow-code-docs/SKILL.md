---
name: sflow-code-docs
description: Add missing doc comments to the public functions, methods and classes the current code generation changed, without changing code.
disable-model-invocation: true
argument-hint: "[file or declaration focus]"

---
# Document the code this generation changed

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: scoped-repair -->
**Output contract:** Repair only the named local scope; report changes and remaining findings. Never publish, submit, or approve. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. A command's JSON is complete even when long: if your tool saved it to a file, read that file to its end before acting; never treat a saved or long result as truncated or stop because of its size.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Use the Boundary result's `phase`. Run `singularity-flow status --json` and require `phases[<phase>].generationPolicy.task: code`. Otherwise stop and route to `/sf-code`.
2. Run `singularity-flow phase draft-check <phase> --json`. Read `advisories[]` (code `code.documentation.missing`) and `documentation`. If `documentation.status` is `complete` or `not-applicable`, report that and stop.
3. For each advisory, open `path` at `line` and write one doc comment for that declaration in the language's convention: JSDoc/TSDoc above it for JavaScript/TypeScript, a docstring as the first statement of a Python body, Javadoc/KDoc/PHPDoc above it, `///` for C#, Rust and Swift, `// Name …` for Go, `#` lines for Ruby. Say what it does, its parameters and result, its errors, and anything a caller must know. Ground every statement in the code and approved Story evidence; never invent behaviour.
4. Change comments only: no code, signatures, formatting or tests, and no file outside the advisories. `@clause`/`@ac` tags are traceability, not documentation; keep them and add prose beside them.
5. Recheck once with `singularity-flow phase draft-check <phase> --json`, then stop. Advisories never block publication; one that remains is for a human to judge, not a reason to loop.
6. Never publish, submit or approve. Report the files and declarations documented and what remains, then show `Next in Copilot: /sf-code` and `Terminal equivalent: singularity-flow phase prepublish <phase> --json`.
