# Native Copilot efficiency

SFlow skills run inside the host's native conversation. They cannot control that
conversation's cache, model session, billed tokens or context retention. ACP session
reuse affects SFlow-owned provider calls, not ordinary `/sf-*` turns.

## Entry and reuse contract

- Every registered skill is audited; aliases delegate once to their canonical owner.
- Story-bound operations use `singularity-flow session current --for-agent --json`
  once instead of separate pause and session calls. Pause is checked before repository
  discovery, including from a non-Git chat directory. Readiness, work ID, active-agent
  checks, custom work-item roots and exact selected checkout paths remain enforced.
- All seven selectable drafting skills use phase entry, including specialised skills
  in renamed or user-created phases. They reuse recovery, clarification, references
  and the composed prompt rather than looking up the same fields separately.
- `/sf-next` delegates composition to all these entry-capable skills. It still returns
  unrelated prerequisites and human decisions; it does not execute them automatically.
- Read `agentGuide.readOrder` once. Supplied input text is reused; only missing,
  truncated or task-relevant omitted material needs expansion. An approved brief is
  a projection, not the entire specification or a replacement for exact source review.
- Agent packet presentation retains the current platform's exact commands, all
  findings, hashes, confirmation requirements and governed text. Full terminal JSON
  remains available. Other platforms' duplicate command strings are omitted only
  when the current platform has a verified command.
- Same-invocation reuse is not a durable authorization cache. Selection changes,
  mutations, new publication bindings and operation-specific checks still require
  fresh evaluation. Approval consent is never reused.
- Preparation scaffolds or preserves a draft; the native agent must author it before
  checking publication readiness. Template TODOs are work to complete, not a reason
  to stop authoring. Deterministic artifacts remain kernel-owned.
- Independent review reads exact pinned sources and artifacts privately, not summaries.
  Chat shows supported summaries and verified Markdown-preview links, never artifact,
  code or diff bodies. Code reports use observed paths and added/deleted/created line
  counts from existing evidence; unknown or binary counts remain unavailable.
- Human approval requires complete review of the exact linked documents outside chat.
  Same-chat acknowledgement is reusable only with matching non-null `displayBinding`
  and unchanged `reviewBinding`. New chat, changed/null bindings or incomplete material
  require fresh human review. Summaries, opened previews and approval consent are not
  interchangeable; operation-specific consent remains explicit.

## Measuring a complete native Story

From the SFlow source/package directory:

```sh
npm run audit:copilot
npm run audit:copilot -- --details
npm run audit:copilot -- --trace /absolute/path/copilot-trace.json --story-dir /absolute/path/exact-story-directory
```

The default audits every packaged skill but prints only a summary and the ten
largest bodies; `--details` lists every row. The trace form additionally measures an
explicit exported host trace and retained prompt inventory. No filesystem search,
model invocation, Story mutation or raw prompt logging is performed. The trace is
limited to a regular non-symlink file of 16 MiB and 10,000 tool events. Do not include
secrets or full source/document bodies; the analyser only needs metadata:

```json
{
  "schemaVersion": 1,
  "workId": "DEMO-1",
  "workflow": "custom-delivery",
  "phaseOrder": ["intake", "coding", "close"],
  "completedPhases": ["intake", "coding", "close"],
  "lifecycleStatus": "completed",
  "events": [{
    "invocationId": "turn-3",
    "bindingKey": "exact-head:phase:generation:work-id",
    "phase": "coding",
    "command": "singularity-flow phase enter --for-agent --json",
    "responseBytes": 4500,
    "durationMs": 800,
    "freshnessRequired": false,
    "exactReviewMaterial": false
  }]
}
```

For document reads, optionally include `document.displayBinding`, `document.sha256`
and `document.complete: true` only when the entire document was read. Separate chunks
are not duplicate complete reads. These observations do not authorize display reuse.
For usage actually reported by the provider, optionally include
`usage.inputTokens` and `usage.outputTokens` for that event, not repeated cumulative
totals. Missing usage remains **unavailable**, not zero. Do not estimate provider usage
from JSON length.

