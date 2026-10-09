# `@sflow` Chat Participant

**Status:** deterministic, zero-model command surface implemented; drafting commands and their
prerequisites are deferred

The Singularity Flow VS Code extension registers one explicit Copilot Chat participant: `@sflow`.
The participant is extension code, not a prompt or a skill. For the commands listed here, the
extension resolves the route locally, calls only an existing deterministic Singularity Flow read
or preview operation, and renders the result without asking a language model to interpret either
the request or the response.

Type `@sflow` explicitly. The extension does not advertise an automatic participant-detection
route and does not ask a model to decide which Singularity Flow command to run.

## Current guarantees

- The packaged command table declares every current entry as `deterministic`; no drafting entry is
  active in this implementation.
- Slash commands dispatch by their declared ID. Free text after `@sflow` is matched locally only
  to a declared exact keyword, or to that keyword followed by arguments when the command permits
  them. An unknown or ambiguous request shows help instead of invoking a model.
- Participant code does not call the VS Code language-model API. Metrics emitted for the declared
  CLI-command path therefore record `modelInvocations: 0` when the optional local metrics log is
  enabled.
- CLI arguments are passed as an argument vector, not assembled as a shell command. The participant
  does not execute a displayed follow-up merely because it rendered a button or command.
- Commands returned by CLI result or remediation envelopes cross the shared command-guidance
  validator before display. Credential-shaped values, shell syntax, contradictory Copilot routes,
  and unknown command families are suppressed; placeholder commands are display-only and cannot
  become **Copy Shell** buttons.
- The participant reuses the CLI and the existing `/sf-*` skills as the runtime and fallback
  surfaces. It does not implement a second lifecycle engine or a second approval authority.

“Deterministic” means the route contains no model decision or generation. It does not mean that a
later, separately confirmed operation is read-only. In particular, the pre-existing attachment flow
can register or exclude private feedback evidence only after its own modal confirmation, and the
approval command uses the existing guarded approval experience. Submit, publish and continue
execute one engine-owned action only after human review. Model invocation is disabled in the CLI
environment (`SINGULARITY_FLOW_NO_MODEL=1`), including nested actions. No command selects a chat
model or guesses a route from prose.

## Implemented commands

| Participant command | Deterministic operation | Boundary |
|---|---|---|
| `@sflow /help [question]` | Packaged help index or reviewed-topic resolver | With no question, lists participant commands. A question is answered only from reviewed offline topics. |
| `@sflow /next` | `singularity-flow nextsteps --json` | Reads the ordered legal actions. It does **not** run `singularity-flow next` and does not execute the returned `NOW` action. |
| `@sflow /status` | `singularity-flow status --json` | Reads current bounded Story and phase status. |
| `@sflow /checks` | `singularity-flow precheck --quick --json` | Runs only the read-only quick readiness projection; it does not start planned checks or repair failures. |
| `@sflow /explain <subject>` | Packaged reviewed-topic resolver | Resolves reviewed help locally. It does not expose the CLI's repository-bound `explain code` projection or model narration in this participant increment. |
| `@sflow /converge` | `singularity-flow converge --json` | Reads the convergence result. It does not adjudicate or follow a returned lifecycle action. |
| `@sflow /docs` | `singularity-flow documents list --active --json` | Lists active governed documents without uploading, registering, or changing one. |
| `@sflow /inputs` | `singularity-flow inputs <active-phase> --dry-run --json` | Resolves the phase from the verified active session and previews input provenance without writing the managed input record. |
| `@sflow /workflows` | `singularity-flow workflow list --json` | Lists installed and available workflow profiles. |
| `@sflow /approve [phase] [--work-id ID]` | Native exact-hash human review and selection receipt | Selectors must match the active Story. Requires typed confirmation, checklist/witness decisions where applicable, human authority and self-approval acknowledgement. Never accepts a decision from prose. |
| `@sflow /submit [phase] [--work-id ID]` | Action plan → review → one-time authorization → submit | Runs configured submission checks. Workflow decision inputs are prompted and bound into the plan before review. Convergence uses its distinct digest-reviewed submission contract. |
| `@sflow /publish [phase] [--work-id ID]` | Ready prepublish contract → action plan → confirmed publication | Does not generate or rewrite a draft. Fresh tests and every publication gate remain enforced. Unready drafts stay intact and return diagnostics. |
| `@sflow /continue [phase] [--work-id ID]` | Choose one currently executable submit/publish/approve action | Human confirms the action. Never executes authoring/model generation, waivers, arbitrary scripts, or an automatic lifecycle loop. |
| `@sflow /validate` | `singularity-flow validate` | Runs the existing deterministic validation read and renders its text result; `/sf-validate` is the exact skill fallback and neither route accepts a validation decision. |
| `@sflow /why <blocker>` | Reviewed-topic resolver | Explains only from packaged help and may show current read-only readiness context. |
| `@sflow /how <task>` | Reviewed-topic resolver | Returns a reviewed procedure and reviewable shell/skill handoffs. |
| `@sflow /recover <failure>` | Reviewed-topic resolver | Returns the reviewed recovery route; it does not perform the recovery. |
| `@sflow /attachments ...` | Existing guarded feedback-attachment handler | SFlow preview and status are model-free. Registration or exclusion requires the separate one-use modal confirmation documented in [REV delivery status](REV-DELIVERY-STATUS.md). It does not start REV; the Copilot host may already have processed a chat attachment before SFlow receives it. |
| `@sflow /topics` | Packaged help index | Lists reviewed offline help topics. |

