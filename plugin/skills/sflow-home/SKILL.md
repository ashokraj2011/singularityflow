---
name: sflow-home
description: Guide developer requests through explicit governed choices.

---
# Singularity Flow home

<!-- sflow-output-contract: conversational-guidance -->
**Output contract:** Resolve ordinary language through durable Home and Next projections; reads may run immediately, while every mutation requires an explicit governed choice.

Use this for questions about current work, blockers, next actions, and recovery; automatic invocation is not mutation consent.

1. With a natural-language request, run `singularity-flow home --json --request "$ARGUMENTS"`. With no request, run `singularity-flow recommend --json` so the first answer contains one grounded recommendation rather than the complete menu.
2. Read `data.home` and `data.conversation`; chat memory is not state. Use
   `data.home.repository`, `data.home.currentWork`, and `data.home.personalization.replyName` exactly.
   Never say the repository is unresolved when it exists. Do not derive a name from email, login,
   input, or memory. With no workspace and a `bootstrap`, report it and route
   `home:workspace.switch` to its `/sf-workspace-bootstrap` fallback.
3. Respond under exactly these headings:
   - **I found** — workspace, repository, Work ID, phase, freshness, and warning. Respect `repository`, `currentWork`, and `attentionWork` when present.
   - **Next** — the one routed read or proposed governed action, including its `/sf-*` route.
   - **I need from you** — nothing for a read; otherwise the exact selection, argument, or human decision required.
   - **This will change** — say “Nothing” for planning and reads; for a proposed mutation, name its files, lifecycle state, Git refs, publication, or external effects before asking.
4. Intents are `orient`, `continue`, `start`, `inspect`, `act`, and `recover`. For `none` or `ambiguous` confidence, render returned choices and use `ask_user`; never guess.
5. Safe reads may run immediately. Never auto-invoke a mixed read/write skill. For `continue`, `start`, or `act`, show the proposal and use `ask_user`. Follow a sibling only after explicit selection:
   - `/sf-recommend` → `../sflow-recommend/SKILL.md`
   - `/sf-resume` → `../sflow-resume/SKILL.md`
   - `/sf-start` → `../sflow-start/SKILL.md`
   - `/sf-phase` → `../sflow-phase/SKILL.md`
   - `/sf-submit` → `../sflow-submit/SKILL.md`
   - `/sf-next` → `../sflow-next/SKILL.md`
6. Decisions, resets, destructive operations, and ceremonies require an explicit `/sf-*` invocation so identity and confirmation guards run.
7. Preserve all CLI refusals, warnings, ordered actions, and recovery commands. After a selected flow completes, run `singularity-flow home` and show the refreshed state.

Exact Home actions: `home:work.continue`, `home:work.list`, `home:work.return`,
`home:work.start.intake`, `home:workspace.switch`, `home:impact.quick`,
`home:repository.explore`, `home:help.explain`. Route only through returned `fallback.skill`.
