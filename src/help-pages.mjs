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
    examples: [['singularity-flow prepare intake', 'Prepares the intake artifact for the current Story.']],
    seeAlso: ['phase', 'artifact', 'nextsteps']
  },
  phase: {
    summary: 'Publish a generation of the current phase\'s artifact.',
    description: [
      'Records a new generation: it registers the artifacts, captures authorship and model usage,',
      'and commits the result as one governed transition.',
      '',
      'Publication refuses when the phase is not ready — a missing artifact, an unmet world-model',
      'grounding policy, or a phase out of sequence. Nothing is written when it refuses.'
    ],
    options: [
      ['--authored human|governed-agent|external-tool', 'Who produced the artifact. Record it explicitly.'],
      ['--from FILE', 'Import the artifact from a file authored elsewhere.'],
      ['--usage-json FILE', 'Attach model usage for a governed-agent generation.']
    ],
    examples: [
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
    examples: [
      ['singularity-flow doctor', 'Full diagnosis of the current repository.'],
      ['singularity-flow doctor --offline', 'Skip every check that needs the network.']
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
      '',
      'If a phase refuses to publish with "grounding is not ready", this is the command that fixes',
      'it — and note that the grounding policy is pinned from the configuration branch, not from the',
      'branch you are standing on.'
    ],
    examples: [
      ['singularity-flow wm build --depth quick', 'Build the world model at quick depth.'],
      ['singularity-flow wm compose --phase intake', 'Compose the grounding for a phase.'],
      ['singularity-flow wm light --local', 'Deterministic lightweight model, no provider needed.']
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
    examples: [
      ['singularity-flow workspace list', 'Every registered workspace.'],
      ['singularity-flow workspace use payments', 'Make a workspace the active one for this session.']
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
      'mirror and use a commit-validated cache; pass `--refresh` for an explicit remote recheck.'
    ],
    examples: [
      ['singularity-flow capability map payments --repository payments-api', 'Propose a capability.'],
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
      'completes the attestation.'
    ],
    examples: [
      ['singularity-flow ledger status', 'Ledger health and any unpublished intents.'],
      ['singularity-flow ledger verify', 'Verify the chain end to end.'],
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
  story: {
    summary: 'Story-level operations: branches, intervals, convergence, intent amendments, checks, and finalisation.',
    examples: [
      ['singularity-flow story branch create --parent PAY-1 --name PAY-1-ui', 'Create a governed child branch.'],
      ['singularity-flow story intent-amendment propose --file amended-spec.md --reason "Retry policy changed"', 'Propose corrected intent for an update-intent finding without editing the approved specification.'],
      ['singularity-flow story checks PAY-1', 'Record CI evidence against the submitted packet.']
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
    summary: 'Complete a publication that was interrupted after its commit.',
    description: [
      'When a governed commit landed but its push did not, the Story is left with a pending',
      'publication and every later mutation is refused. This publishes the retained commit.'
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
