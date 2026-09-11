# Verification checklist

Use this checklist for the agent-only Singularity Flow 0.9.0 development model.

The current packaged diagnostic tutorials are `sflow explain diagnostics-and-regression`, `sflow explain repository-state-and-snapshots`, and `sflow explain recovery`.

## Repository initialization

- `singularity-flow init` creates `singularity/workflow.yml`, all referenced
  templates and prompts, and `.github/agents/*.agent.md` without overwriting
  edited files.
- Workflow schema version 2 rejects incompatible role-bearing configuration and
  runtime state with a recreate instruction.
- Every configured phase has exactly one default governed agent.
- Agent IDs, phase references, world-model views, template references, allowed
  tools, and protected paths validate deterministically.

## Sessions and intake

- Story start asks only for source and workflow; it never asks for an execution
  role.
- Story and initiative start activate the first phase's default agent.
- Resume and phase advancement activate the current phase's default agent.
- `/sf-agent` and `singularity-flow agent <WORK-ID> --agent <ID>` provide a local,
  audited override and create no lifecycle commit by themselves.
- A human's local profile, Git identity, GitHub identity, authority group, and
  governed agent remain distinct fields.
- Work-item selection remains explicit and synchronizes the exact remote branch.

## Prompt composition and world model

- `wm compose` combines the phase contract, Agent Markdown body, required phase
  views, agent-added views, rule-selected repository files, approved inputs,
  locked remote dependencies, and applicable evidence.
- `/sflow-show-prompt` displays the exact skill plus rendered phase prompt without
  mutating state.
- Generation records the agent ID, Agent Markdown hash, world-model manifest and
  source hashes, included files, byte limits, and rendered-prompt hash.
- `off`, `warn`, and `enforce` grounding modes produce their configured severity.
- Agent-added views never remove phase-required views.

## Lifecycle and approval

- Every generation, submission, approval, rejection, and advancement produces an
  atomic commit and normal fast-forward push.
- Push failure retains the local commit, marks publication pending, blocks later
  transitions, and is recoverable with `sync`.
- Approval authority comes only from configured human identity groups. Changing
  agents never grants authority.
- Approval records include human identity, authority group, governed agent,
  timestamp, channel, exact subject hash, decision, and self-approval warning.
- Distinct-approval thresholds count distinct normalized human identities.
- Rejection invalidates only the configured downstream dependency cone.

## Inputs, artifacts, and conformance

- Input declarations validate ordering, duplicates, work-type membership, and
  byte limits in every mode.
- `record` warns and audits; `enforce` blocks missing, unapproved, or tampered
  inputs; `off` remains inert.
- Artifact metadata records generator identity and governed agent separately.
- Final conformance maps every `AC-nnn` and `SPEC-nnn` to exact source/test
  evidence and detects a stale source/test tree.

## Remote Agent Markdown

- Only exact dependency tables in Agent Markdown are processed; prose links are
  inert.
- First trust and updates require explicit confirmation. Sync never rewrites the
  lock.
- HTTPS, redirect, byte-limit, UTF-8 Markdown, target-containment, cache reuse,
  snapshot immutability, and local-edit conflict checks are covered.
- Copilot custom-agent mappings use explicit YAML first and same-name fallback
  second; mappings affect execution context only.

## Interfaces

- CLI, `/sf-*` and `/sflow-*` skills, and VS Code show the same current
  phase, default agent, documents, approvals, and next valid action.
- The VS Code Workspaces view selects and edits local context without opening a
  new window; Lifecycle owns intake and progress; Inbox shows artifacts and
  approvals; Configuration exposes workflow/artifact and
  agent/prompt/skill/prompt-pack designers plus capabilities and world-model state.
- The capability portfolio dashboard aggregates repositories, Jira routes, open
  governed work, pending approvals, diagnostics, and world-model health without
  becoming a new state store.
- VS Code labels say “agent” only for software execution contracts;
  people are shown as contributors, reviewers, and authority members.

## Release commands

For a developer POC packaged-smoke check, run:

