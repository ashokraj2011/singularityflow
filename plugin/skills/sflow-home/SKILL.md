---
name: sflow-home
description: Guide developer requests through explicit governed choices.

---
# Singularity Flow home

<!-- sflow-output-contract: conversational-guidance -->
**Output contract:** Resolve ordinary language through durable Home and Next projections; reads may run immediately, while every mutation requires an explicit governed choice.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

Use this for questions about current work, blockers, next actions, and recovery; automatic invocation is not mutation consent.

1. With a request, run `singularity-flow home --json --request "$ARGUMENTS"`; otherwise run `singularity-flow recommend --json` for one grounded recommendation.
2. Read `data.home` and `data.conversation`; chat memory is not state. Use `data.home.repository`,
   `data.home.currentWork`, and `data.home.personalization.replyName` exactly. Never say the repository is unresolved when it exists. Do not derive a name from email, login, input, or memory.
   Report `bootstrap` when no workspace exists and route `home:workspace.switch` through its fallback.
   Render projected `today`/`yesterday` as **Today**/**Yesterday — where you stopped**, with the exact
   “Stored locally · Never pushed” label. Never reconstruct a day or equate missing events with no work.
3. Respond under exactly these headings:
   - **I found** — workspace, repository, Work ID, phase, freshness, warning; respect `repository`, `currentWork`, and `attentionWork`.
   - **Next** — the one routed read or proposed governed action, including its `/sf-*` route.
   - **I need from you** — nothing for a read; otherwise the exact required input or decision.
   - **This will change** — “Nothing” for reads; otherwise name file, lifecycle, Git, publication, and external effects.
4. Intents are `orient`, `continue`, `start`, `inspect`, `act`, `recover`, and `help`. Help relays cited packaged documentation and never executes a displayed command. For `none` or `ambiguous` confidence, render returned choices and use `ask_user`; never guess.
5. Safe reads may run immediately. For `continue`, `start`, or `act`, show the proposal and use `ask_user`. Follow only the selected direct route: `/sf-recommend`, `/sf-resume`, `/sf-start`, `/sf-phase`, `/sf-submit`, or `/sf-next`.
6. Decisions, resets, destructive operations, and ceremonies require an explicit `/sf-*` invocation.
7. Preserve all CLI refusals, warnings, ordered actions, and recovery commands. After a selected flow completes, run `singularity-flow home` and show the refreshed state.
8. “Catch me up”, “where did I stop?”, “yesterday”, and “what changed while I was away?” are reads.
   Route `/sf-work-interval` with the current Work ID; never answer from the prior Copilot turn.

Exact Home actions: `home:work.continue`, `home:work.list`, `home:work.return`,
`home:work.start.intake`, `home:workspace.switch`, `home:impact.quick`,
`home:repository.explore`, `home:help.explain`. Route only through returned `fallback.skill`.