Completion is reported by the trace, not independently proven by the analyser.
Duplicate candidates need review; fresh bindings and exact review material must not
be removed just to meet a size target. Summed tool durations are not end-to-end latency.

Compare complete runs with the same workflow, task, model, native host version and
test policy. Record repair loops and human waits separately. Report measured tool
calls, packet bytes, document reads, elapsed time and observed provider usage, not a
headline savings percentage inferred from skill text size. The complete Classic
Delivery test exercises the kernel lifecycle and reports entry packet sizes, but it
is a scripted test, **not** a live Copilot efficiency benchmark.

## Scripted measurement — 2026-10-10

The complete Classic Delivery fixture finished intake, implementation, testing and
conformance, including publication, submission, approval and closure. It made 35
CLI calls: 23 journey operations and 12 measurement-only entry inspections.
Response totals include those inspections. These are not native Copilot calls.

| Phase entry | Previous compact form (bytes) | New agent form (bytes) |
| --- | ---: | ---: |
| Intake | 2,387 | 2,586 |
| Implementation | 23,335 | 22,630 |
| Testing | 11,504 | 11,409 |
| Conformance | 13,444 | 13,325 |

The baseline minifies the full entry result, matching the previous agent presentation;
it is not a separate historical-binary run. Both sides use minified JSON, not pretty
terminal JSON versus compact agent JSON. The new guidance adds 199 bytes to the small intake packet;
the larger implementation packet drops 705 bytes. Overall entry-size savings are
modest. The primary change is fewer prescribed lookups: 37 Story-bound skills now
use one pause-aware session entry instead of separate pause and session calls, and
all seven selectable authoring skills reuse phase-entry context. Actual native
Story tool-call, document-read, latency and billed-token savings still require a
complete exported host trace. No model was called by this fixture.

## Live measurement — 2026-10-11

One complete Classic Delivery Story (change an exported value from 1 to 2 and its unit
test) was driven through Copilot CLI 1.0.95 over ACP, model Auto (it chose
`gpt-6-luna`). A fresh clone at `4e81b3fa` with the plugin and direct skills installed in an
isolated `COPILOT_HOME` was used, with all 16 messages in one conversation, typed as a user would:
`/sf-next`, `/sf-session TOK-1`, `/sf-next`, the clarification answers, `/sf-submit`, and so
on. Readiness, Story start and the four approvals were human CLI steps outside the chat.
Usage is Copilot's own per-model-call record (`session.usage_record` in its session log).

| | Session + Intake | Code | Testing | Code checking | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| User messages (= premium requests) | 5 | 3 | 2 | 6 | 16 |
| Model calls | 39 | 29 | 23 | 55 | 146 |
| Input tokens | 1,338,691 | 2,305,218 | 2,944,829 | 10,359,940 | 16,948,678 |
| Tool calls | 36 | 30 | 28 | 51 | 145 |

- 95.9% of input tokens were cache reads, 4.1% cache writes; output was 41,915 tokens
  (18,207 reasoning). Copilot reported 19.2 AI units.
- Cost follows conversation length times model calls, not phase prompt size. The
  composed phase prompts were 8.9–20.4 KB; the first model call (system prompt, skills,
  `/sf-next`) was 15,127 tokens. The context re-sent on each call grew from 15K to
  217K tokens (the window is 272K): the CLI returned 375 KB of JSON over 80 calls, and
  that stays in the conversation. Copilot spilled 17 large results to temporary files
  and read them back 23 times.
- Repair loops: two turns spent 5.0M input tokens (30%) adding a missing self-approval
  disclosure through `appeal repair-plan/run/resume`. The first Code edit added the clause
  tag but not the change, so publication failed its tests and was repaired. Two `/sf-next`
  turns only rendered inputs and named the drafting skill (0.86M tokens, 2 extra premium
  requests). `/sf-phase` declined to submit when asked, which cost one more turn.
