---
name: sflow-home
description: Guide developer requests through explicit governed choices.

---
# Singularity Flow home

<!-- sflow-output-contract: conversational-guidance -->
**Output contract:** Resolve ordinary language through durable Home and Next projections; reads may run immediately, while every mutation requires an explicit governed choice.

Use this skill for ordinary developer questions about current work, starting or continuing work, blockers, next actions, and recovery. For safety, automatic invocation is not mutation consent.

1. With a natural-language request, run `singularity-flow home --json --request "$ARGUMENTS"`. With no request, run `singularity-flow home --json`.
2. Read `data.home` and `data.conversation`. State is reconstructed from durable workspace, repository, and lifecycle records; never rely on chat memory as workflow state.
3. Respond under exactly these headings:
   - **I found** — workspace, repository, Work ID, phase, freshness, and relevant warning.
   - **Next** — the one routed read or proposed governed action, including its `/sf-*` route.
   - **I need from you** — nothing for a read; otherwise the exact selection, argument, or human decision required.
   - **This will change** — say “Nothing” for planning and reads; for a proposed mutation, name its files, lifecycle state, Git refs, publication, or external effects before asking.
4. The six intents are `orient`, `continue`, `start`, `inspect`, `act`, and `recover`. If confidence is `none` or `ambiguous`, render the returned Home actions or conversation choices and use `ask_user`; never guess.
5. A routed read may run immediately using only `singularity-flow status`, `progress`, `nextsteps`, `story return <WORK-ID> --json`, or `doctor`, as appropriate. Do not invoke a mixed read/write skill automatically. For `continue`, `start`, or `act`, show the proposal and use `ask_user`. Follow the sibling skill only after the contributor explicitly selects it:
   - `/sf-resume` → `../sflow-resume/SKILL.md`
   - `/sf-start` → `../sflow-start/SKILL.md`
   - `/sf-phase` → `../sflow-phase/SKILL.md`
   - `/sf-submit` → `../sflow-submit/SKILL.md`
   - `/sf-next` → `../sflow-next/SKILL.md`
6. Approval, rejection, cancellation, resets, destructive operations, and every ceremony require an explicit `/sf-*` invocation. Do not perform them from automatic routing, even after conversational agreement; direct the contributor to the named command so its identity and exact-confirmation contract runs.
7. Preserve all CLI refusals, warnings, ordered actions, and recovery commands. After a selected flow completes, run `singularity-flow home` and show the refreshed state.

Home action compatibility remains exact: `home:work.continue`, `home:work.list`, `home:work.return`, `home:work.start.intake`, `home:workspace.switch`, `home:impact.quick`, `home:repository.explore`, and `home:help.explain`. Route each only through its returned `fallback.skill`; do not invent a destination.
