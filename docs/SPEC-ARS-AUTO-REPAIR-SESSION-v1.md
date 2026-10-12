# Singularity Flow Auto Repair Session

**Specification ID:** `ARS-v1`

**Status:** Proposed

**Version:** `0.1.0-draft`

**Date:** 2026-10-12

**Related work:** model sessions (`createModelSession`, `src/model-runner.mjs`, 5cba8ce1), Auto
repair policy (`auto-on-machine-actionable`, `src/auto/auto-policy.mjs`), Auto phase contracts and
Context Manifests (`src/auto/auto-phase-contract.mjs`), the Copilot ACP adapter
(`src/model-providers/copilot-cli.mjs`), [Native Copilot efficiency](NATIVE-COPILOT-EFFICIENCY.md)

## 1. Executive decision

When a ratified Auto flight's authoring attempt completes its model call, is refused by
Candidate verification for a machine-actionable reason, and its plan authorizes one automatic
repair, the repair may run as the **second turn of the same Copilot ACP session**. That turn
sends a short, governed **repair-turn prompt** instead of the full phase prompt again, and is
admitted, audited and checked exactly like every other Auto prompt.

This saves real money only when the provider still holds the first turn in its cache. It is
therefore guarded by time and size gates, it falls back to today's fresh repair whenever a
gate fails, and the saving must be measured before the behaviour is enabled by default.

What it does **not** do: it does not reduce premium requests (one per prompt either way), it
does not make a failed model call retryable in session, and it does not reach confirmed
repairs, which run in later CLI processes.

## 2. Why this specification exists

A review proposed passing `createModelSession()` into the Auto loop so "each failed attempt or
test-driven repair" stops paying Copilot's ~11,400-token system prompt, "saving tens of
thousands of tokens per Story run". Verified against main 3737c24d:

| Claim | Finding |
|---|---|
| `createModelSession` exists and Auto does not pass a session | True: `model-runner.mjs:510`; `auto-executor.mjs:1305` |
| Each repair starts a new Copilot process | True for the automatic repair, which recurses in-process (`auto-executor.mjs:1813`) and calls the model again without a session |
| Each failed attempt could reuse a session | False: a failed prompt closes its session (`model-runner.mjs:507`) |
| Tens of thousands of tokens saved per Story | Not as stated: a session turns the 11,400 tokens into a cache read, it does not remove them, and the second turn also carries the whole first turn. Auto allows at most one automatic repair per refusal (`auto-policy.mjs`: exactly one repair attempt, two model invocations) |
| Passing `session` is enough | No: re-sending the full phase prompt in session grows the context. The saving needs a short repair turn, and a short repair turn needs a governed admission, because Auto refuses any transported prompt that differs from the admitted phase prompt (`auto-executor.mjs:1331-1346`) |

## 3. Current state

1. `executeAutoFlightStepLocked` composes the phase prompt, renders the Auto authoring prompt
   (`renderAutoAuthoringPrompt`), builds a phase contract whose Context Manifest admits the
   prompt's digest (`phase-prompt`, `exact-model-prompt`), and calls `invokeModel` with no
   session.
2. After the call, the executor refuses unless the transported prompt digest equals the admitted
   `phase-prompt` digest (`AUTO_CONTEXT_MANIFEST_MISMATCH`).
3. Candidate verification can refuse. With `auto-on-machine-actionable`, `planAutoRepair` builds a
   Repair Plan from the refusal (objective, read and write scope, required evidence, one
   attempt), `authorizeAutomaticAutoRepair` authorizes it, and the executor recurses into a new
   attempt in the same process.
4. The repair attempt recomposes the full phase prompt, appends the repair lines, narrows the
   task contract's read and write scope to the Repair Plan's, and starts a new Copilot process.
5. Model sessions exist (`createModelSession`, `invokeModel({ session })`): prompts in one session
   must share provider, model, model settings, folder, allowed roots and tool names; the audit
   records `session: { id, turn }`; a failure closes the session; only the ACP transport has
   sessions. Path scope is decided per turn through ACP `request_permission`
   (`copilot-cli.mjs:351`), so a later turn can narrow it.

## 4. Measured facts this design depends on

- Copilot CLI adds about 11,400 input tokens of its own instructions to every new session; a
  repeat in a new session read nothing from cache (2026-10-09, paid probe).
- In one session, turn 2 counted 11,678 input tokens of which 11,630 were cache reads: the count
  does not fall, the price and latency do.