Repository-bound commands refuse when the selected editor repository cannot be verified. `/next`,
`/status`, and `/docs` deliberately require only that repository, so the engine can report a
no-active-Story state or a completed/cancelled Story instead of the participant masking it with an
in-progress-phase refusal. Commands declared as session-bound additionally require the selected
Work ID and active Story phase to match that repository. The participant reports the refusal or
CLI error and leaves state unchanged; it does not guess a repository, Work ID, phase, or repair.

## Safety amendments to the original CPT draft

The initial CPT proposal used shorthand runtime mappings that were unsafe or not valid in the
current engine. The implementation deliberately narrows them:

1. `/next` calls `nextsteps`, not `next`. `next` is a lifecycle mutation; the participant is an
   observation and handoff surface.
2. `/checks` calls `precheck --quick`. The quick form is the registered read-only readiness
   operation; check execution continues to use its existing plan and confirmation boundary.
3. `/inputs` always supplies the verified active phase and `--dry-run`. Plain `inputs` may prepare
   and write managed input records, which is outside this handler.
4. `/approve` resolves the phase from the active session; optional selectors must match it. The
   existing approval review records the person's typed answer against a fresh selection receipt.
   The participant never turns prose into approval or prefills a confirmation field.
5. Lifecycle writes recheck pause, cancellation, saved buffers, repository and selected Story after
   human interaction. Plans bind HEAD, index/worktree bytes and lifecycle state, expire and use
   one-time authorization. Stale failures are not retried. `/next` stays read-only; use `/continue`
   for a separately confirmed action.

Buttons and displayed commands are therefore handoffs, not implicit consent. A handoff either
opens an existing review surface or prepares a command for review; the governed operation retains
its normal identity, freshness, selection, and exact-confirmation checks.

## Command declaration and skill parity

The extension loads its participant routes from
`apps/vscode/src/participant-commands.json`. Each entry declares its command ID, class, transport,
effect, runtime argument vector, render template, skill twin, keywords, argument policy,
repository/session requirements, and confirmation boundary. The loader rejects malformed entries
and duplicate IDs or keywords. This release also rejects every `drafting` class and `mutation`
effect in both the loader and runtime dispatcher; those entries cannot become executable merely by
editing or repackaging the table before their separate guarded implementation exists. Immediately
before execution, the expanded argv must also classify as a read in the shared extension CLI
classifier. A row falsely labelled `read` cannot smuggle `next`, `phase publish`, writable
`inputs`, confirmed precheck execution, or another mutation through the generic dispatcher. The
four local lifecycle adapters are separate closed handlers, not a generic mutation escape hatch.

