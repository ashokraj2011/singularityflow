---
id: telemetry-and-cost
title: Telemetry, tokens, and cost
version: 9
aliases:
  - tokens
  - cost
  - cache
commands:
  - telemetry
  - copilot
  - context
  - tokens
related:
  - impact-framework
  - model-independence
  - reference-previews
---
Token accounting is exact where the provider supplies it and labeled `unavailable` where it does not—never converted to zero. `sflow copilot` and `sflow workspace copilot` provision a separate metadata-only file stream for each SFlow-owned Copilot CLI process after one machine-local disclosure. Manual Copilot and native IDE chat remain usable but are not attributed to that launch. `sflow telemetry status` shows captured, partial, unavailable, conflict, and disabled coverage; `sflow telemetry reconcile` compares completed provider events against a phase. `sflow context xray` and `sflow tokens status|report|compare` read the resulting content-free observations without reconciling or mutating them. `sflow context compile|expand` use the same deterministic kernel and write only sealed handles and content-free accounting under the Git common directory.

## Purpose and prerequisites

Use this topic when the current goal matches **telemetry and cost**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** launch with `sflow copilot`; inspect or control capture with `sflow telemetry`. Read the current phase with `sflow context xray`, or the whole-Story ledger with `sflow tokens report`. Run `singularity-flow telemetry --help` for exact forms.
- **Copilot:** `/sf-telemetry`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** **Continue with Copilot CLI** opens the metered SFlow launcher in an integrated terminal. **Open Native Copilot Chat** remains available with an honest “usage unavailable” qualification.

## Guided workflow

1. Run `sflow telemetry probe` to see the documented capability for CLI, VS Code terminal, native VS Code, IntelliJ terminal, and native IntelliJ.
2. Run `sflow telemetry enable`, read the disclosure, and type `ENABLE LOCAL USAGE` if you want local capture. Declining never blocks work.
3. Start the agent with `sflow copilot` or the VS Code **Continue with Copilot CLI** action. Each process gets an opaque launch ID and separate raw stream under the Git common directory.
4. Run `sflow telemetry status`. A configured launch is only `captured` after at least one valid event is observed.
5. At a lifecycle boundary, run `sflow telemetry reconcile [PHASE]` when automatic reconciliation reports a pending generation.
6. Run `sflow context xray [WORK-ID]` to inspect the current phase, or `sflow tokens report [WORK-ID]` for whole-Story totals. Use `sflow tokens report --today` for a repository-wide, content-free local-day aggregate that excludes prompts, paths, Story IDs, identities, packet IDs, and model names. Add `--phase PHASE` to narrow a Story projection and `--json` to retain every metric envelope. Use `sflow context doctor` to inspect the observe/assist/enforce policy and selected budget profile.
7. For a pre-registered IMP study, run `sflow tokens compare --study STUDY-ID`. A token reduction with a regressed quality floor is `cheaper-but-worse`, never an improvement.

## Copilot activity when tokens are unavailable

Many Copilot plans leave token counts off their spans. For SFlow-owned launches, each generation's sanitized telemetry record still counts:

- **requests**: the prompts sent to Copilot, from its request (`invoke_agent`) spans;
- **turns**: the model round trips of each request, as Copilot reports them or, where it does not, the model calls under that request (marked as derived);
- **model calls and tool calls**, and how many of them failed;
- **quota and model events**: Copilot answering with a different model than the one requested, usually because the premium allowance ran out, and calls refused as rate limited or over quota.

These are counts and model names only. No prompt, response, tool argument, tool result, error message or conversation identifier is kept.

The record also stores the size of the governed prompt SFlow composed for the generation: exact bytes from the committed prompt snapshot, tokens estimated as bytes ÷ 4, and the prompt budget. Copilot adds its own instructions, tool definitions and chat history, which no client can see, so the size is a floor on what the model read.

`sflow report` and VS Code's Lifecycle Analytics chart these per phase, with generations and how often a later reviewer sent the work back. GitHub bills one premium request per prompt, times the serving model's multiplier, and does not bill the tool calls an agent makes on its own. Reports estimate premium requests from optional multipliers:

```yaml
tokens:
  premiumMultipliers:
    model-alpha-1.5: 1
    model-alpha-mini: 0
```

A name also matches dated builds of that model: `model-alpha-1.5` matches `model-alpha-1-5-20250929`, but `model-alpha` does not match `model-alpha-mini`. No multipliers are bundled, because GitHub changes them. A model without one makes the estimate partial or unavailable, and GitHub's billing stays authoritative.

Native IDE chat exports no spans to SFlow, so its phases show generations and prompt size but no requests, turns or quota events.

When a phase has no activity, the report, Lifecycle Analytics and `phase publish` say why and what to do. Publication records the reason from the generation's own launches: no session started through SFlow ran, capture was turned off, an existing OpenTelemetry setup was kept, or a launch has not exported its finished turn yet. Counts that were not captured read "Unavailable", never 0.

## State and safety

`telemetry enable` and `telemetry disable` change only a machine-local preference. Reconciliation may commit a sanitized phase summary, but raw streams and launch records stay under the Git common directory and never enter Git. Provisioning preserves existing endpoints and headers, forces content capture off for SFlow-owned streams, and never affects lifecycle authorization, approvals, submission, or release.

Context X-Ray and Token Ledger projections are read-only. They do not invoke a model, request expansion, rerun a tool, reconcile a provider stream, or change lifecycle state. Packet compilation and sealed expansion are explicit, model-free machine-local mutations. Requested and resolved model identities stay separate. Provider metrics carry field-level `exact`, `partial`, or `unavailable` status and assurance; SFlow's UTF-8 byte estimates are labeled `estimated` with `sflow-estimated` assurance. Provider usage and SFlow estimates are never added into a false combined total.

## Troubleshooting

- `disclosure-required`: run `sflow telemetry enable`, or continue unmetered.
- `conflict`: an existing OTEL endpoint, exporter, or authentication configuration was preserved. Review `sflow telemetry probe`; secret values are never rendered.
- `blocked-by-content-policy`: existing policy forces content capture, so SFlow refuses to ingest the stream while allowing work to continue.
- `partial`: finish the Copilot turn and reconcile again. An interrupted launch remains partial rather than inventing zero usage.
- Native IDE chat is `unavailable` until a documented, consented adapter provides a trustworthy local join. Use **Continue with Copilot CLI** when exact local attribution matters.

## Related topics

Continue with `sflow explain impact-framework`, `sflow explain model-independence`, `sflow explain reference-previews`.
