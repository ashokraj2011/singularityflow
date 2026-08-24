/**
 * Per-command help, in the shape of a man page.
 *
 * Two rules hold this together, both of them reactions to how help went wrong here before.
 *
 * The synopsis is never restated. It is read out of `HELP`, which is the overview every user
 * already sees, so a command cannot describe itself one way in the listing and another on its own
 * page. The `HELP.md` reference had drifted far enough to list six subcommand families that did not
 * exist and to name four flags no code read; duplicating the synopsis a third time would have been
 * the same mistake with more surface.
 *
 * And a command with no authored page still gets a page — its real synopsis, plus a plain statement
 * that the detail has not been written yet. A help system that answers "unknown command" for
 * something the CLI happily runs teaches people not to trust it.
 */
import { HELP } from './help-text.mjs';
import { canonicalCommand, commandDefinition, COMMAND_REGISTRY } from './command-registry.mjs';
import { skillsForCommand } from './command-skills.mjs';

const BIN_ALIASES = new Map([
  ['about', ['sflow-about']],
  ['inbox', ['sflow-inbox']],
  ['next', ['sflow-next']],
  ['agent', ['sflow-agent']],
  ['reset-all', ['sf-reset-all']],
  ['local-reset', ['sf-local-reset']],
  ['reinstall', ['sf-reinstall']],
  ['wm', ['sflow-wm-minimal']]
]);

function usagePrefixes(command) {
  const definition = commandDefinition(command);
  const names = [command, ...(definition?.aliases ?? [])];
  // `sflow` is the short bin name and the usage block uses it interchangeably, so a command
  // documented only as `sflow reset-all` must still resolve to a synopsis.
  return [
    ...names.flatMap((name) => [`singularity-flow ${name}`, `sflow ${name}`]),
    ...(BIN_ALIASES.get(command) ?? [])
  ];
}

/** The `Usage:` listing, which runs until the next column-zero heading. */
function usageSection(lines) {
  const start = lines.findIndex((line) => line === 'Usage:');
  if (start < 0) return lines;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S.*:\s*$/.test(line));
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * The synopsis lines `HELP` already publishes for a command, with their continuation lines.
 *
 * A usage line is two-space indented; anything indented further immediately after it continues it.
 */
export function synopsisFor(command) {
  const prefixes = usagePrefixes(command);
  const matches = (line) => prefixes.some((prefix) => line === `  ${prefix}` || line.startsWith(`  ${prefix} `));
  // Only the `Usage:` listing. The sections after it — the Jira environment, the worked "Typical
  // flow" — contain invocations too, and scanning the whole document pulled a walkthrough step into
  // `start`'s synopsis as though it were a distinct form of the command.
  const lines = usageSection(HELP.split('\n'));
  const collected = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!matches(lines[index])) continue;
    collected.push(lines[index].slice(2));
    for (let next = index + 1; next < lines.length; next += 1) {
      const continuation = lines[next];
      if (!/^ {4,}\S/.test(continuation) || matches(continuation)) break;
      collected.push(continuation.trim());
      index = next;
    }
  }
  return collected;
}

/**
 * Authored detail. Everything here is prose a synopsis line cannot carry: what the command is for,
 * what it refuses and why, and a worked example. Commands absent from this map still render.
 */
