# Singularity Flow Lite 0.8.0 verification

Use this checklist before packaging or rolling the workflow into a repository.

## Automated release checks

```bash
npm install
npm test
npm run check
npm run desktop:build
npm pack --dry-run
bash -n install.sh
git diff --check
```

Expected CLI versions:

```text
singularity-flow --version  → 0.8.0
sflow --version             → 0.8.0
```

The package dry run must include `bin/`, `src/`, `plugin/`, `templates/`, `schemas/`, `examples/`, `HELP.md`, and the project documentation. It must not include test fixtures, `.git`, or local `.singularity` work items.

For a disposable clean clone, run `npm run install:local` and verify it fast-forwards without a merge, prompts for configured/public/custom npm registry before dependency installation, creates the current versioned tarball, installs that tarball globally through the same registry, replaces prior direct/marketplace plugin identities, and leaves only the current `singularity-flow@singularity-flow` plugin. Confirm that `--registry` and `SINGULARITY_FLOW_NPM_REGISTRY` work non-interactively, credentials-in-URL are rejected, `.npmrc` is unchanged, and a dirty checkout is rejected before `git pull`.

## Configuration checks

- `singularity-flow init` creates `.singularity/workflow.yml`, all referenced templates, all persona prompts, and the world-model builder prompt without overwriting edited files.
- Invalid YAML, unknown phase references, invalid persona capabilities, and missing templates fail clearly.
- Work-type template overrides take precedence over phase defaults.
- `start` snapshots the work type, resolved phases, configuration hash, and template hashes.
- Changing a work item's type after creation is rejected by validation.
- `migrate-config` preserves legacy JSON and Git history.

## Interactive selection checks

- With no source flags, `start` first asks for Jira story or manual description/documents.
- Manual interactive intake collects story details and zero or more local paths or HTTPS URLs before template selection.
- After source intake, `start` always asks for workflow template and persona.
- `resume` always asks for persona.
- No public `--type` or `--persona` option bypasses the picker.
- Non-interactive start/resume fails instead of choosing a default.
- Any configured persona may be selected in any phase.
- Persona selection alone changes only `.git/singularity-flow/session.json` and creates no commit.

## Jira and manual intake checks

- Jira commands fail clearly when `JIRA_BASE_URL`, `JIRA_EMAIL`, or `JIRA_API_TOKEN` is missing and never request or persist an Atlassian password.
- `jira fields` discovers site-specific acceptance-criteria, story-point, sprint, and additional custom-field IDs.
- `start <ID> --jira` writes normalized `source.json` and a readable `USER-STORY.md` without downloading Jira attachments.
- `start <ID> --story-file <YAML|JSON|Markdown>` preserves supplied story details without contacting Jira.
- Structured manual stories capture user, problem, outcome, scope, stakeholders, urgency, constraints, dependencies, acceptance criteria, risks, and notes.
- Story-file document paths resolve relative to the story file; files and HTTPS references receive stable `DOC-nnn` records and atomic pushed commits.
- Repeatable `--document` and `--document-url` inputs are imported in addition to documents declared in the story file.
- `guide`, `/sflow-help`, and `/sflow-nextsteps` are read-only; nextsteps returns ordered immediate, subsequent, and alternative actions for initialization, start/resume, pending publication, generation, submission, approval/rejection, following phases, and completion.
- `sflow-next`, `singularity-flow next`, and `/sflow-next` execute exactly one valid action: sync, grounded preparation, submission, interactive approval, or terminal governance. They never silently combine generation, submission, and approval.

## Help manual checks

- `HELP.md` is packaged and contains quick start, intake, personas, lifecycle, approvals, reports, Git recovery, world model, configuration, desktop, Copilot, installation, troubleshooting, and CLI-reference topics.
- `singularity-flow help` prints the complete canonical manual and `singularity-flow help <topic>` prints one unambiguous section.
- Unknown or ambiguous topics fail with the available stable topic IDs.
- `/sflow-help` loads canonical manual content for general questions and uses `guide` for work-item-specific questions.
- The Electron **Help** page imports the same `HELP.md`, supports local search, renders headings, tables, lists, inline code, links, and fenced code blocks, and requires no new renderer filesystem permission.

## GitHub Copilot plugin checks

Register the repository as a marketplace, install the plugin, and inspect the discovered skills:

```bash
copilot plugin marketplace add /path/to/singularityflow
copilot plugin install singularity-flow@singularity-flow
copilot skill list
```

