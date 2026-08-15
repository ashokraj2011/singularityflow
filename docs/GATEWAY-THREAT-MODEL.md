# Gateway threat model

The intent-routed gateway lets a host model turn conversational language into governed operations.
This document says what that exposes, what each exposure is closed by, and which parts are still
open. It covers the gateway only — the publication transaction, approval authorities and the
governed lifecycle have their own guarantees and are not restated here.

## The one-sentence trust boundary

The host model may propose **one broad goal hint and typed argument proposals**. Everything after
that — validating the goal, resolving the subject, choosing the operation, computing legal actions,
classifying the result — is the kernel's, and the kernel is deterministic `[INT:CON-030]`
`[INT:REQ-030]`.

Everything below is a consequence of taking that sentence literally.

## Assets

| Asset | Why an attacker wants it |
|---|---|
| Approval and gate authority | Recording a verdict is the highest-value write in the product |
| Governed lifecycle state | Advancing a phase launders unreviewed work into approved work |
| Git refs and the worktree | Push, force-push, branch deletion; bytes covered by an approved plan |
| External write targets | Jira, CI, provider APIs — effects outside anything this product can roll back |
| Repository contents | Source, credentials, unpublished specifications |
| Confirmation receipts | A stolen receipt is a stolen consent |
| The user's attention | Confirmation fatigue is the precondition for every other attack here |

## Adversaries

**A1 — Prompt injection through content.** Repository files, Jira descriptions, commit messages,
build logs and provider payloads all reach a model that also holds tools. Assume everything the
kernel reads is attacker-controlled text.

**A2 — A confused or over-helpful model.** No adversary at all: the model resolves ambiguity in the
direction of being useful, and picks the write.

**A3 — A compromised or hostile host adapter.** The extension, the MCP server, or something wearing
their identity, calling tools directly with arguments no human typed.

**A4 — A local attacker with filesystem access.** Reads what the kernel wrote down, including
anything a handle or receipt persisted.

**A5 — An insider using the gateway as cover.** A real actor with real authority, using
conversational ambiguity to produce a governed act they can later disown.

## What closes each path

### The model cannot name what it invokes

`sflow_read` and `sflow_run` accept exactly one property — a handle — in a closed object
(`src/gateway/tools.mjs`). There is no operation name, command line, Git argv, path, provider query
or free-form argument anywhere in the surface `[INT:IFC-013]` `[INT:IFC-015]`. A handle is issued
by the kernel, is opaque, and the reference the model receives carries an ID, a kind and an expiry
and nothing else (`src/gateway/handles.mjs`).

Closes: A1, A2, A3 for anything not already offered.

### The reachable surface is opt-in and small

The registry declares 26 gateway-reachable operations out of roughly 150 kernel operations, and
reachability is a line someone wrote rather than a property inherited from existing
(`src/gateway/operations.mjs`) `[INT:CON-050]`. Adding a command cannot widen the model's reach.
Reset, reinstall, cancellation and secret writing are unreachable because they were never declared.

Closes: A1, A2, A3. Note the shape of this defence: it is *absence*, which does not decay.

### A goal hint cannot select a write

Ten operation IDs are spelled exactly like the goal they serve, which is the specification's own
convention. The hint is advisory because of *where it is accepted*, not what it is called: only
`sflow_resolve` takes one, resolution intersects it with the legal-action set, and the registry
refuses to compile if any goal reaches only writes `[INT:CON-035]` `[INT:CON-036]`.

Closes: A2.

### An authorization is not a thing that can be executed

`authorization` is a classification the kernel's v1 registry does not have. In v2 it forces
`confirmation: ceremony` and `executable: false`, and `issuePlan` refuses to produce a plan for one
at all `[INT:CON-113]`. Not "a plan a careful host declines to run" — no plan.

Closes: A1, A2, A3, and the most valuable case for A5.

### Confirmation is collected outside the conversation