const PAGES = Object.freeze({
  auto: {
    summary: 'Plan and start bounded, hash-ratified work in an isolated managed worktree.',
    description: [
      'Auto is opt-in repository policy. Planning may use a model to propose scope, but the kernel',
      'revalidates every field and creates no Story, branch, worktree, approval, or authorization.',
      'Starting requires the exact SHA-256 printed on the Plan and revalidates all pinned inputs.',
      '',
      'This release is the single-repository Story-rail pilot. It creates the governed Story and',
      'then pauses at a checkpoint. It never answers clarification, approves, waives policy, retries',
      'a failed model attempt, expands scope, merges, deploys, or silently resumes.'
    ],
    options: [
      ['--work-type ID', 'Select an Auto-eligible Story work type.'],
      ['--from-branch BRANCH', 'Pin one branch that is currently published by every selected repository.'],
      ['--pace MODE', 'continuous, phase, or interval:DURATION; policy may only restrict it.'],
      ['--until SELECTOR', 'first-human-boundary, story-complete, or a phase publication/submission/completion boundary.'],
      ['--confirm HASH', 'Exact Plan or checkpoint hash; stale and partial confirmations are refused.'],
      ['--json', 'Emit the complete Plan or flight record.']
    ],
    examples: [
      ['singularity-flow auto plan "Add bounded retry telemetry" --work-type feature --from-branch main', 'Creates only a machine-local Plan.'],
      ['singularity-flow auto start APL-... --confirm sha256:...', 'Creates the Story only after exact Plan ratification.']
    ],
    seeAlso: ['start', 'impact', 'status', 'goal']
  },
  receipt: {
    summary: 'Replay a compact, deterministic evidence receipt for the latest submitted phase.',
    description: [
      'The receipt is composed from the durable review packet and governed Story records. It does',
      'not create a second evidence store and does not trust machine-local state. The same packet',
      'therefore produces the same receipt hash in a fresh clone.',
      '',
      'Use the default text for a quick review, Markdown for a pull-request or handoff summary, and',
      'JSON when another tool needs the exact availability and integrity fields.'
    ],
    options: [
      ['--work-id ID', 'Select a Story when the current branch is not its governed branch.'],
      ['--packet SHA256', 'Replay a specific retained review packet instead of the latest one.'],
      ['--markdown', 'Render the receipt as bounded Markdown.'],
      ['--json', 'Emit the complete deterministic receipt and its receiptSha256.']
    ],
    examples: [
      ['singularity-flow receipt show --work-id WRK-19', 'Show the latest changes, checks, approvals, context, and publication evidence.'],
      ['singularity-flow receipt show --work-id WRK-19 --markdown', 'Produce a review-ready Markdown summary.']
    ],
    seeAlso: ['status', 'approvals', 'report', 'ledger']
  },
  telemetry: {
    summary: 'Inspect and control privacy-safe local usage capture for SFlow-owned agent launches.',
    description: [
      'Telemetry is provisioned per launch only when Singularity Flow owns the Copilot CLI process.',
      'Each launch receives a separate file under the Git common directory. Prompts, responses,',
      'source, tool arguments, tool results, and paths touched by the agent are excluded.',
      '',
      'The first metered launch requires a machine-local disclosure. Existing OTLP endpoints and',
      'authentication settings are preserved; conflicts make usage unavailable without blocking',
      'the Story. Native IDE chat remains usable but is not attributed to a launch in this build.'
    ],
    options: [
      ['--story ID', 'Limit status to launches attributed to this Story.'],
      ['--confirm "ENABLE LOCAL USAGE"', 'Accept the current metadata-only disclosure non-interactively.'],
      ['--json', 'Emit capability, preference, launch coverage, and reconciliation details.']
    ],
    examples: [
      ['singularity-flow telemetry status', 'Show captured, partial, unavailable, conflict, and disabled launch coverage.'],
      ['singularity-flow telemetry probe --json', 'Inspect supported CLI, VS Code, and JetBrains host modes.'],
      ['singularity-flow telemetry enable', 'Review and accept the local collection disclosure.'],
      ['singularity-flow telemetry disable', 'Disable capture for future SFlow-owned launches without affecting work.']
    ],
    seeAlso: ['copilot', 'workspace', 'doctor', 'report']
  },
  context: {
    summary: 'Inspect exactly what SFlow supplied, omitted, expanded, and could not observe.',
    description: [
      'Context X-Ray is a read-only projection over content-free machine-local Evidence Packet',
      'telemetry and governed phase usage. It never invokes a model, expands a sealed handle,',
      're-runs a tool, reconciles telemetry, or changes lifecycle state.',
      '',
      'Provider observations remain separate from SFlow byte measurements and token estimates.',
      'Every unavailable value stays unavailable; omitted context is not described as tokens saved.'
    ],
    options: [
      ['--work-id ID', 'Inspect a governed Story other than the one active on this branch.'],
      ['--phase ID', 'Limit the projection to one phase.'],
      ['--packet CTX-ID', 'Inspect one retained content-free packet observation.'],
      ['--profile ID', 'Compile with one approved profile from the pinned token-economy policy.'],
      ['--json', 'Emit every status, assurance, provenance source, and safe remediation.']
    ],
    examples: [
      ['singularity-flow context xray PAY-1187', 'Show the current phase context and provider coverage.'],
      ['singularity-flow context xray --work-id PAY-1187 --phase implementation --json', 'Read one phase without reconciling or expanding anything.'],
      ['singularity-flow context compile PAY-1187 --slice evidence --json', 'Compile one bounded packet and retain only content-free local accounting.'],
      ['singularity-flow context expand sfref:...', 'Resolve one packet-bound sealed expansion and account for it.'],
      ['singularity-flow context doctor', 'Inspect the pinned default mode, profile, and feature switches without a model.']
    ],
    seeAlso: ['tokens', 'telemetry', 'session', 'report']
  },
  tokens: {
    summary: 'Read the content-free Token Ledger with field-level status and assurance.',
    description: [
      'The Token Ledger joins governed phase usage to SFlow-controlled packet measurements without',
      'recording prompts, completions, source, tool arguments, or tool results. Requested and',
      'resolved models remain separate, and missing cache fields never become zero.',
      '',
      'Status, report, and compare are read-only. Compare reuses the pre-registered IMP study and',
      'classifies improved, inconclusive, cheaper-but-worse, no-improvement, or unavailable.'
    ],
    options: [
      ['--work-id ID', 'Read a governed Story other than the one active on this branch.'],
      ['--phase ID', 'Limit provider and packet totals to one phase.'],
      ['--packet CTX-ID', 'Limit packet context to one retained observation.'],
      ['--json', 'Emit per-model and aggregate metric envelopes.']
    ],
    examples: [
      ['singularity-flow tokens status PAY-1187', 'Show provider, cache, and SFlow context coverage.'],
      ['singularity-flow tokens report --work-id PAY-1187 --phase implementation --json', 'Emit per-model observations without zero-filling unavailable fields.'],
      ['singularity-flow tokens compare --study context-packet-pilot', 'Classify a quality-gated IMP comparison without turning lower quality into savings.']
    ],
    seeAlso: ['context', 'telemetry', 'progress', 'report']
  },
  copilot: {
    summary: 'Launch Copilot CLI in the active workspace repository with governed context and consented local usage capture.',
    description: [
      'This is the short form of `singularity-flow workspace copilot`. It resolves the active',
      'workspace repository, starts the normal Copilot CLI without changing its interaction model,',
      'and provisions a unique metadata-only telemetry stream when the user has accepted disclosure.',
      '',
      'It never changes lifecycle state. Existing telemetry configuration is preserved; a conflict',
      'or unsupported host launches normally and reports usage as unavailable.'
    ],
    options: [
      ['--mode interactive|plan', 'Start the normal interactive CLI or Copilot Plan mode.'],
      ['--repository ID', 'Select a repository from the active multi-repository workspace.'],
      ['--story ID', 'Attach the launch to an explicitly selected Story.'],
      ['--host HOST', 'Declare the SFlow-owned terminal host for capability reporting.'],
      ['--dry-run', 'Show command, working directory, and telemetry qualification without launching.']
    ],
    examples: [
      ['singularity-flow copilot', 'Continue in the selected workspace repository.'],
      ['singularity-flow copilot --mode plan --dry-run', 'Preview a governed Plan-mode launch.']
    ],
    seeAlso: ['workspace', 'session', 'telemetry', 'home']
  },
  journal: {
    summary: 'Review private machine-local work memory without creating governance evidence.',
    description: [
      'The local work journal records a bounded set of outcome facts beside the machine workspace',
      'registry. It never stores prompts, source bytes, command output, credentials, or raw activity,',
      'and it never uploads or stages journal data.',
      '',
      'Today and doctor are read-only. Refresh observes only local Git refs and worktree facts; it',
      'does not fetch. Journal records are advisory return memory, never lifecycle evidence, approval',
      'authority, work-duration measurement, or a productivity score.'
    ],
    options: [
      ['--workspace ID', 'Use this registered workspace instead of the active selection.'],
      ['--date YYYY-MM-DD', 'Select a local calendar day for reading, deleting, or exporting.'],
      ['--mode MODE', 'Capture off, Singularity Flow outcomes only, workspace facts, or enhanced facts.'],
      ['--retention-days N', 'Keep 1 through 365 days of local records.'],
      ['--time-zone ZONE', 'Use an IANA time zone for day boundaries.'],
      ['--confirm VALUE', 'Exact date or DELETE LOCAL JOURNAL acknowledgement required for deletion.'],
      ['--dry-run', 'Render an export without writing it.'],
      ['--json', 'Emit the bounded versioned result.']
    ],
    examples: [
      ['singularity-flow journal today', 'Show at most three progress and attention summaries for today.'],
      ['singularity-flow journal refresh --json', 'Record one offline, content-bounded repository observation.'],
      ['singularity-flow journal delete --date 2026-08-19 --confirm 2026-08-19', 'Delete one local day after exact confirmation.']
    ],
    seeAlso: ['home', 'status', 'logs', 'local-reset']
  },
  push: {
    summary: 'Inspect and safely retry exact pre-Story push intents.',
    description: [
      'Transport intents preserve the exact local commit, configured remote, expected prior remote',
      'state, and destination ref for pushes outside Story publication. Status is offline with',
      'respect to mutation: it never retries or changes a remote.',
      '',
      'Retry first reads the remote target. It recognizes an already-completed push, refuses remote',
      'divergence, uses an exact commit-to-ref refspec, never force-pushes, and preserves the local',
      'commit when the outcome cannot be proved.'
    ],
    options: [
      ['--all', 'Include succeeded transport intents in the status list.'],
      ['--json', 'Emit the integrity-verified intent record.']
    ],
    examples: [
      ['singularity-flow push status', 'List unresolved pre-Story publication intents.'],
      ['singularity-flow push retry psh_…', 'Re-observe the target and retry only when it is proven safe.']
    ],
    seeAlso: ['workspace', 'sync', 'doctor']
  },
  goal: {
    summary: 'Manage personal outcomes and repository-owned governed Goal Executions.',
    description: [
      'GOL-* Goals are workspace-scoped personal advisory records. GEX-* Goal Executions are',
      'repository-owned contracts with typed success oracles, immutable plan generations, exact-hash',
      'approval, guided step attempts, and evidence on their own lifecycle branch.',
      '',
      'Plan approval never approves linked work. run-next delegates one step to the existing Story or',
      'Initiative lifecycle, which retains its own gates and authority. Personal records and Git',
      'lifecycle branches—not chat or editor memory—are the two authoritative state planes.'
    ],
    options: [
      ['--success TEXT', 'Observable success criterion. Required for create; repeatable.'],
      ['--work-id ID', 'Link an existing governed Story or Initiative while creating the Goal.'],
      ['--kind story|initiative', 'Kind of governed work being linked. Defaults to story.'],
      ['--repository ID', 'Workspace repository containing the linked work. Defaults to the selected repository.'],
      ['--status active|achieved|abandoned|all', 'Filter the Goal list.'],
      ['--reason TEXT', 'Required explanation when abandoning a Goal.'],
      ['--note TEXT', 'Optional completion note; it is not proof or lifecycle approval.'],
      ['--mode governed', 'List repository-owned GEX lifecycle branches.'],
      ['--generation N', 'Select the exact governed plan generation for approval.'],
      ['--confirm PLAN-HASH|GOAL-ID', 'Exact plan hash or Goal ID required by the selected transition.'],
      ['--criterion CLAUSE-ID', 'Limit governed oracle evaluation or trace to one criterion.'],
      ['--json', 'Emit the versioned command result and complete Goal record.']
    ],
    examples: [
      ['singularity-flow goal create "Reduce checkout failures" --success "Retry checkout completes without hanging"',
        'Creates and selects a personal outcome Goal.'],
      ['singularity-flow goal link GOL-20260818-001 PAY-1187 --kind story --repository checkout',
        'Links existing governed work without changing that Story.'],
      ['singularity-flow goal next', 'Returns one grounded next action for the active Goal.'],
      ['singularity-flow goal govern GOL-20260818-001', 'Creates a separate repository-owned GEX identity without changing the personal Goal.'],
      ['singularity-flow goal plan approve GEX-… --generation 1 --confirm <PLAN-HASH>', 'Approves only the exact immutable governed plan envelope.']
    ],
    seeAlso: ['home', 'session', 'nextsteps', 'story', 'initiative']
  },
  bootstrap: {
    summary: 'Put an existing repository under governance without pushing to its protected branch.',
    description: [
      'Clones the repository and establishes two orphan branches: `sflow/config`, which carries the',
      'governed definition and this repository\'s capability, and `state`, the append-only ledger.',
      '',
      'Nothing is written to the application branch — not the definition, not a review branch, not a',
      'commit. `start` materializes the approved configuration from `sflow/config` into each Story',
      'branch, so a protected default branch is never a participant and there is no pull request to',
      'merge before work can begin.'
    ],
    options: [
      ['--capability ID', 'The capability this repository delivers. Required.'],
      ['--name TEXT', 'Human-readable capability name.'],
      ['--kind collection|delivery', 'Whether the capability collects work or delivers it.'],
      ['--into DIRECTORY', 'Where to clone. Defaults to a directory named after the repository.'],
      ['--grounding off|warn|enforce', 'World-model grounding policy. Defaults to warn, which reports without blocking; enforce refuses to publish a phase with no grounding.'],
      ['--no-push', 'Do everything locally and push nothing.']
    ],
    examples: [
      ['singularity-flow bootstrap git@example.com:team/payments.git --capability payments --name Payments --kind delivery',
        'Establishes the configuration and ledger authorities; start work immediately afterwards.']
    ],
    seeAlso: ['init', 'capability', 'start']
  },
  start: {
    summary: 'Begin governed work on a Story and create its lifecycle branch.',
    description: [
      'Creates the Story branch from the application branch, pins the configuration and work-type',
      'resolution that will govern the whole Story, and publishes the opening commit.',
      '',
      'The resolution is pinned once, here. Later edits to the configuration do not reach a Story',
      'that has already started — they stop it instead, which is the point: what governed the work',
      'is what governed it when the work began.'
    ],
    options: [
      ['--work-type ID', 'Which workflow to run. Required when the terminal is not interactive.'],
      ['--title TEXT', 'Story title, when there is no tracker to read it from.'],
      ['--jira', 'Read the Story from Jira instead of the command line.'],
      ['--story-file FILE', 'Read the Story from a YAML file.'],
      ['--target-url URL', 'Exact authorized browser target. Required by the POC workflow and pinned into Story state.'],
      ['--base BRANCH', 'Cut from this branch instead of the configured default.'],
      ['--fetch', 'Fetch the remote before creating the branch.'],
      ['--json', 'Emit the created Story as JSON.']
    ],
    examples: [
      ['singularity-flow start PAY-1 --work-type feature --title "Add refunds"',
        'Starts a feature Story on branch PAY-1.'],
      ['singularity-flow start PAY-2 --jira --fetch',
        'Starts a Story from its Jira issue, refreshing remote branches first.']
    ],
    seeAlso: ['prepare', 'phase', 'submit', 'resume', 'status']
  },
  prepare: {
    summary: 'Materialise the current phase\'s artifact template so it can be filled in.',
    description: [
      'Writes the phase\'s required artifact from its template if it is not already there, and',
      'reports what the phase expects. Safe to run repeatedly; it never overwrites your work.'
    ],
    options: [['--json', 'Emit the structured command result, including the complete artifact path.']],
    examples: [['singularity-flow prepare intake', 'Prepares the intake artifact for the current Story.']],
    seeAlso: ['phase', 'artifact', 'nextsteps']
  },
  phase: {
    summary: 'Begin, inspect, or publish a governed phase generation.',
    description: [
      '`phase begin` establishes a code-generation boundary before source mutation. `phase publish`',
      'records a new generation: it registers the artifacts, captures authorship and model usage,',
      'and commits the result as one governed transition.',
      'Begin is local and idempotent: it creates no lifecycle event, commit, push, or ledger entry.',
      'Publish verifies and binds the exact generation-start receipt into artifact-generated.',
      '',
      'Publication refuses when the phase is not ready — a missing artifact, an unmet world-model',
      'grounding policy, or a phase out of sequence. Nothing is written when it refuses.'
    ],
    options: [
      ['--adopt-existing --confirm DIGEST', 'Explicitly adopt reviewed source that predates begin when Story policy permits it.'],
      ['--authored human|governed-agent|external-tool', 'Who produced the artifact. Record it explicitly.'],
      ['--from FILE', 'Import the artifact from a file authored elsewhere.'],
      ['--usage-json FILE', 'Attach model usage for a governed-agent generation.']
    ],
    examples: [
      ['singularity-flow phase begin implementation',
        'Creates or returns the open generation intent before implementation source changes.'],
      ['singularity-flow phase publish intake --authored human',
        'Publishes generation N+1 of the intake artifact.']
    ],
    seeAlso: ['prepare', 'submit', 'artifact', 'wm']
  },
  submit: {
    summary: 'Submit the current phase for approval and publish its review packet.',
    description: [
      'Builds a hash-bound review packet from the published generation and moves the phase to',
      'awaiting approval. Phases with no approval policy advance immediately.'
    ],
    examples: [['singularity-flow submit', 'Submits the current phase of the checked-out Story.']],
    seeAlso: ['approve', 'reject', 'review', 'story']
  },
  approve: {
    summary: 'Approve the phase awaiting review and advance the Story.',
    description: [
      'Records an approval decision against the exact artifact hashes that were submitted, advances',
      'to the next phase, and commits the decision as one governed transition.',
      '',
      'Approval is an outward, attributed act: it is recorded against your Git identity and the',
      'authority group that permits it, and self-approval is reported as such.'
    ],
    options: [
      ['--yes', 'Skip the interactive confirmation.'],
      ['--selection-receipt TOKEN', 'Approve using a Copilot selection receipt.']
    ],
    examples: [['singularity-flow approve --yes', 'Approves the phase currently awaiting review.']],
    seeAlso: ['submit', 'reject', 'reopen']
  },
  reject: {
    summary: 'Request changes and return the Story to an earlier phase.',
    description: [
      'Records a change request, invalidates every approval from the target phase onward, and',
      'returns the Story there. A reason is required.'
    ],
    options: [
      ['--reason TEXT', 'Why the change is needed. Required.'],
      ['--to PHASE', 'Which phase to return to. Defaults to the phase under review.']
    ],
    examples: [
      ['singularity-flow reject --reason "Acceptance criteria are ambiguous" --to requirements',
        'Sends the Story back to requirements with a recorded reason.']
    ],
    seeAlso: ['approve', 'reopen', 'submit']
  },
  report: {
    summary: 'Report on a Story: timing, usage, approvals — or the account of how it got here.',
    description: [
      '`--recap` renders the Story\'s history as readable beats, normalized from the lifecycle and',
      'operational event streams. It is the same account the pull-request body carries, and it is',
      'deterministic: the same history and the same locale and timezone produce identical output on',
      'any machine.'
    ],
    options: [
      ['--recap', 'Render the account of what happened instead of the metrics report.'],
      ['--length brief|standard|full', 'How much of the account to include. Brief keeps the beats that shape the story.'],
      ['--locale TAG', 'Rendering locale. Defaults to en-GB and is pinned, never read from the environment.'],
      ['--timezone ZONE', 'Rendering timezone. Defaults to UTC for the same reason.']
    ],
    examples: [
      ['singularity-flow report PAY-1 --recap --length brief', 'The shape of the Story in a few beats.'],
      ['singularity-flow report PAY-1 --recap --timezone Asia/Kolkata', 'The same beats, rendered in another zone.']
    ],
    seeAlso: ['status', 'progress', 'pr']
  },
  status: {
    summary: 'Show where a Story is and what it needs next.',
    examples: [
      ['singularity-flow status', 'Status of the checked-out Story.'],
      ['singularity-flow status PAY-1 --json', 'Machine-readable status of a named Story.']
    ],
    seeAlso: ['nextsteps', 'progress', 'doctor']
  },
  fault: {
    summary: 'Record and inspect immutable failure evidence without granting repair authority.',
    description: [
      'Creates a schema-versioned FaultEnvelope in the repository-local Git control plane. The',
      'report binds the observed build and commit, sanitizes evidence, computes its own deterministic',
      'signature, groups repeated occurrences, and preserves the caller identity snapshot.',
      '',
      'A fault is evidence only. This command cannot edit code, approve work, merge, push, release,',
      'deploy, or increase the action ceiling selected by repository policy.'
    ],
    options: [
      ['--from FILE', 'Read a complete FaultEnvelope v1 request from JSON.'],
      ['--source SOURCE', 'Adapter or surface that observed the failure.'],
      ['--environment ENV', 'local, ide, copilot, ci, integration, staging, or production.'],
      ['--type TYPE', 'Normalized compile, test, runtime, configuration, security, or other fault type.'],
      ['--command-argv JSON', 'Exact command argv as a JSON string array; preferred for Windows and machine callers.'],
      ['--log FILE', 'Sanitize and retain a local text log by immutable content hash. Repeatable.'],
      ['--idempotency-key KEY', 'Return the existing fault for a repeated identical report.'],
      ['--json', 'Emit the complete record or list.']
    ],
    examples: [
      ['singularity-flow fault report --source ci --environment ci --type unit-test --build 1842 --command "npm test" --exit-code 1 --log artifacts/test.log',
        'Records the failure and evidence; it does not start a repair.'],
      ['singularity-flow fault list --status repair-active', 'Lists faults with a current repair run.']
    ],
    seeAlso: ['fix', 'repair', 'run', 'regression']
  },
  fix: {
    summary: 'Diagnose a fault and create or preview its policy-bounded repair plan.',
    description: [
      'Runs deterministic diagnosis first, joins the exact baseline to changed paths and available',
      'governed records, computes the most restrictive effective action ceiling, and pins scope,',
      'verification and budgets before any repair worktree can be created.',
      '',
      'Diagnostic paths are evidence only. Mutation scope remains empty until at least one explicit',
      '`--allow-path` is reviewed. `--auto` is a request, never extra authority. It degrades to the policy ceiling, and this',
      'build refuses autonomous mutation unless a separately governed adapter is configured.'
    ],
    options: [
      ['--diagnose-only', 'Record deterministic facts and dispositions without creating a repair.'],
      ['--plan-only', 'Preview a hash-bound plan without storing a repair run.'],
      ['--allow-path PATH', 'Explicit repository-relative repair scope. Repeatable.'],
      ['--verify COMMAND', 'Pinned argv-style verification command. Shell operators are refused. Repeatable.'],
      ['--verify-argv JSON', 'Exact verifier argv as a JSON string array. Repeatable and preferred across platforms.'],
      ['--max-attempts N', 'Reduce the configured attempt budget; it cannot raise it.'],
      ['--auto', 'Request bounded automation; policy may only reduce this request.'],
      ['--json', 'Emit diagnosis, plan and repair state.']
    ],
    examples: [
      ['singularity-flow fix FLT-1842-03 --diagnose-only', 'Shows observed facts separately from hypotheses.'],
      ['singularity-flow fix FLT-1842-03 --plan-only --allow-path src/payment --verify-argv \'["npm","test","--","payment"]\'',
        'Previews a bounded guided plan and writes nothing.']
    ],
    seeAlso: ['fault', 'repair', 'regression', 'constitution']
  },
  repair: {
    summary: 'Authorize, inspect, attempt, or cancel an isolated governed repair.',
    description: [
      'Authorization is bound to the exact RepairPlan hash and creates a local repair branch and',
      'isolated worktree from the pinned baseline. A patch is checked for scope and safety before',
      'application, then the complete pinned verification set runs without a shell or network.',
      '',
      'Attempts, patches, output hashes, stop reasons and human decisions are immutable. Cancellation',
      'preserves the isolated worktree and never deletes or rewrites the developer checkout.'
    ],
    options: [
      ['--confirm PLAN-SHA256', 'Authorize exactly the plan shown by fix/status.'],
      ['--patch FILE', 'Candidate Git patch to validate, apply in isolation, and verify.'],
      ['--reason TEXT', 'Required cancellation reason retained in the repair receipt.'],
      ['--open', 'Open the newly authorized isolated worktree in VS Code.'],
      ['--json', 'Emit complete structured repair state and evidence.']
    ],
    examples: [
      ['singularity-flow repair authorize RPR-0042 --confirm 0123abcd...', 'Creates the isolated repair worktree only after exact authorization.'],
      ['singularity-flow repair attempt RPR-0042 --patch candidate.patch', 'Applies a contained candidate and runs every pinned verifier.']
    ],
    seeAlso: ['fix', 'fault', 'status', 'review']
  },
  approvals: {
    summary: 'Show the Story approval chain with every phase document and human decision.',
    description: [
      'Reads the pinned Story aggregate and joins the immutable phase order, required documents,',
      'authority groups, thresholds, and recorded approvers into one read-only view.',
      '',
      'The default view shows current approvals. JSON also retains invalidated earlier decisions,',
      'including their generation and invalidation time, without treating them as active.'
    ],
    options: [
      ['--json', 'Emit the versioned approval-chain projection, including current and invalidated decisions.']
    ],
    examples: [
      ['singularity-flow approvals PAY-1', 'Show each phase, its governed document, required authority, and approver.'],
      ['singularity-flow approval-chain PAY-1 --json', 'Read the same chain through the compatibility alias as structured data.']
    ],
    seeAlso: ['status', 'progress', 'inbox', 'review', 'approve']
  },
  nextsteps: {
    summary: 'List the actions that are valid right now, and the command for each.',
    description: [
      'Reads the governed state and reports only transitions the Story can actually take, so it is',
      'the fastest way out of "what am I allowed to do here".'
    ],
    examples: [['singularity-flow nextsteps PAY-1', 'Valid next actions for PAY-1.']],
    seeAlso: ['status', 'next', 'doctor']
  },
  recommend: {
    summary: 'Show one grounded next-step recommendation for the active developer context.',
    description: [
      'Combines My Work selection, recovery priority, and the ordered lifecycle guidance into one',
      'read-only answer. It explains the active workspace, Story, phase, evidence already captured,',
      'preflight state, expected effects, and whether explicit authorization will be required.',
      '',
      'The displayed command is a preview, never ambient execution authority. Use `next` only after',
      'reviewing the recommendation and explicitly deciding to carry out one lifecycle action.'
    ],
    options: [
      ['--workspace ID', 'Read the selected registered workspace instead of the current active one.'],
      ['--json', 'Emit the shared `developer.next` result used by VS Code and Copilot.']
    ],
    examples: [['singularity-flow recommend', 'The one recommended next step for the active workspace and Story.']],
    seeAlso: ['home', 'nextsteps', 'next', 'doctor']
  },
  doctor: {
    summary: 'Diagnose the repository, the Story, and the tooling around them.',
    description: [
      'Reports on Git identity, remote access, model provider availability, platform shell support,',
      'the capability ledger, and the governed state of the current Story. Exits non-zero when it',
      'finds something blocking.'
    ],
    options: [
      ['--offline', 'Skip checks that contact configured remotes.'],
      ['--performance', 'Run the explicit read-only monorepo benchmark and report actionable scope/clone recommendations.'],
      ['--json', 'Emit the complete diagnostic and optional performance measurements as JSON.']
    ],
    examples: [
      ['singularity-flow doctor', 'Full diagnosis of the current repository.'],
      ['singularity-flow doctor --offline', 'Skip every check that needs the network.'],
      ['singularity-flow doctor --performance', 'Measure warm Git status and scoped world-model fingerprint cost for a large repository.'],
      ['singularity-flow doctor --fix telemetry', 'Review and repair only the machine-local SFlow usage-capture preference.']
    ],
    seeAlso: ['validate', 'gate', 'status']
  },
  pr: {
    summary: 'Preview or open the pull request for a Story.',
    description: [
      'Builds the pull-request body entirely from governed state — the approved artifacts and the',
      'hashes they were approved at — and targets the Epic branch when the Story belongs to one.',
      '',
      'Preview is the default. Opening it requires --create and a typed confirmation, because it is',
      'an outward action. Requires the GitHub CLI.'
    ],
    options: [
      ['--create', 'Actually open the pull request.'],
      ['--yes', 'Skip the typed confirmation.'],
      ['--json', 'Emit the plan as JSON.']
    ],
    examples: [
      ['singularity-flow pr PAY-1', 'Preview the pull request without opening it.'],
      ['singularity-flow pr PAY-1 --create', 'Open it, after confirming.']
    ],
    seeAlso: ['submit', 'epic', 'stack']
  },
  wm: {
    summary: 'Build, inspect, and compose the repository world model that grounds each phase.',
    description: [
      'The world model is the grounding a phase is checked against. `wm build` invokes the',
      'configured model provider; every other subcommand is deterministic and needs no model.',
      'Discovery routes through the `analyze` task and final synthesis through `reason` in',
      '`singularity/modelTiers.yml`. `--model` is an explicit caller-named compatibility override.',
      '',
      'If a phase refuses to publish with "grounding is not ready", this is the command that fixes',
      'it — and note that the grounding policy is pinned from the configuration branch, not from the',
      'branch you are standing on.'
    ],
    examples: [
      ['singularity-flow wm build --depth quick', 'Build the world model at quick depth.'],
      ['singularity-flow wm compose --phase intake', 'Compose the grounding for a phase.'],
      ['singularity-flow wm light --local', 'Deterministic lightweight model, no provider needed.'],
      ['singularity-flow wm ast context --paths src --max-facts 50 --max-output-bytes 32768 --json', 'Read a bounded, page-continuable structural context without invoking a model.'],
      ['singularity-flow wm ast query --predicate symbol --value PaymentService --paths src --json', 'Find a bounded declaration/signature page from a text preview or installed parser provider.'],
      ['singularity-flow wm ast pack doctor sflow-polyglot-syntax', 'Inspect the legacy-named bundled Java/Python/Kotlin/Swift structural preview and its text assurance ceiling.'],
      ['singularity-flow wm ast warm --semantic --provider sflow-java-jdt --profile default --project maven:. --dry-run', 'Preview the exact offline project-model and toolchain commands before creating a semantic binding.'],
      ['singularity-flow wm ast evidence reproduce --receipt singularity/work-items/WRK-1/context/ast/intake-gen1.json --json', 'Reproduce durable structural evidence from exact Git objects and retained toolchain bytes, without using the cache or a model.'],
      ['singularity-flow wm recovery list', 'List validated snapshots retained after publication failure.'],
      ['singularity-flow wm recovery publish 1720000000000-abcd-intake --confirm 1720000000000-abcd-intake', 'Republish retained validated bytes without another provider call.'],
      ['singularity-flow wm ast doctor', 'Show effective AST policy, scope, cache, and optional adapter health.']
    ],
    seeAlso: ['phase', 'doctor', 'capability']
  },
  epic: {
    summary: 'Run an Epic: sources, planning, Story creation, merge order, and completion.',
    description: [
      'An Epic governs a set of Stories across one or more repositories. Its own lifecycle mirrors a',
      'Story\'s — phases, submission, approval — and it additionally owns the merge sequence its',
      'Stories must follow.'
    ],
    examples: [
      ['singularity-flow epic start MOB-100', 'Start an Epic from its tracker issue.'],
      ['singularity-flow epic jira preview', 'Preview the Story-creation plan. Writes nothing.'],
      ['singularity-flow epic merge-plan --json', 'The order the Stories must merge in.'],
      ['singularity-flow epic pr --epic MOB-100', 'Preview the Epic pull request into the default branch.']
    ],
    seeAlso: ['story', 'stack', 'pr', 'initiative']
  },
  workspace: {
    summary: 'Manage the set of repositories you work across, and which one is active.',
    description: [
      'Use `workspace prepare` for a recoverable first-time setup. It writes an integrity-checked',
      'machine-local bootstrap record, checks the runtime, destination, disk, registry and remote',
      'branches without writing the workspace destination, and returns a bootstrap ID.',
      '',
      '`workspace bootstrap resume` reruns the preflight immediately before handing the plan to the',
      'existing staged-clone transaction. Authentication, network, occupied-target and missing-branch',
      'failures remain attached to the same session; credentials and raw Git stderr are not persisted.',
      '',
      '`workspace doctor` is local by default. Add `--network` only when you explicitly want it to',
      'probe the remotes referenced by unfinished bootstrap sessions. It reports only whether',
      'enterprise proxy and CA sources exist; it never prints their values or suggests disabling TLS.',
      '',
      '`workspace adopt` is the explicit path for an existing clone. Its dry-run records canonical',
      'location, origin, branch, HEAD-related state, worktrees, submodules, SFlow configuration and',
      'a content-aware dirty-tree hash. Adoption creates a separate workspace shell and does not',
      'fetch, checkout, stash, commit, reset, clean, or edit the clone remote.',
      '',
      '`workspace refresh-configuration` discovers every unique repository in registered',
      'non-archived workspaces. It prepares package updates in isolated clones, three-way merges',
      'against the recorded package baseline, publishes `sflow/config`, and then mirrors the exact',
      'approved files at their canonical paths on the orphan state branch. The manifest records the',
      'source commit, product revision, and hashes. Runtime state such as world models is preserved,',
      'and existing Story snapshots never move.'
    ],
    options: [
      ['--id ID', 'Portable local workspace identifier used by prepare.'],
      ['--base DIRECTORY', 'Parent directory; preflight checks it before destination creation.'],
      ['--branch BRANCH', 'Explicit remote branch. When omitted for a single remote, its advertised HEAD is used.'],
      ['--initialize', 'Plan governed state-branch initialization after successful materialization.'],
      ['--network', 'Allow workspace doctor to contact pending-session remotes.'],
      ['--confirm ID', 'Exact workspace ID required before a bootstrap session may materialize.'],
      ['--confirm-dirty SHA256', 'Content-bound acknowledgement required to retain a dirty adopted clone.'],
      ['--dry-run', 'Preview configuration refresh for every selected repository without changing a ref.'],
      ['--repository ID', 'For configuration refresh, limit work to this repeatable repository ID.'],
      ['--resolve PATH=CHOICE', 'Resolve one reported conflict as local, bundled, or merge; repeat for additional paths.'],
      ['--confirm-plan ID', 'Apply only if configuration and state authorities still match a previously previewed plan.'],
      ['--accept-bundled-conflicts', 'Explicitly select packaged values where both package and repository changed the same field or asset.'],
      ['--json', 'Emit the structured session, preflight, findings, and recovery command.']
    ],
    examples: [
      ['singularity-flow workspace list', 'Every registered workspace.'],
      ['singularity-flow workspace use payments', 'Make a workspace the active one for this session.'],
      ['singularity-flow workspace prepare https://git.example/payments.git --id payments', 'Record and preflight setup without creating the destination.'],
      ['singularity-flow workspace bootstrap resume bst_… --confirm payments', 'Recheck and materialize the exact recorded plan.'],
      ['singularity-flow workspace adopt ~/src/payments --id payments --dry-run', 'Inspect an existing clone and preview the preserving workspace shell.'],
      ['singularity-flow workspace doctor --network', 'Diagnose machine state and unfinished-session remotes without changing them.'],
      ['singularity-flow workspace refresh-configuration --dry-run', 'Preview package/configuration drift across every registered repository.'],
      ['singularity-flow workspace refresh-configuration payments --resolve singularity/templates/feature/spec.md=bundled --confirm-plan cfgp-…', 'Apply reviewed choices only while the preview remains current.'],
      ['singularity-flow workspace refresh-configuration payments', 'Refresh one registered workspace and verify each state mirror.']
    ],
    seeAlso: ['capability', 'session', 'bootstrap']
  },
  capability: {
    summary: 'Map, review, and publish the capabilities an organisation governs.',
    description: [
      'Capability changes are proposed on a review branch and merged, never written straight to the',
      'configuration authority. `capability map` proposes; `capability activate` merges an approved',
      'proposal, records its audit event, and mirrors the result to the state branch.',
      '',
      'Local `add`, `set`, and `remove` author the checkout only. Organisation reads prefer the state',
      'mirror and use a commit-validated cache; pass `--refresh` for an explicit remote recheck.',
      '',
      'A capability stores one parent link; the reverse child list is derived from it. Removing a',
      'parent with children requires `--reparent-children-to`, so the move and removal validate and',
      'publish as one proposal. An empty destination moves direct children to the top level.',
      '',
      'For monorepos, source/shared roots bound world-model grounding. A blobless or blobless-sparse',
      'clone policy bounds what new workspaces download; sparse mode always retains governed files.'
    ],
    examples: [
      ['singularity-flow capability map payments --repository payments-api', 'Propose a capability.'],
      ['singularity-flow capability map payments --repository <URL> --source-roots apps/payments --clone-mode blobless-sparse --sparse-cone apps/payments --clone-fallback refuse', 'Propose a scoped capability and safe monorepo clone policy.'],
      ['singularity-flow capability edit legacy --lead <URL> --mode remove --reparent-children-to platform', 'Remove a capability and atomically relink its direct children.'],
      ['singularity-flow capability organisation --refresh', 'Refresh the approved organisation map.'],
      ['singularity-flow capability tree', 'The capability map as a tree.']
    ],
    seeAlso: ['capabilities', 'workspace', 'bootstrap']
  },
  ledger: {
    summary: 'Inspect and repair the append-only capability ledger.',
    description: [
      'The ledger is an orphan branch with no shared ancestry with application branches, and it must',
      'never be merged into one. Every governed publication appends to it.',
      '',
      'When a publication reports that its ledger mirror is pending, `ledger reconcile` is what',
      'completes the attestation. When a clone cannot reach a recorded source pin, `ledger repair`',
      'classifies the cause and safely repairs its local refspec and pin cache.',
      '',
      'A missing remote pin is never recreated silently. The restore form proves the exact source',
      'commit, dry-runs an explicit refspec, refuses mismatches, and requires the plan-hash phrase',
      'printed by a fresh preview.'
    ],
    options: [
      ['--offline', 'Verify only the local pin cache; never imply that the remote was checked.'],
      ['--source-remote REMOTE', 'Use a separately configured authoritative remote as a read-only source for missing pins.'],
      ['--dry-run', 'Classify each pin and print the hash-bound restoration preview without changing refs.'],
      ['--restore-remote', 'Publish only remotely missing refs after proof and exact confirmation; never overwrite a mismatch.'],
      ['--confirm TEXT', 'For remote restoration, supply the complete RESTORE LEDGER PINS <PLAN-SHA256> phrase from the preview.']
    ],
    examples: [
      ['singularity-flow ledger status', 'Ledger health and any unpublished intents.'],
      ['singularity-flow ledger verify', 'Verify the chain end to end.'],
      ['singularity-flow ledger repair --dry-run', 'Distinguish a missing ref from network, credentials, server policy, and local-cache problems.'],
      ['singularity-flow ledger repair --source-remote authority', 'Fetch exact recorded pins from a configured authority remote into the local cache.'],
      ['singularity-flow ledger reconcile', 'Publish intents that could not be appended earlier.']
    ],
    seeAlso: ['doctor', 'validate', 'sync']
  },
  reinstall: {
    summary: 'Cleanly replace only the locally installed Singularity Flow product surfaces.',
    description: [
      'Builds and validates the npm tarball and VSIX from the explicitly selected checkout before',
      'removing anything. It then replaces only the global npm package, the two known Copilot plugin',
      'identities, marker-owned direct skills, the VS Code extension, and the managed telemetry wrapper.',
      '',
      'This is deliberately not a repository command. It runs no Git command, discovers no workspace',
      'repository, and preserves repository state, workspace registrations, credentials, settings,',
      'personal skills, Node.js, npm, and unrelated global packages.'
    ],
    options: [
      ['--checkout DIRECTORY', 'The existing Singularity Flow source checkout to build exactly as it is.'],
      ['--dry-run', 'Build, test, package, and print the fingerprint-bound replacement preview.'],
      ['--confirm TEXT', 'Apply the exact confirmation printed by the matching preview.'],
      ['--registry URL', 'Use this npm registry/Artifactory for every npm subprocess.'],
      ['--cli-only', 'Replace only the global npm package; Copilot and VS Code may be unavailable.'],
      ['--no-copilot-telemetry', 'Do not recreate the installer-managed telemetry wrapper.']
    ],
    examples: [
      ['sf-reinstall --checkout /opt/src/singularityflow --dry-run', 'Validate everything and print the exact confirmation.'],
      ['sf-reinstall --checkout /opt/src/singularityflow --registry https://artifactory.example/api/npm/npm-virtual/ --confirm "REINSTALL SINGULARITY FLOW <fingerprint>"', 'Apply a previously reviewed, registry-bound preview.']
    ],
    seeAlso: ['factory-reset', 'local-reset', 'fresh-install']
  },
  'local-reset': {
    summary: 'Forget this machine’s Singularity Flow state, or deliberately delete its validated workspaces.',
    description: [
      'With `--forget-only`, clears machine registrations, capability caches, Singularity-named',
      'Copilot sessions, credentials, acknowledgements, onboarding and personalization while',
      'preserving every workspace directory, repository byte, branch, worktree and recovery record.',
      '',
      'Without `--forget-only`, the compatibility mode deletes each workspace directory only after',
      'its registry entry and regular workspace manifest prove the exact deletion boundary.',
      'Interactive terminals preview and ask for an exact mode-bound phrase. Scripts and JSON callers',
      'must preview with `--dry-run`, then provide `--confirm` in a separate invocation.'
    ],
    options: [
      ['--forget-only', 'Clear machine-local Singularity state while preserving physical workspaces and repositories.'],
      ['--dry-run', 'Print the complete mode-specific plan without changing anything.'],
      ['--confirm TEXT', 'Apply only when TEXT exactly matches FORGET LOCAL or RESET LOCAL for the selected mode.'],
      ['--json', 'Emit the schema-v2 plan/result; requires --dry-run or an explicit --confirm.']
    ],
    examples: [
      ['singularity-flow local-reset --forget-only --dry-run --json', 'Preview a safe machine-state cleanup.'],
      ['singularity-flow local-reset --forget-only --confirm "FORGET LOCAL"', 'Forget local state and preserve workspace bytes.'],
      ['singularity-flow local-reset --confirm "RESET LOCAL"', 'Delete validated registered workspaces and local state.']
    ],
    seeAlso: ['factory-reset', 'reset-all', 'reinstall']
  },
  validate: {
    summary: 'Check the governed state of the current Story against its pinned configuration.',
    examples: [['singularity-flow validate --strict', 'Fail on warnings as well as errors.']],
    seeAlso: ['gate', 'doctor', 'status']
  },
  gate: {
    summary: 'Run the release gate for the current Story and report whether it passes.',
    examples: [['singularity-flow gate', 'Evaluate every gate the Story must satisfy.']],
    seeAlso: ['validate', 'doctor', 'submit']
  },
  init: {
    summary: 'Initialise Singularity Flow inside a repository you already have.',
    description: [
      'Writes the governed definition, templates, and agent prompts. It stages and commits nothing —',
      'review what it wrote, then commit it yourself. Use `bootstrap` to govern a repository from its',
      'URL instead.'
    ],
    examples: [['singularity-flow init', 'Initialise governance in the current repository.']],
    seeAlso: ['bootstrap', 'doctor', 'start']
  },
  resume: {
    summary: 'Return to a Story already in flight.',
    examples: [['singularity-flow resume PAY-1 --fetch', 'Check out PAY-1, refreshing from the remote.']],
    seeAlso: ['start', 'status', 'inbox']
  },
  return: {
    summary: 'Return to a published Story on this machine from a verified durable locator.',
    description: [
      'Fetches the configured remote, resolves the Story from published governed state, and verifies',
      'its integrity-bound return locator before changing the checkout. It never scans arbitrary',
      'directories, stashes local work, resets a branch, or invents a repository from local memory.',
      '',
      'Preview first. Applying requires the exact Work ID and a clean worktree, creates or advances',
      'only the local Story branch by fast-forward, and then reconstructs the governed session.'
    ],
    options: [
      ['--apply', 'Apply the verified plan; without this flag the command is read-only.'],
      ['--confirm WORK-ID', 'With --apply, authorize only when the confirmation exactly matches the verified Story ID.'],
      ['--offline', 'Use the existing remote-tracking ref and report it as cached rather than fresh.'],
      ['--json', 'Emit the versioned read-only return plan.'],
      ['--agent ID', 'Select an allowed phase agent while reconstructing the local session.']
    ],
    examples: [
      ['singularity-flow return PAY-1', 'Verify the published Story and show the non-mutating return plan.'],
      ['singularity-flow return PAY-1 --apply --confirm PAY-1', 'Fast-forward the local PAY-1 branch and attach its governed session.']
    ],
    seeAlso: ['resume', 'session', 'home', 'sync']
  },
  story: {
    summary: 'Story-level operations: branches, intervals, convergence, intent amendments, checks, and finalisation.',
    examples: [
      ['singularity-flow story branch create --parent PAY-1 --name PAY-1-ui', 'Create a governed child branch.'],
      ['singularity-flow story intent-amendment propose --file amended-spec.md --reason "Retry policy changed"', 'Propose corrected intent for an update-intent finding without editing the approved specification.'],
      ['singularity-flow story checks PAY-1', 'Record configured repository-check evidence against the submitted packet.']
    ],
    seeAlso: ['start', 'submit', 'epic']
  },
  cancel: {
    summary: 'Cancel a Story and archive it, with a recorded reason.',
    options: [
      ['--reason TEXT', 'Why the work is being cancelled. Required.'],
      ['--confirm WORK-ID', 'Type the Work ID to confirm.']
    ],
    examples: [['singularity-flow cancel PAY-1 --reason "Superseded by PAY-9" --confirm PAY-1', '']],
    seeAlso: ['reopen', 'reject']
  },
  reopen: {
    summary: 'Reopen completed work and return it to an earlier phase.',
    options: [
      ['--reason TEXT', 'Why it is being reopened. Required.'],
      ['--to PHASE', 'Which phase to return to.']
    ],
    examples: [['singularity-flow reopen PAY-1 --to implementation --reason "Regression found"', '']],
    seeAlso: ['reject', 'cancel', 'approve']
  },
  sync: {
    summary: 'Recover an interrupted publication without losing prior work.',
    description: [
      'After a commit, sync retries its exact push. Before a commit, a dead transaction restores',
      'the integrity-bound preimage recorded in its local journal and preserves partial bytes in',
      '.git/singularity-flow/publication-rescues/. This includes first creation, phase preparation,',
      'document/evidence ingestion, telemetry reconciliation, approval, rejection, and publication.',
      'Recovery reads the subject journal before parsing a possibly damaged aggregate. A failed',
      'rollback retains that journal for another exact retry; a live command is never rolled back.'
    ],
    examples: [['singularity-flow sync', '']],
    seeAlso: ['doctor', 'ledger', 'status']
  }
});