## Discovering the model-free alternative in Copilot

Guidance includes `modelFreeCommand` and a **VS Code (model-free)** line for supported operations,
alongside Shell and `/sf-*` routes. Panels offer **Copy @sflow**; `@sflow /help` and Copilot's
participant command menu list the adapters. Unsupported flags, imports, authoring/model work and
arbitrary targets are not advertised as equivalent commands. Select another Story before using its
phase or Work ID. Lifecycle commands reject bypass flags, raw shell text and private receipts in
chat. Install this extension build and reload VS Code to see the new commands.

The `skill` field documents the established `/sf-*` fallback for hosts without VS Code chat
participants. It is a route relationship, not a claim that chat and skill hosts have identical UI
or confirmation handles. Both surfaces ultimately rely on the same Singularity Flow engine
operation and its authority checks.

## Local participant metrics

When the user has enabled the existing local help-metrics facility, participant events are
content-free. They can record the participant surface, declared command and class, outcome,
duration, `modelInvocations`, and token-count fields. Current CLI-command events record zero model
invocations and zero model tokens. Reviewed-help events retain the existing help-routing fields.
Neither form stores the prompt, response, repository path, Work ID, phase, file content, or person
identity.

This local command metric is not governed phase telemetry and is not provider billing evidence.
It does not prove billed token usage, populate a phase `telemetry/` record, or replace the existing
telemetry reconciliation and disclosure controls.

## Explicitly deferred work

The following parts of the draft CPT specification are not implemented and must not be inferred
from the deterministic command surface:

- **Drafting commands and model API:** `/code`, `/specify`, `/plan`, `/revise`, and `/narrate` are
  not registered participant commands. The proposed `request.model.sendRequest` and exact
  `countTokens` flow is not implemented against the supported VS Code 1.90 baseline. The
  participant handler sends no packet, chat history, workspace file, or attachment to a model;
  this does not claim that the Copilot host did not process an initially attached chat file before
  SFlow received the request. A future design must also preserve the engine's model-mode policy
  and audit boundary rather than create an extension-only provider path.
- **Participant code explanation:** the existing CLI and `/sf-explain-code` skill can compute a
  model-free `explain code` projection, but `@sflow /explain` remains a reviewed-topic resolver in
  this increment. Wiring that repository-bound projection into the participant is not claimed.
- **Resident CLI:** the proposed long-lived `serve --stdio` transport is not present. Participant
  CLI routes use the existing bounded one-shot client. The draft's latency target and resident-
  process fallback claim therefore remain unproven.
- **Packet compose and Candidate freeze API:** there is no participant-ready `packet compose` →
  model response → `candidate freeze` contract. The participant neither freezes model output nor
  writes application files or Git refs.
- **REV execution:** feedback-attachment intake and the guarded manual Revision Loop are available
  through `/sf-revise`. The participant route `@sflow /revise` is deliberately bounded: it may read
  status/cards or prefill the separate skill, but it never opens an interval itself. Autonomous
  code execution, trusted browser execution, and unrestricted/default REV activation remain
  unavailable. See [REV delivery status](REV-DELIVERY-STATUS.md).
- **Full participant telemetry:** local content-free command metrics are implemented, but exact
  provider request/response tokens, phase TEL integration, billed cost, packet/response hashes,
  and resident-host performance receipts are deferred with the drafting pipeline.
- **Draft parity and performance acceptance:** because no drafting routes or resident transport
  exist, the draft acceptance claims for byte-for-byte packet-only model input, candidate freeze,
  citation-checked narration, participant/skill parity verification, and ≤300 ms resident-CLI
  performance are not claimed. This increment also does not add CPT-specific physical
  Windows/offline or installed-VSIX release receipts.

These are prerequisites for a future CPT drafting increment. They are not defects in the current
zero-model command surface, and adding them requires a separately reviewed implementation and
updated release evidence.
