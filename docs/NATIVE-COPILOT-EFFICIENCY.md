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
- Independent review receives exact pinned sources and artifacts, not summaries.
  Document display reuse requires the identical non-null display binding and complete
  visible same-chat content. A new chat, changed binding or truncation needs full display.

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