function section(title, body) {
  return body.length ? [title, ...body.map((line) => (line ? `    ${line}` : '')), ''] : [];
}

/**
 * Complete reference material for commands that do not need a hand-curated narrative.
 *
 * The synopsis remains the authority for accepted forms. This completion supplies the rest of a
 * useful man page without inventing flags or semantics, so a newly registered command cannot ship
 * with the old "detail has not been written" dead end.
 */
function catalogPage(command, definition, synopsis) {
  const classification = definition?.classification === 'read' ? 'read-only' : 'governed mutation';
  const flags = [...new Set(synopsis.flatMap((line) => [...line.matchAll(/--[a-z][a-z0-9-]*/g)].map((match) => match[0])))];
  const title = command.replaceAll('-', ' ');
  return {
    summary: `${title[0]?.toUpperCase() ?? ''}${title.slice(1)} — ${classification} command reference.`,
    description: [
      `This is a ${classification} command. Use only a form shown in SYNOPSIS; the command parser`,
      'refuses unknown forms rather than guessing. Read the linked topic before using an unfamiliar',
      'mutation, and re-read current state after it completes.'
    ],
    options: [
      ['--help', 'Show this command page without running the operation.'],
      ...flags.filter((flag) => flag !== '--help').map((flag) => [flag, 'Accepted only by the synopsis form that lists it.'])
    ],
    examples: [[synopsis[0] ?? `singularity-flow ${command} --help`, 'Start from the canonical form supported by this build.']],
    seeAlso: definition?.classification === 'read'
      ? ['home', 'help', 'explain']
      : ['home', 'status', 'doctor', 'nextsteps']
  };
}