- Every public plugin skill begins with `sflow-`; the bundled count is checked dynamically so new usability skills remain package-visible.
- The plugin manifest exposes `agents/`, and `sflow-workflow.agent.md` is discovered with empty, inert remote dependency tables.
- `/sflow-about`, `/sflow-start`, `/sflow-persona`, `/sflow-help`, `/sflow-nextsteps`, `/sflow-next`, `/sflow-phase`, `/sflow-progress`, and `/sflow-report` are available in Copilot.
- Start, resume, approval, rejection, and persona skills use `ask_user` for YAML-derived selectable options and `write_bash` to answer the same CLI picker; they never infer a default or pass hidden type/persona flags.
- Submission and approval show all generated current-phase documents before a decision, including content for text/Markdown and paths plus metadata for binary/image artifacts; `phase show` is read-only and repeatable.
- Generic names such as `/start`, `/phase`, `/progress`, and `/approve` are not registered by this plugin.
- Reinstalling through `singularity-flow plugin install` removes both direct and marketplace copies, refreshes the marketplace and plugin cache, and leaves only `singularity-flow@singularity-flow` installed.

## Artifact and lifecycle checks

Run a feature and bugfix through every configured phase. For each generation verify:

- Artifact location is `.singularity/work-items/<ID>/artifacts/<phase>/`.
- Managed metadata includes the correct actor, persona, generation, hashes, usage, and approvals.
- Commit subject includes `[ID][phase:<id>][generated:<n>]`.
- The work branch is pushed before the command reports success.
- Submission, approval, rejection, and advancement each have their own pushed commit.
- A second clone can fetch, fast-forward, resume, and reconstruct state solely from the branch.

For an unreachable remote, verify the local commit is retained, transitions are blocked, and `singularity-flow sync` publishes the same history after connectivity returns.

## Phase-input checks

- Missing `inputsMode` and explicit `off` validate declarations but do not render blocks, create records, or change legacy behavior.
- String and object declarations normalize correctly; duplicates, unknown/later phases, inactive work-type references, and invalid byte limits fail.
- Work-type `phaseOverrides.<phase>.inputs` replaces the phase default.
- `record` warns for required unavailable/tampered input; `enforce` blocks it. Optional absent input is recorded as omitted, while optional present-but-tampered input follows mode severity.
- Omitted `maxBytes` injects the complete UTF-8 artifact. Explicit limits truncate safely and report source/injected byte counts.
- Repeated prepare replaces only the managed marker block and preserves authored content. `--dry-run` writes nothing.
- Publication recollects inputs and writes the correct final-generation audit. The gate detects missing records, producer hash changes, and rendered-block changes with warning/error severity by mode.
- Feature, bugfix, and chore profiles carry their complete input chains through verification and conformance.

## Remote agent Markdown checks

- Only exact dependency tables are parsed; ordinary prose links remain inert. Malformed tables, duplicate IDs, HTTP/private literal hosts, credentials, unknown URL tokens, escaping targets, invalid UTF-8, empty content, redirect overflow, and limits above 10 MiB fail.
- First `agents lock` and every `--update` require exact interactive agent-name confirmation. Non-interactive first trust fails.
- Lock entries preserve agent source hashes, original/resolved URLs, resource hashes, bytes, and timestamps. Sync never changes the lock and reuses only a hash-valid cache.
- A changed agent or changed remote resource fails sync until deliberate lock update. No agent dependency headings and local-only templates perform no network access.
- Remote skills match active phase and persona, enter only that agent's prompt, and create committed per-generation snapshots/audits rather than slash commands.
- An explicit `agent:<agent>/<template>` reference enforces phase scope and is copied into immutable work-item context before generation.
- Dynamic outputs encode only allowed variables, remain under `artifacts/<phase>/`, fetch once per prospective generation, reuse snapshots, preserve local edits, and require refresh plus `--replace` before overwrite.
- Agent sync preserves the persona session. Nextsteps reports stale locks, required sync, enforced input work, and remote-output conflicts.
- Electron lists repository/bundled agents, edits only repository Markdown, displays lock status read-only, and publishes agent configuration through the validated path.

## Progress and supporting-document checks