The host collects confirmation through native UI and exchanges it for a one-time receipt
`[INT:CON-111]`. The receipt value is never a tool property, never in a result, and the stored
record holds only its hash, so possession of the record does not permit replay `[INT:CON-039]`
`[INT:REQ-111]`. A receipt is bound to one plan hash, actor, session and audience, expires in two
minutes, and is single-use.

Closes: A1, A3, A4 (the stored side), A5 (a decision cannot be produced without an act).

### Nothing survives the world moving

Every handle carries the world it was computed against — workspace, subject, source commit,
worktree, lifecycle revision, policy hash, registry hash, actor, session — and drift on any field
invalidates it and names the field. A plan approved against one reality cannot execute against
another `[INT:REQ-036]`.

Closes: A5 (approve-then-swap), and the race in A3.

### Policy can only narrow

Eight layers intersect and the most restrictive wins, so "a repository must not weaken a central
restriction" is not a rule that gets checked — it is a thing the resolution function cannot express
`[INT:CON-120]` `[INT:CON-121]`. The registry's own confirmation class is a floor no policy file can
lower. A missing or unusable policy degrades to deterministic reads plus explicit commands rather
than throwing `[INT:CON-122]`.

Closes: A3, A4, and the "just edit the config" step in most escalations.

### Assisted analysis is disclosed before it happens

The Context Receipt states exactly what will be shown to a model, what was omitted and under which
category, what was redacted, and an estimate that names its tokenizer `[INT:REQ-175]`. It is
narrowable, and refuses to narrow past the evidence the operation's contract requires
`[INT:CON-173]`.

Closes: the exfiltration half of A1 — an injected instruction to include a file has to survive a
screen that lists the files.

### Attention is treated as a scarce resource

Confirmation classes are ranked and the registry sets the floor, so nothing writes at
`confirmation: none`, and nothing that is merely inconvenient gets promoted to a ceremony either.
Every result must offer a next action or declare an explicit rest state, and a refusal must declare
no effects — both make "just click through" less rewarding than reading.

Closes: the precondition for A5 and the escalation path for A2.

## Residual risk

**Injected text still reaches the model.** Nothing here prevents a repository file from containing
instructions. The claim is narrower: what the model does with them is bounded by the registry, the
handles, and the confirmation classes. A model that is talked into calling `sflow_resolve` with a
hostile utterance gets the same bounded set of candidates a user would.

**The host adapter is trusted to collect confirmation honestly.** If the adapter lies about having
shown a dialog, the receipt is real and the consent is not. The kernel cannot detect this. What it
can do — and does — is make the receipt useless outside one plan, one actor, one session and two
minutes, so a lie has to be told at the moment of the act, by code the user installed.

**Handle secrets live in process memory.** Per session, never written down, gone when the process
exits. A local attacker with debugger access to a running kernel is out of scope; the design choice
is that this is strictly better than a key on disk.

**The token estimate is an approximation.** The runtime ships no provider tokenizer. The estimator
is named everywhere it is reported and the number is flagged as not-billing, but a user who reasons
about cost from it will be somewhat wrong `[INT:CON-174]`.

**Planners are declared and not yet implemented.** The registry compiles, the rules bite, and 26
planners return nothing because they do not exist yet. Until they do, the gateway is a contract with
no execution path — which is safe, and is not the same as finished. `MAX_UNIMPLEMENTED_GATEWAY_PLANNERS`
counts them and only goes down.

## Invariants a change must not break

1. No tool other than `sflow_resolve` accepts words.
2. No confirmation value appears in any model-visible field.
3. No operation is reachable without a declaration.
4. No authorization is executable.
5. No policy layer can loosen what a more authoritative layer set.
6. No result declares an effect it did not have, and no refusal declares any.
7. `modelPolicy` is never derived from `gateway.reachable`, or the reverse.

Each has a test. `test/int-budget.test.mjs`, `test/int-handles.test.mjs`,
`test/int-registry-v2.test.mjs`, `test/int-policy.test.mjs`, `test/int-result-v2.test.mjs`.