/** Render one command's help in the shape of a man page. */
export function renderCommandHelp(name) {
  const command = canonicalCommand(name);
  const definition = commandDefinition(command);
  const synopsis = synopsisFor(command);
  const completion = catalogPage(command, definition, synopsis);
  const authored = PAGES[command] ?? {};
  const page = {
    ...completion,
    ...authored,
    description: authored.description ?? completion.description,
    options: authored.options ?? completion.options,
    examples: authored.examples ?? completion.examples,
    seeAlso: authored.seeAlso ?? completion.seeAlso
  };
  const aliases = definition?.aliases ?? [];

  const out = [
    'NAME',
    `    singularity-flow ${command}${page?.summary ? ` — ${page.summary}` : ''}`,
    ''
  ];
  out.push(...section('SYNOPSIS', synopsis.length ? synopsis : [`singularity-flow ${command} ...`]));
  out.push(...section('DESCRIPTION', page.description ?? [
    'Use the forms in SYNOPSIS. The engine validates the current repository, identity, policy, and',
    'arguments before it reads or changes state.'
  ]));
  if (page?.options?.length) {
    out.push(...section('OPTIONS', page.options.flatMap(([flag, detail]) => [flag, `  ${detail}`, ''])));
  }
  if (page?.examples?.length) {
    out.push(...section('EXAMPLES', page.examples.flatMap(([example, detail]) => (detail
      ? [`$ ${example}`, `  ${detail}`, '']
      : [`$ ${example}`, '']))));
  }
  if (aliases.length) out.push(...section('ALIASES', [aliases.join(', ')]));
  const skills = skillsForCommand(command);
  if (skills.length) {
    out.push(...section('COPILOT', [
      `Primary: /${skills[0]}`,
      ...(skills.length > 1 ? [`Specialized routes: ${skills.slice(1).map((skill) => `/${skill}`).join(', ')}`] : []),
      'Invoke the skill in Copilot; use a SYNOPSIS form in a terminal.'
    ]));
  }
  const related = page?.seeAlso ?? [];
  if (related.length) {
    out.push(...section('SEE ALSO', [related.map((item) => `singularity-flow ${item}`).join(', ')]));
  }
  out.push(...section('MORE', [
    `singularity-flow help ${command}   topic documentation, when one exists`,
    'singularity-flow --help            every command'
  ]));
  return `${out.join('\n').replace(/\n{3,}$/, '\n')}`;
}

