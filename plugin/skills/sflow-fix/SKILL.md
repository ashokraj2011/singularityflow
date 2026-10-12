---
name: sflow-fix
description: Diagnose a recorded fault and guide an authorized, isolated, scope-bounded repair through deterministic verification.
disable-model-invocation: true

---

# Fix this

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

Use this skill for a `FLT-*` fault or an existing `RPR-*` repair.

1. Read first: `singularity-flow fault show <FAULT-ID> --json` and `singularity-flow fix <FAULT-ID> --diagnose-only --json`.
2. Keep observed facts separate from hypotheses. Diagnostic paths are evidence only and never authorize mutation. If the disposition challenges a requirement, policy, or architecture decision, report `challenge-required` and route to the governed amendment/challenge path; do not claim a challenge exists until that separate ceremony returns its durable record ID.
3. Ask the user to review every bounded path and verifier explicitly. Preview without mutation with structured argv: `singularity-flow fix <FAULT-ID> --plan-only [--allow-path <PATH>]... [--verify-argv '<JSON-ARRAY>']... --json`. Retain `--verify <COMMAND>` only as a compatibility form.
4. Create or join the repair only after showing its effective policy, exact baseline, explicit allowed/prohibited paths, verification set, sandbox limitations, and budgets: `singularity-flow fix <FAULT-ID> [--allow-path <PATH>]... [--verify-argv '<JSON-ARRAY>']... --json`. Record-only, diagnosis-only, needs-human, and challenge-required runs are unresolved and must be joined rather than duplicated.
5. For guided repair, ask the human to authorize the exact plan hash. Only their affirmative answer permits `singularity-flow repair authorize <REPAIR-ID> --confirm <PLAN-SHA256> --open --json`.
6. Produce a patch file without applying it to the developer checkout. Submit it through `singularity-flow repair attempt <REPAIR-ID> --patch <PATCH-FILE> --json`; the kernel validates scope before application and runs the complete pinned verification set. If the result is `retry-ready`, obtain a fresh human confirmation of the unchanged plan hash before another attempt.
7. Render the status, attempt evidence, stop reason, preserved state, and exact next actions. Cancellation requires a supplied reason and preserves the isolated branch/worktree.

Never approve, merge, push, deploy, weaken verification, infer authority from diagnostic paths, widen paths, use shell operators in verification commands, mutate production, or claim success without a `resolved` repair receipt. A macOS or Bubblewrap plan denies network and external writes but permits host reads for runtimes and libraries; authorize only maintainer-reviewed verification commands. `host-not-isolated` means the disposable worktree is the only boundary.