- Waits: one model call hung for 15 minutes and the session was resumed
  (`session/load`). The final submit failed with `grounding is not defined`, fixed in
  `06533b54`. Cache writes after those pauses were 160K and 202K tokens, although the
  reported cache TTL was 1,800 s.
- `npm run audit:copilot -- --trace` over the 80 SFlow tool events reported 0 duplicate
  candidates. Its duplicate rule is per turn and covers status lookups only, while
  `phase enter` and `nextsteps` each ran 6 times across turns, and `phase show` ran
  after every publication and submission.

### After the fixes (`26a25df0`, `48bb1185`)

The same Story was run twice more:
- Run 2 used model Auto, which this time chose a different model.
- Run 3 was pinned to `gpt-6-luna`, the model of the first run, for a like-for-like comparison.

Both runs followed the CLI's approval output, "Context boundary: new … /clear, /sf-next": a fresh conversation per phase, entered with `/sf-session`, then the drafting skill and `/sf-submit`.

| Input tokens | First run | Run 3 (same model) | Run 2 (Auto) |
| --- | ---: | ---: | ---: |
| Attach + Intake | 1,338,691 | 1,913,873 | 1,022,841 |
| Code | 2,305,218 | 2,337,994 | 918,310 |
| Testing | 2,944,829 | 1,254,975 | 944,917 |
| Code checking | 10,359,940 | 2,409,731 | 1,487,834 |
| Total | 16,948,678 | 7,916,573 | 4,373,902 |
| Premium requests | 16 | 16 | 15 |
| Largest context per call | 216,524 | 101,394 | 71,925 |

- Code checking passed its draft check first time in both runs: the report arrived with the self-approval disclosures already written. No repair loop ran.
- Correction: the `/sf-session` turn that opened each fresh conversation (120K–173K tokens and one premium request each time) was mostly unnecessary. The Story selection is recorded per checkout, so it survives a new conversation. Only the first conversation after a start lacked it, and a start now records it too. Without those four turns, run 3 would have used 12 premium requests and about 7.4M input tokens, and run 2 about 11 and 3.8M.
- A hand-wired `session-start` hook, which re-asks for the Story in each new conversation under `workItemSelection: prompt`, now hands the selection over while the phase opened by an approval's `new` or `compact` boundary is unprepared.
- The request now leads both what the agent reads first and the composed prompt. Agent entry packets carry a bounded `story` summary right after `workId`. The phase contract opens with a "Requested outcome" line, and the full pinned source still follows.
- Run 3's model needed three corrective messages. It tagged an unapproved clause, published an Agent brief it could not correct without a new generation, and missed the committed test receipt. Model choice moves these numbers as much as the workflow does.
- An agent that extracts chosen fields with `python3` or truncates with `head -c` can miss what it did not extract. Run 2's agent never read `contextBoundary` in an old conversation. It also missed the Story description, which sits deep in the composed context. Field-only hints are not enough on their own; the surface that approves should start the fresh conversation.

## Regression checks

```sh
node --test test/native-copilot-efficiency.test.mjs test/phase-entry.test.mjs test/skill-efficiency.test.mjs test/copilot-pause.test.mjs test/authoring-skills.test.mjs test/classic-delivery-workflow.test.mjs
```

The catalogue audit rejects duplicate authoring context lookups. Tests retain pause,
identity, immutable binding, independent reviewer and human-confirmation boundaries.

The scoped suite passed 224 tests, including the complete scripted Story. The
2303 static checks and VS Code typecheck passed. Additional repository-upgrade
checks exposed three existing failures in `test/upgrade-contract.test.mjs`: stale
World Model classifications, a missing `MODEL_SESSION_INCOMPATIBLE` classification,
and a placeholder-only removed-command route. Their source, tests and discovered
version-sensitive code set are unchanged by this efficiency work; this is not a
claim that the entire repository test suite is green.