/**
 * What `singularity-flow --help` shows.
 *
 * It used to print all 365 usage lines, and `singularity-flow help` printed 2,450 — two near-identical
 * invocations, six times apart, neither paged, and neither answering the question a newcomer actually
 * has. This answers that question in about a screen: where to start, what a governed change looks
 * like in order, and how to find the detail. The complete synopsis is one flag away.
 *
 * The groups are curated, not generated — the value here is the ordering and the omission. A check in
 * `scripts/check.mjs` asserts every command named below is a real registry command, so curation
 * cannot rot into a list of names that no longer dispatch.
 */
export const OVERVIEW_GROUPS = Object.freeze([
  ['Start here', [
    ['quickstart', 'Walk through one complete governed change. Offline, no model, about 8 seconds.'],
    ['bootstrap <REPOSITORY-URL>', 'Set up a capability, its configuration branch and its ledger.'],
    ['next', 'What to do next, here, right now.']
  ]],
  ['One governed change, in order', [
    ['start <WORK-ID>', 'Open a Story and pin the configuration it will be judged against.'],
    ['agent <PHASE>', 'Run the governed agent for a phase and register what it produced.'],
    ['submit', 'Submit the current phase for approval.'],
    ['approve', 'Approve a submitted phase. Also: reject, reopen, cancel.'],
    ['finalize', 'Complete the Story and open its pull request.']
  ]],
  ['Knowing where you are', [
    ['status', 'Current phase, approvals, branch.'],
    ['progress', 'The whole phase rail and what each phase is waiting on.'],
    ['inbox', 'Everything waiting on you.'],
    ['doctor', 'Check the repository, its branches and its ledger are healthy.']
  ]]
]);