```bash
npm run poc:release-gate
```

In its default developer mode, it type-checks and creates a diagnostic VS Code package, validates
the seeded POC workflow and Playwright MCP policy, runs the guided SGOS workflow creator on the invoking supported Node runtime, installs
the packed CLI into an isolated prefix and executes that installed copy, and drives the built
CommonJS extension bundle through a real Git journey under an isolated **stub** VS Code host. The
journey explicitly selects `origin/main`, creates and publishes only an isolated POC Story branch,
authors and submits the intake artifact, records an independent approval, advances the phase, opens
the governed native Copilot handoff, and recovers My Work plus the handoff after a fresh extension
activation.

After packaging, the gate also extracts `extension/cli` from the exact generated VSIX with bounded
ZIP, entry-count, path, file-type, CRC, per-file, and aggregate-size checks. It executes that
contained CLI's version and structured Help surfaces from an isolated consumer directory. A Node
loader refuses file-module resolution outside the extracted engine tree, while `NODE_PATH` and
ambient `NODE_OPTIONS` are removed. This proves that the exact VSIX carries a runnable, internally
complete CLI engine; it still does **not** claim that the VSIX activated in a real VS Code host.
Real installed-host activation remains a signed release-matrix exercise.

Every direct `node --test` stage uses the strict release reporter, including the reporter's own tests
and the gate-contract tests. Those self-tests inspect an inert stage manifest and never invoke the
release gate recursively. Every stage has an explicit operation deadline plus bounded graceful and
forced process-tree cleanup; a timeout fails the gate even if a wrapper later exits successfully.
The default developer gate also proves the selected base ref never changes and finishes with an npm
package dry run. In artifact-consumer mode, used by signed verification and promotion, those
diagnostic packaging stages are omitted and the retained signed pair is supplied explicitly.
On Node 20 it uses the repository's bounded TypeScript test loader for the guided creator; newer
runtimes use native type stripping. Supported Node 20 developer and release runs execute the same
selected files; release and signed verification-receipt runs additionally fail if a future
compatibility branch ever attempts to skip one.

Release promotion still requires the signed six-cell macOS/Linux/Windows by Node 20/22 matrix,
including real installed-VSIX activation, Windows npm/npx execution, and authenticated/offline MCP
evidence. A local default `poc:release-gate` run is code-level diagnostic evidence for its one
invoking platform and runtime. It neither creates release authority nor substitutes for those six
receipts.

Each single-platform receipt now requires `--platform-evidence <json-path>`. The reviewed JSON must
conform to `schemas/release-platform-evidence.schema.json` and bind the observed commit, tree, npm
tarball digest, VSIX digest, exact platform, exact Node version, reviewer, and review timestamp. Its
five checks are real installed-VSIX activation, staged-installer recovery, local start of the exact
release-pinned Playwright MCP package and closure under a named network-isolation mechanism,
authenticated Playwright smoke bound to the private profile's SHA-256, and Windows npm/npx
round-trip. The Windows check is mandatory on `win32` and must be explicitly `not-applicable` with
the closed reason `non-windows-platform` everywhere else.

New receipt generation uses platform-evidence schema v2. It additionally requires the SGOS
software-conversion and hypothesis-analysis journeys, interruption recovery, counterfeit-authority
refusal, cross-machine authority round trip, and reviewed performance-budget evidence. Each check
must point to a distinct retained evidence digest, and the performance observation also binds the
reviewed budget-profile digest. Historical schema-v1 evidence remains readable but cannot be merged
or promoted as current release authority. See
[`docs/SGOS-END-TO-END-RELEASE-PROOF.md`](docs/SGOS-END-TO-END-RELEASE-PROOF.md).