- In a live Story run the re-sent context grew from 15K to 217K tokens (window 272K), and after a
  15-minute pause Copilot re-wrote 160K and 202K tokens of cache although it reported a 1,800 s
  cache TTL ([live measurement](NATIVE-COPILOT-EFFICIENCY.md)). Cache survival across a pause is
  therefore not guaranteed by the reported TTL.
- Premium requests are counted per prompt; AI units follow tokens with cache discounts.

## 5. Goals

- G1. An eligible automatic repair costs fewer uncached input tokens than today's fresh repair.
- G2. The repair turn is admitted, transported, audited and checked as strictly as a fresh one.
- G3. Every repair records whether it continued a session or ran fresh, and why.
- G4. Anything the design cannot prove falls back to today's fresh repair, unchanged.

## 6. Non-goals

- Retrying a failed or cancelled model call in session.
- Confirmed (human) repairs, resumed flights, or anything after the process ends: a session
  never outlives its CLI process.
- Sharing a session across phases or across flights.
- Native Copilot chat turns, which SFlow does not spawn.
- Reducing premium requests.

## 7. Terminology

- **Parent turn**: the authoring attempt's model call that opened the session (turn 1).
- **Repair turn**: the automatic repair's model call in the same session (turn 2).
- **Repair-turn prompt**: the short governed text sent as the repair turn.
- **Inherited context**: what the model already holds from the parent turn: Copilot's
  instructions, the parent's admitted prompt, and the parent turn's transcript.

## 8. Invariants

1. A repair turn is sent only on a session whose parent turn completed successfully in this
   process, for the same flight, phase and attempt lineage.
2. The transported repair-turn prompt digest equals the digest admitted in the repair attempt's
   Context Manifest, and the transported session id and turn equal the bound ones.
3. The repair attempt's tool scope is the Repair Plan's, enforced per turn; it can only narrow
   the session's launch scope.
4. A repair-turn prompt is never sent outside its session. Without the session it is not a
   complete prompt.
5. Governance records say what the model saw: the repair attempt's manifest names the inherited
   parent contract as well as the repair-turn prompt.
6. Budget, invocation ceilings, token assurance, pause, halt and quiescence behave exactly as
   for a fresh repair.

## 9. Design

### 9.1 Opening the session

The parent turn opens a session only when all hold:

- the flight's repair continuation is enabled (9.9);
- the ratified repair policy is `auto-on-machine-actionable` with one repair attempt;
- at least two model invocations remain under the plan ceiling;
- the provider transport is `acp-stdio`.

Otherwise the parent turn runs exactly as today. A session opened for a parent turn that needs
no repair costs the same as today's single prompt and is closed when the step ends.

The session is created in `executeAutoFlightStep` (the entry point that holds the step lease), handed down
through the runtime, used by at most two turns (`maxTurns: 2`), and closed in a `finally`,
including on pause, halt, refusal and thrown errors.

### 9.2 Continuing or falling back

At the repair attempt, the executor continues the session only when every gate holds; otherwise
it records the reason and runs today's fresh repair with a fresh process:

| Gate | Continue when |
|---|---|
| Session | open, not closed, one turn used, shape unchanged (provider, model, settings, folder, roots, tool names) |
| Parent | the parent turn completed, its invocation id is the flight's `lastInvocationId`, and its usage is known |
| Time | elapsed since the parent turn completed is below the continuation window (default 20 minutes; set from the 9.10 probe) |
| Size | parent input + output + repair-turn prompt is below 50% of the model's context window |
| Budget | the estimate leaves the flight's token budget unbreached under its assurance policy |
| Lineage | the Repair Plan's `parentAttemptId` is the parent turn's attempt and its refusal is the current one |

Reasons are fixed vocabulary: `continuation-disabled`, `no-session`, `session-closed`,
`shape-changed`, `parent-not-completed`, `usage-unknown`, `window-elapsed`, `context-too-large`,
`budget`, `lineage-mismatch`.

### 9.3 The repair-turn prompt

Rendered deterministically from sealed records only: the Repair Plan and its refusal. No live
file reads and no model text, so its digest is reproducible from the records.

```text
# Auto repair turn
- Flight: <flightId>
- Repair attempt: <attemptId> continuing attempt <parentAttemptId>
- Repair Plan: <repairPlanId> (<repairPlanSha256>), refusal <refusalSha256>
- Gate: <refusal.gate> returned <refusal.code>
- Missing evidence:
  - <refusal.missing[i]>   (bounded; already redacted when the refusal was sealed)
- Objective: <repairPlan.objective>
- Write scope: <repairPlan.writeScope>
- Required evidence: <repairPlan.requiredEvidence>
- This is the only authorized repair. Change only the write scope; do not repeat earlier work.
- Work only in this managed worktree. Do not commit, push, approve, waive policy, answer
  clarification, change lifecycle state, or run Singularity Flow commands.
```