/** Render the one-screen overview shown by bare `--help`. */
export function renderOverview(version) {
  const width = Math.max(...OVERVIEW_GROUPS.flatMap(([, rows]) => rows.map(([usage]) => usage.length)));
  const out = [
    `Singularity Flow ${version} — a deterministic, Git-native SDLC utility.`,
    ''
  ];
  for (const [title, rows] of OVERVIEW_GROUPS) {
    out.push(`${title}`);
    for (const [usage, summary] of rows) out.push(`  singularity-flow ${usage.padEnd(width)}  ${summary}`);
    out.push('');
  }
  out.push('Finding the detail');
  for (const [usage, summary] of [
    ['<command> --help', 'Options and worked examples for one command.'],
    ['--help --all', 'Every command and every option.'],
    ['help <topic>', 'Longer guides.']
  ]) out.push(`  singularity-flow ${usage.padEnd(width)}  ${summary}`);
  out.push('', `${COMMAND_REGISTRY.length} commands in total. --no-model disables every kernel-owned model invocation.`);
  return out.join('\n');
}

/** Commands that have an authored page, for coverage checks. */
export function documentedCommands() { return COMMAND_REGISTRY.map((entry) => entry.name); }

/** Command names referenced by the overview, for the drift check. */
export function overviewCommands() {
  return OVERVIEW_GROUPS.flatMap(([, rows]) => rows.map(([usage]) => usage.split(' ')[0]));
}

/** Every command the CLI dispatches, for coverage checks. */
export function allCommands() { return COMMAND_REGISTRY.map((entry) => entry.name); }