- `progress` reports zero at start, exact approved/total percentage after each approval, and 100% only when every phase is approved. Human-readable output includes the connected arrow map and marks the current phase; JSON remains machine-readable without presentation text.
- The plugin declares `extensions/`; with Copilot experimental extensions enabled, bare `/documents` opens the Documents canvas and `/documents view <ID>` selects an artifact. A non-canvas host receives timeline output instead.
- JSON progress includes current phase/position, generations, approval thresholds, document count, and token usage.
- Upload local text, image, PDF, and `.fig` inputs during an allowed phase; verify stable `DOC-nnn` IDs, hashes, attribution, copied paths, commit, and push.
- Record a Figma HTTPS link and confirm it is cataloged without network download.
- `documents list` includes uploaded inputs plus generated workflow/source/status documents.
- `documents view` prints text and returns usable paths/URLs for binary or external documents.
- Upload outside `documents.allowedPhases` and above `maxFileBytes` fails without a lifecycle commit.

## Workflow report checks

- Markdown, JSON, and script-free HTML reports derive from committed workflow state without changing lifecycle state.
- Phase timing pairs submissions with approvals/rejections even when history input is not already ordered.
- An awaiting-approval phase counts its open waiting interval through report generation.
- Rework generations, rejection history, self-approval warnings, quality-check duration, and the approval-latency bottleneck are present.
- Durations explicitly state that they are wall-clock values including nights and weekends.
- Exact token records are totaled; unavailable records remain disclosed and are never estimated.
- Optional per-million model pricing rejects negative values, prices only exact records for matching model names, and labels incomplete coverage as partial.
- `--out` writes the requested format but does not mutate workflow state, commit, or push.

## Approval checks

- Only a persona whose `mayApprove` includes the phase can approve or reject it.
- Approval records include authenticated identity, selected persona, timestamp, channel, and decision.
- Multi-approval thresholds ignore repeat decisions by the same identity.
- Self-approval is allowed but appears in the artifact, approval record, status, and conformance report.
- Rejection can target only an allowed earlier phase and invalidates target/downstream approvals.
- Concurrent terminal decisions cannot force-push over each other.

## Traceability checks

- Requirements use stable `AC-n` identifiers.
- Feature implementation specs and bugfix fix specs use stable `SPEC-nnn` identifiers mapped to acceptance criteria.
- Verification contains test/source evidence.
- Conformance reports every AC and SPEC item with `matched`, `partial`, `missing`, `deviated`, or `unplanned` and exact file/line evidence.
- The conformance report discloses approved deviations and self-approvals.
- A tracked source/test change after conformance makes the report stale and fails the gate.

## Token checks

- Exact provider usage preserves provider, model, input/output/cached/total counts, timestamps, and collection source.
- Missing provider values are recorded as `unavailable`, never guessed.
- Aggregates are correct by phase, persona, work type, and work item.
- Report costs are absent unless the exact model has configured pricing; unavailable usage never becomes a zero-cost estimate.

## World-model checks

- The builder runs in an isolated detached worktree; source writes, history changes, escaping paths, symlinks, malformed manifests, missing declared files, and undeclared output files are rejected.
- A successful build records the repository source-tree hash and creates/publishes a dedicated model commit. Model and lifecycle commits alone do not cause false staleness.
- Phase-required views are always present.
- Persona views are added and do not replace required views.
- The persona prompt is present in phase context.
- Exact task guides are loaded when requested; mismatched task text fails with a rebuild instruction.
- Need-based injection rules match persona, phase, work type, committed/pending changed paths, and source labels; applied context is byte-bounded.
- Verification and conformance include the evidence ledger.
- `singularity-flow wm check` detects a stale manifest.
- `wm compose` records provenance and the exact rendered prompt. `off`, `warn`, and `enforce` modes produce the configured gate severity, and enforce mode verifies the persona, manifest/source hashes, required views, committed model files, and prompt hash.

## Final GitHub checks

Install the example approval and validation workflows, pin the released package version, and configure branch protection to require the validation job. Exercise both comment forms:

```text
/approve design as architect
/reject design as architect --to requirements --reason "Missing failure behavior"
```

Confirm the workflow actor and declared persona appear in committed decision records and that the final terminal gate verifies the remote head.

## Configurable sequence gates

- A workflow without `sequenceGates` resolves every named gate to `hard`.
- Global modes and work-type overrides resolve correctly and are pinned into new work-item state.
- Invalid modes and unknown gate names fail configuration validation.
- Hard violations exit with code `2` without changing state, session, Git history, or remote state.
- Soft violations require the exact interactive `continue` response; refusal and non-interactive execution stop without mutation.
- A confirmed exception records the authenticated identity, selected persona, prior state, reason, action, and timestamp.
- Status, artifact metadata, performance reports, Electron, and governance output visibly disclose confirmed exceptions.
- Mutating the pinned gate policy after creation fails workflow validation.
- Copilot agent and skill instructions never self-confirm a soft warning.