Bounded at 8 KiB. A refusal whose rendered prompt exceeds the bound falls back with reason
`context-too-large`.

### 9.4 Admission and the receipt check

The repair attempt's phase contract replaces the `phase-prompt` section with two sections:

| Section | Representation | Content digest |
|---|---|---|
| `repair-turn-prompt` | `session-delta` | raw UTF-8 digest of the repair-turn prompt |
| `session-continuation` | `digest-bound-authority` | canonical digest of `{ protocol: 'auto-session-continuation-v1', sessionId, turn: 2, parentAttemptId, parentInvocationId, parentPromptSha256, parentOutputSha256, parentContractSha256, repairPlanSha256, refusalSha256 }` |

`phase-authority`'s context names the repair-turn prompt digest and the continuation digest.
The task contract carries the Repair Plan's read and write scope, as today.

The executor's receipt check is generalized. Exactly one mandatory prompt section exists, with
representation `exact-model-prompt` or `session-delta`. For `session-delta` it additionally
requires:

- the transported prompt digest equals the section digest;
- the invocation's `session.id` equals the bound `sessionId` and `session.turn` is 2;
- the parent invocation's audit `outputSha256` and `promptSha256` equal the bound values.

Any mismatch refuses with `AUTO_CONTEXT_MANIFEST_MISMATCH`, as a fresh mismatch does.
`invokeModel` returns the `session` it recorded, so the executor never has to infer it.

### 9.5 Inherited context

A fresh repair shows the model the recomposed phase prompt and nothing else. A repair turn shows
it the parent's admitted prompt, the parent turn's transcript and the repair-turn prompt.

- Everything in the transcript was produced under the parent attempt's admitted context and
  read scope; no file outside that scope could have been read.
