---
name: sflow-home
description: Guide developer requests through explicit governed choices.

---
# Singularity Flow home

<!-- sflow-output-contract: conversational-guidance -->
**Output contract:** Resolve ordinary language through durable Home and Next projections; reads may run immediately, while every mutation requires an explicit governed choice.

Use this skill for ordinary developer questions about current work, starting or continuing work, blockers, next actions, and recovery. For safety, automatic invocation is not mutation consent.

1. With a natural-language request, run `singularity-flow home --json --request "$ARGUMENTS"`. With no request, run `singularity-flow recommend --json` so the first answer contains one grounded recommendation rather than the complete menu.
2. Read `data.home` and `data.conversation`; never use chat memory as workflow state. `data.home.repository` is the resolved repository, and `data.home.currentWork` is the selected work even when grouped under `waiting-on-you` or `waiting-on-others`; do not infer either from `counts.active`. When `data.home.personalization.replyName` exists, open once with `Hello, <replyName>.` Do not derive a name from email, login, the request, or memory. Otherwise omit the greeting.
3. Respond under exactly these headings:
   - **I found** — workspace, resolved repository, current Work ID, phase, freshness, and relevant warning. Never say the repository is unresolved when `data.home.repository` exists, and never say there is no work when `data.home.currentWork` or `data.home.attentionWork` exists.
   - **Next** — the one routed read or proposed governed action, including its `/sf-*` route.
   - **I need from you** — nothing for a read; otherwise the exact selection, argument, or human decision required.
   - **This will change** — say “Nothing” for planning and reads; for a proposed mutation, name its files, lifecycle state, Git refs, publication, or external effects before asking.
4. The six intents are `orient`, `continue`, `start`, `inspect`, `act`, and `recover`. If confidence is `none` or `ambiguous`, render the returned Home actions or conversation choices and use `ask_user`; never guess.
5. Safe reads may run immediately. Never auto-invoke a mixed read/write skill. For `continue`, `start`, or `act`, show the proposal and use `ask_user`. Follow a sibling only after explicit selection:
   - `/sf-recommend` → `../sflow-recommend/SKILL.md`
   - `/sf-resume` → `../sflow-resume/SKILL.md`
   - `/sf-start` → `../sflow-start/SKILL.md`
   - `/sf-phase` → `../sflow-phase/SKILL.md`
   - `/sf-submit` → `../sflow-submit/SKILL.md`
   - `/sf-next` → `../sflow-next/SKILL.md`
6. Decisions, resets, destructive operations, and ceremonies require an explicit `/sf-*` invocation so identity and confirmation guards run.
7. Preserve all CLI refusals, warnings, ordered actions, and recovery commands. After a selected flow completes, run `singularity-flow home` and show the refreshed state.

Home action compatibility remains exact: `home:work.continue`, `home:work.list`, `home:work.return`, `home:work.start.intake`, `home:workspace.switch`, `home:impact.quick`, `home:repository.explore`, and `home:help.explain`. Route each only through its returned `fallback.skill`; do not invent a destination.