Only check outcomes, lower-kebab mechanism names, and SHA-256 references to externally retained raw
evidence enter the receipt. Raw logs, commands, paths, host names, URLs, and credentials are rejected
as unknown fields. Historical single-host receipt schema v5 and aggregate schema v6 remain readable.
New single-host schema v6 and aggregate schema v7 additionally bind one separately signed artifact
receipt, and carry both the physical platform evidence and the exact content-free WEL benchmark
report plus its canonical digest in every matrix cell. The report binds parser, ingestion, receipt
and Context X-Ray timing, byte growth,
exact/inexact counts, Story-start timing, exact publication recovery, offline/fresh-clone recovery,
interrupted-write restoration, and cancellation behavior. A non-observed, incomplete, host-mismatched,
content-bearing, or digest-mismatched benchmark cannot authorize a receipt. New merge and promotion
reject missing evidence, a mismatched artifact subject, an untrusted builder key, changed artifact
bytes, or cells naming different artifact-receipt payloads. Verification cells and promotion never
rebuild the npm package or VSIX. Each cell first snapshots descriptor-verified artifact bytes into a
private directory, installs the exact snapshot tarball, executes the CLI engine extracted from the
exact snapshot VSIX, and removes that snapshot after re-verification. Its consumer-mode POC gate
does not package a VSIX, build a source extension bundle, or run npm package inventory. Broader
source validation may create disposable diagnostic packs or bundles; those outputs cannot enter or
replace the signed artifact subject. See
[`docs/RELEASE-ARTIFACT-HANDOFF.md`](docs/RELEASE-ARTIFACT-HANDOFF.md). The local suite deliberately
does not manufacture physical evidence.

The portable `npm run test:platform:cmp-wel` contract executes the closed local witness profiles for
JUnit/Surefire plus the bounded `jest-static-v1` and `vitest-static-v1` adapters. The JavaScript
adapters replay their exact content-addressed JSON reporter bytes and source declaration ranges, but
remain observe-only and inconclusive until the WEL authority prerequisites are independently proven.

An operator can measure the JUnit/Surefire and JavaScript profiles against an explicitly reviewed
private corpus with
`npm run benchmark:wel:corpus -- --manifest <JSON> --samples <1..20>`. The runner emits only
aggregate timing, byte, outcome, mismatch, and closed-reason counts; it performs no test, model, AST,
Intelligence, network, cache, lifecycle, or authority action. JUnit cases use the bounded packaged
local JDK parser without compiling or loading Candidate tests. See
[`docs/WEL-REAL-CORPUS-MEASUREMENT.md`](docs/WEL-REAL-CORPUS-MEASUREMENT.md). A local report is not
release authority and does not replace independent corpus review or signed platform evidence.

The journey uses deterministic light grounding for its Copilot handoff so this gate never invokes a
model or spends tokens. `test/poc-workflow.test.mjs` separately holds the shipped POC workflow's
standard/deep grounding, MCP evidence, validation, repair-budget, and publication-review contracts.

The following standalone source checks remain useful developer prerequisites:

```bash
npm run test:release:aggregate
npm run check
npm run vscode:build
npm run vscode:typecheck
npm run test:vscode
npm pack --dry-run
```

These commands are not the release artifact authority: the dry run uses the invoking npm, and the
bundle is a developer output. The canonical procedure builds and signs one pair with
`npm run release:artifacts`, exercises those retained bytes in the external six-cell matrix, and
promotes them without rebuilding; see
[`docs/RELEASE-ARTIFACT-HANDOFF.md`](docs/RELEASE-ARTIFACT-HANDOFF.md).

The test aggregate is split into deterministic weighted shards with process-tree deadlines. Exact
passing shard receipts live under `.git/singularity-flow/test-runs/`, so a retry on the same clean
commit runs only incomplete shards. Release mode requires a clean checkout and refuses skipped,
cancelled, failed, or todo outcomes; the merged summary still uses Node's standard counters and is
consumed by the signed receipt generator.

Source-validation acceptance requires a complete clean-checkout aggregate, deterministic checks, a
clean worktree after diagnostic packaging, and successful branch publication without force-pushes.
Release acceptance additionally requires the separately signed artifact receipt, the exact retained
tarball and VSIX, and the complete externally reviewed six-cell aggregate.