- The repair attempt's manifest records `inheritedContext: { parentContractSha256,
  parentReadScopeSha256 }`, so an audit shows the model also saw the parent turn.
- New tool calls are decided against the repair scope. Writes outside it are refused as today.

Accepting this as admitted context is a governance decision (decision D2).

### 9.6 Tool scope

The session is launched with the parent turn's allowed roots and tool names. The repair turn
passes the Repair Plan's read and write roots, which ACP `request_permission` applies per turn. A
repair scope wider than the launch roots is impossible by construction and refuses as
`shape-changed` before any prompt is sent.

### 9.7 Token accounting

Usage is the per-turn delta (`acpTurnUsage`). The flight's counters, token budget and assurance
checks run on that delta exactly as for a fresh repair. The repair attempt's records add
`continuation: { status: 'session' | 'fresh', reason, cacheReadTokens, cacheWriteTokens,
uncachedInputTokens }` where the provider reports them, so G1 can be measured per repair.

### 9.8 Failure, cancellation and recovery

- A failed, timed-out or cancelled repair turn closes the session and is the repair attempt's
  outcome, as a failed fresh repair is today. It is never retried in a new process with the
  repair-turn prompt.
- Pause and halt cancel the active turn, close the session and report quiescence as today.
- A crash during the repair turn leaves a phase contract whose prompt is `session-delta`.
  Recovery treats that attempt as interrupted: the session is gone, so the attempt is consumed
  and the flight stops for a human, exactly as for an interrupted fresh repair.

### 9.9 Opt-in

Continuation changes what context the model sees, so it is not on by default in v1. Two ways to
enable it (decision D1):

- **Plan-ratified (recommended).** `auto.repair.continuation: 'session' | 'fresh'` (default
  `fresh`) in the Auto plan. The plan's `auto.repair` keys are validated today (`policy`,
  `maximumAttempts`), so this needs `auto-plan` schema version 4 with a migration that adds
  `continuation: 'fresh'`, and a GDP companion-lock review for `migration-registry`. The human who
  ratifies the plan sees and accepts the choice.
- **Machine opt-in.** `SINGULARITY_FLOW_AUTO_REPAIR_SESSION=on`, recorded in the flight's
  continuation records. No schema change, but the choice is not part of ratification.

`SINGULARITY_FLOW_AUTO_REPAIR_SESSION=off` always forces fresh repairs.

### 9.10 Prerequisite probe

Before choosing the continuation window, a paid probe (approval required) measures cache
survival: in one ACP session, a large first turn, then follow-ups after 2, 5, 10, 20 and 30
minutes, recording cache reads and writes per turn. The live run's re-written cache after a
15-minute pause is the reason this cannot be skipped.

## 10. Functional requirements

- **ARS-REQ-001** The parent turn opens a session only under 9.1; otherwise behaviour is unchanged.
- **ARS-REQ-002** Every exit path of `executeAutoFlightStep` closes the session.
- **ARS-REQ-003** The repair attempt continues the session only when every 9.2 gate holds, and
  records the status and fixed-vocabulary reason either way.
- **ARS-REQ-004** The repair-turn prompt is rendered deterministically from the sealed Repair Plan
  and refusal, bounded at 8 KiB, and never sent outside its session.
- **ARS-REQ-005** The repair attempt's Context Manifest admits `repair-turn-prompt`
  (`session-delta`) and `session-continuation`, and records the inherited parent contract.
- **ARS-REQ-006** The receipt check enforces 9.4 and refuses any mismatch with
  `AUTO_CONTEXT_MANIFEST_MISMATCH`.
- **ARS-REQ-007** `invokeModel` returns the recorded `session: { id, turn }`.
- **ARS-REQ-008** Repair-turn tool permissions use the Repair Plan scope per turn.
- **ARS-REQ-009** Token counters, budget and assurance use the repair turn's own usage delta.
- **ARS-REQ-010** A failed, cancelled or interrupted repair turn consumes the repair attempt and is
  never replayed in a new process.
- **ARS-REQ-011** `auto status` and the flight record show whether the repair continued a session
  or ran fresh, and why.
- **ARS-REQ-012** Continuation is off unless enabled per 9.9, and the off switch always wins.

## 11. Acceptance criteria

1. With continuation disabled, every existing Auto test passes and records `fresh /
   continuation-disabled`.
2. With a fake ACP agent: one process serves the parent and repair turns; the second prompt is
   the repair-turn prompt byte for byte; turn-2 writes outside the Repair Plan scope are refused;
   the session closes after the step.
3. Each 9.2 gate, failed alone, produces a fresh repair with the matching reason.
4. A transported prompt, session id, turn or parent digest that differs from the manifest refuses
   with `AUTO_CONTEXT_MANIFEST_MISMATCH` and no candidate is accepted.
5. A failed repair turn halts after exactly two model invocations, as today.
6. Pause and halt during the repair turn quiesce with only their governed checkpoint.
7. Crash recovery during the repair turn consumes the attempt and stops for a human.
8. The paid A/B (12) shows fewer uncached input tokens per repair than fresh, with the same
   verification outcomes; otherwise the default stays `fresh`.

## 12. Measurement plan

All paid runs need explicit approval.

1. The 9.10 cache probe (estimate: under 100K tokens).
2. An A/B on a fixture Story with a reproducible machine-actionable refusal: two runs with
   `fresh`, two with `session` (estimate: about 1M tokens). Per repair, compare uncached input,
   cache reads and writes, AI units, wall time and verification outcome.

## 13. Delivery

- **M0** Probe (9.10). Decide the continuation window.
- **M1** Session lifetime, `invokeModel` returning `session`, gate evaluation and continuation
  records, with every repair still running fresh. Ships alone.
- **M2** Repair-turn prompt, admission, receipt check and fake-ACP tests, behind the opt-in.
- **M3** Opt-in as decided in D1, disclosure in `auto status`.
- **M4** Paid A/B; decide whether `session` may become the default.

## 14. Risks

- **Cache not reused.** The provider may evict or rewrite the cache; a continued repair would
  then pay for the whole parent transcript uncached. Mitigated by the time and size gates and the
  probe; measured per repair.
- **Anchoring on the first attempt.** A model holding its earlier reasoning may repeat a wrong
  approach. The fresh path stays available; the A/B compares verification outcomes, not only
  tokens.
- **Schema and governance cost.** The plan-ratified opt-in needs an `auto-plan` migration and a
  companion-lock review.
- **Small absolute saving.** One automatic repair per refusal at most; the saving is per repair,
  not per Story.

## 15. Decisions for the owner

- **D1** Opt-in mechanism: plan-ratified field with `auto-plan` v4 (recommended), or machine
  opt-in through the environment.
- **D2** Whether the parent turn's scope-bounded transcript is acceptable as admitted context for
  a repair turn (9.5).
- **D3** Approval for the paid probe (about 100K tokens) and the A/B (about 1M tokens).
