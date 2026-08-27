---
name: sflow-advise
description: Guide unclear SFlow situations with grounded safe choices.
argument-hint: "[QUESTION | ERROR | WHAT SHOULD I DO?]"
---

# Advise me when I am unsure

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

Use this when the developer is confused, stuck, or does not know which SFlow route applies.

1. Resolve the current session first. Chat history is not lifecycle evidence; never search outside the selected workspace.
2. With a question or error, run `singularity-flow home --json --request "$ARGUMENTS"`. With no argument, run `singularity-flow recommend --json`.
3. If the result is ambiguous or has no confident route, preserve every returned choice and ask the developer to select one. Never choose on their behalf.
4. When the question is about product behavior rather than current state, run `singularity-flow explain "$ARGUMENTS" --here --json` and cite the returned packaged topic. Do not answer product behavior from memory.
5. For an unexplained active-Story blocker, run `singularity-flow nextsteps <WORK-ID> --json`. Run `singularity-flow doctor <WORK-ID>` only when guidance calls for repository diagnosis.
6. Present:
   - **What I found** — workspace, repository, Work ID, phase, and exact blocker or uncertainty.
   - **Why** — the evidence, refusal code, or cited rule that caused it.
   - **Safest next step** — one action, why it is preferred, and its `/sf-*` route.
   - **Other choices** — only genuine alternatives returned by SFlow.
   - **What changes** — always “Nothing yet” for this advisory skill.
7. Preserve warnings, unavailable reasons, revisions, and confirmations. Do not retry failures.
8. Never generate, submit, approve, reject, recover, reset, commit, push, or execute a suggestion. The developer must separately invoke its `/sf-*` skill.
