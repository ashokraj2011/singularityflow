/**
 * Propose test commands from the command line, for the repository (its `tests:` list) or, with --step,
 * for one workflow step:
 *
 *   singularity-flow capability test-setup [--step S [--workflow W]] --use <SUGGESTION-ID>... [--source-root DIR]...
 *   singularity-flow capability test-setup [--step S [--workflow W]] --id ID --argv '["tool","arg"]'
 *     --working-directory DIR --affected-root DIR... --adapter ADAPTER --report PATH [--level LEVEL]
 *     [--env NAME=VALUE]... [--environment ENVIRONMENT] [--ecosystem LANGUAGE]
 *   ... --confirm sha256:PLAN [--json]
 *
 * How a repository runs its tests belongs to the repository [RTC]: without --step the commands go into
 * `tests:`, which every step that runs tests uses, and --use may be repeated so several setups (a unit
 * and an end-to-end runner, or one suite against a local server and a relay URL) are one proposal. A
 * command with an ID `tests:` already holds replaces that entry, and the preview says so. --step keeps
 * the per-step override.
 *
 * /sf-test-setup could suggest a runner but not save the one a person chose: its Copilot turn edits
 * no file and `configuration save` takes the whole workflow.yml on stdin, so it sent the person to
 * /sf-configuration, which validated and ended, and the consented command was never saved. This
 * previews exactly the change and, with the preview's digest, saves it through `configuration save
 * --propose`, the transaction VS Code's Test setup uses. Nothing applies until the person activates the
 * proposal (the result names the line and the VS Code place), and Stories already started keep their
 * pinned test policy.
 *
 * `--use` also takes a test command the team wrote down (an instruction candidate the inspection
 * lists, instruction-test-commands.mjs). Its confirmation names it by `--use` again: the plan digest
 * binds the command and the file and line it was read from, which the proposed workflow.yml keeps as a
 * comment above the command, so the approver sees where it came from [TCE:REQ-063]. (Spelled out, its
 * `--env NAME_X=…` words would read as placeholders to the Copilot guard's command grammar.)
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { withApprovedConfigurationRead } from './approved-configuration-reader.mjs';
import { normalizeRequiredTestCommand } from './code-delivery-tests.mjs';
import { normalizeExternalCommand, TEST_COMMAND_ECOSYSTEMS, TEST_COMMAND_LEVELS } from './external-command-policy.mjs';
import { validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import { repoRoot } from './git.mjs';
import { action, commandResult, effects, noEffects, succeeded } from './narration/command-result.mjs';
import { emitCommandResult } from './narration/emit.mjs';
import { canonicalJson } from './records.mjs';
import { optionBoolean, optionString, optionStrings, SingularityFlowError } from './util.mjs';
import { renderPreservingFormatting } from './yaml-formatting.mjs';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const STEP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PROPOSAL_OPTIONS = ['step', 'workflow', 'use', 'id', 'argv', 'working-directory', 'affected-root', 'adapter', 'report', 'env', 'environment', 'ecosystem', 'level', 'confirm'];
const USAGE = 'Use: singularity-flow capability test-setup [--step <STEP> [--workflow <WORKFLOW>]] (--use <SUGGESTION-ID>... [--source-root <DIRECTORY>]... '
  + '| --id <ID> --argv \'["<COMMAND>","<ARGUMENT>"]\' --working-directory <DIRECTORY> --affected-root <DIRECTORY>... --adapter <ADAPTER> --report <PATH> '
  + '[--level <LEVEL>] [--env <NAME>=<VALUE>]... [--environment <ENVIRONMENT>] [--ecosystem <LANGUAGE>]) [--confirm sha256:PLAN] [--json]';
// A workflow step's configuration is refused, never a Story phase to recover.
const usage = (message = USAGE) => new SingularityFlowError(message, { code: 'TEST_SETUP_PROPOSAL_USAGE', details: { subjectKind: 'configuration' } });
const quote = (value) => (/^[A-Za-z0-9_./:@=+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);
const REPOSITORY_LABEL = "the repository's tests";

/** Whether these options ask to propose a command rather than only inspect the repository. */
export function proposesTestCommand(options = {}) {
  return PROPOSAL_OPTIONS.some((key) => options[key] !== undefined);
}

/**
 * The exact command line that proposes `commands`. One inferred suggestion is spelled out, so no
 * inference runs again on confirm; several, or one the team wrote down, are named by `--use` again,
 * the plan digest binding exactly what was read.
 */
function proposalCommandLine({ step = null, workflow = null, commands, sources = [] }, sourceRoots = []) {
  const target = ['singularity-flow', 'capability', 'test-setup', ...(step ? ['--step', step, ...(workflow ? ['--workflow', workflow] : [])] : [])];
  if (commands.length > 1 || sources.length) {
    return [...target, ...commands.flatMap((command) => ['--use', command.id]), ...sourceRoots.flatMap((root) => ['--source-root', root])].map(quote).join(' ');
  }
  const [command] = commands;
  return [...target, '--id', command.id, '--argv', JSON.stringify(command.argv), '--working-directory', command.workingDirectory,
    ...command.affectedRoots.flatMap((root) => ['--affected-root', root]),
    '--adapter', command.result.adapter, '--report', command.result.path,
    ...(command.level ? ['--level', command.level] : []),
    ...Object.entries(command.env ?? {}).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    ...(command.environment ? ['--environment', command.environment] : []),
    // A suggestion keeps the language it tests; leaving --ecosystem out covers every file below the roots.
    ...(command.ecosystem ? ['--ecosystem', command.ecosystem] : [])].map(quote).join(' ');
}

/** One command's contract, with the field that is wrong named for the person who proposes it. */
function assertProposableCommand(command) {
  // The same contract publication holds the command to: argv, a structured report, nothing suppressed.
  // Publication says only "invalid structured test configuration" so a configured argv never reaches
  // a refusal; this is the person's own proposal, so name the field that is wrong. Without it a
  // Copilot turn could not tell why, and went looking for the CLI's source (2026-10-29, office).
  try { normalizeRequiredTestCommand(command); }
  catch (error) {
    let field = null;
    try { normalizeExternalCommand(command); } catch (shape) { field = shape.message; }
    const reason = (field ?? error.message).replace(/^qualityCommands\[\d+\]/u, 'the command');
    throw new SingularityFlowError(`Test command '${command.id}' cannot be proposed: ${reason} `
      + 'Correct it and propose again, or --use a suggestion the inspection lists.',
      { code: field && /holds a credential/u.test(field) ? 'QUALITY_COMMAND_ENV_SECRET' : 'TEST_SETUP_COMMAND_INVALID',
        details: { subjectKind: 'configuration', reason: error.code ?? null, field: field ?? null,
          nextAction: 'singularity-flow capability test-setup --json' } });
  }
}

/**
 * workflow.yml with `entries` (each `{ command, source }`) in the repository's `tests:` (no step) or in
 * the step's checks: added, or replacing the test command with the same ID. Every other entry keeps its
 * place and its comments.
 */
export async function planTestCommandProposal(root, { step: phase = null, workflow = null, command = null, source = null, entries = null }) {
  const proposed = entries ?? [{ command, source }];
  const repository = phase == null;
  if (repository && workflow != null) throw usage('--workflow names the workflow of a --step; without --step the commands are the repository\'s.');
  if (!repository && !STEP_ID.test(String(phase))) throw usage('Name the workflow step the tests run in with --step <STEP>, or leave --step out to save them for the repository.');
  if (workflow != null && !STEP_ID.test(String(workflow))) throw usage('--workflow takes a workflow ID.');
  if (!proposed.length) throw usage();
  const ids = proposed.map((entry) => entry.command.id);
  if (new Set(ids).size !== ids.length) throw usage(`Each test command needs its own ID; ${ids.find((id, at) => ids.indexOf(id) !== at)} is named twice.`);
  for (const entry of proposed) assertProposableCommand(entry.command);
  return withApprovedConfigurationRead(root, async () => {
    const text = await readFile(path.join(configurationReadRoot(root), WORKFLOW_PATH), 'utf8');
    const document = YAML.parseDocument(text);
    if (document.errors.length) throw usage(`${WORKFLOW_PATH} is not valid YAML; repair it before adding a test command.`);
    const raw = document.toJS() ?? {};
    const stepDefinition = repository ? null : raw.phases?.[phase];
    if (!repository && !stepDefinition) throw usage(`${WORKFLOW_PATH} has no step '${phase}'. Name a step with --step, or leave it out to save for the repository.`);
    if (workflow && !(raw.workTypes?.[workflow]?.phases ?? []).includes(phase)) throw usage(`Workflow '${workflow}' does not use step '${phase}'.`);
    // Where VS Code's Test setup writes: the repository's list, the workflow's own override when one is named, else the step.
    const scope = repository ? ['tests'] : workflow ? ['workTypes', workflow, 'phaseOverrides', phase, 'qualityCommands'] : ['phases', phase, 'qualityCommands'];
    const inOverride = workflow ? raw.workTypes[workflow].phaseOverrides?.[phase]?.qualityCommands : undefined;
    const current = repository ? raw.tests ?? [] : inOverride ?? stepDefinition.qualityCommands ?? [];
    if (!Array.isArray(current)) throw usage(`${WORKFLOW_PATH} ${scope.join('.')} is not a list; repair it before adding a test command.`);
    const label = repository ? REPOSITORY_LABEL : stepDefinition.label ?? phase;
    const replaces = [];
    const next = [...current];
    const at = [];
    for (const { command: entry } of proposed) {
      const index = next.findIndex((item) => item && typeof item === 'object' && item.id === entry.id);
      if (index >= 0 && next[index].kind !== 'test') throw usage(`${label} already has a check called '${entry.id}' that is not a test; choose another --id.`);
      if (index >= 0) { replaces.push(next[index]); next[index] = entry; at.push(index); }
      else { next.push(entry); at.push(next.length - 1); }
    }
    // The list is edited in place where it exists, so the entries it keeps keep their comments (a
    // command the team wrote down keeps where it was read from); a workflow's override starts from the step's list.
    const existing = repository || inOverride !== undefined || !workflow ? document.getIn(scope, true) : null;
    const list = YAML.isSeq(existing) ? existing : document.createNode(current);
    list.flow = false;
    // The comment above the list's first entry belongs to that entry: replacing it drops the comment.
    if (at.includes(0) && list === existing) list.commentBefore = undefined;
    proposed.forEach(({ command: entry, source: from }, position) => {
      const node = document.createNode(entry);
      if (from) node.commentBefore = ` Read from ${from.file}:${from.line} by capability test-setup.`;
      list.items[at[position]] = node;
    });
    if (list !== existing) document.setIn(scope, list);
    const candidate = renderPreservingFormatting(text, document);
    const problems = [];
    try { validateDefinition(YAML.parse(candidate)); } catch (error) { problems.push(error.message); }
    const { unifiedDiff } = await import('./workflow-studio.mjs');
    const sources = proposed.filter((entry) => entry.source).map((entry) => ({ id: entry.command.id, ...entry.source }));
    const plan = {
      ...(repository ? { target: 'repository' } : { target: 'step', step: phase, workflow }), label,
      commands: proposed.map((entry) => entry.command), ...(sources.length ? { sources } : {}), replaces,
      kept: current.filter((entry) => !replaces.includes(entry)).map((entry) => (typeof entry === 'string' ? entry : entry?.id ?? null)),
      workflowSha256: createHash('sha256').update(text).digest('hex')
    };
    plan.planSha256 = `sha256:${createHash('sha256').update(canonicalJson(plan)).digest('hex')}`;
    return { plan, candidate, problems, diff: unifiedDiff(text, candidate, WORKFLOW_PATH) };
  }, { preferAuthority: true });
}

export { activatedTestCommandsFor } from './activated-test-commands.mjs';

/**
 * The test commands the options name, each `{ command, source }`: inspected suggestions or instruction
 * candidates (--use, repeatable), or the one given in full. An instruction candidate carries its
 * `source` (file and line).
 */
export async function requestedCommands(root, options) {
  const uses = optionStrings(options, 'use');
  if (uses.length) {
    if (new Set(uses).size !== uses.length) throw usage('Name each suggestion once with --use.');
    const { inspectRepositoryTestSetup } = await import('./repository-test-setup.mjs');
    const selected = optionStrings(options, 'source-root');
    const inspection = await inspectRepositoryTestSetup(root, { sourceRoots: selected.length ? selected : ['.'] });
    return uses.map((use) => {
      const suggestion = inspection.suggestions.find((entry) => entry.id === use);
      if (suggestion) return { command: suggestion, source: null };
      const written = inspection.instructionCandidates.find((entry) => entry.id === use);
      // Provenance `instruction`, with the file and line it was read from.
      if (written?.command) return { command: written.command, source: { kind: 'instruction', file: written.source.file, line: written.source.line } };
      if (written) throw usage(`'${use}' (${written.source.file}:${written.source.line}) cannot be proposed as written: ${written.reason} Give the command in full.`);
      const ids = [...inspection.suggestions, ...inspection.instructionCandidates.filter((entry) => entry.command)].map((entry) => entry.id);
      throw usage(`No suggestion is called '${use}'${ids.length ? `; inspection suggested ${ids.join(', ')}` : ''}. `
        + 'Inspect with singularity-flow capability test-setup --source-root <DIRECTORY> --json, or give the command in full.');
    });
  }
  return [{ command: await spelledOutCommand(options), source: null }];
}

/** One test command the options name, with its `source` when the team wrote it down (decision test-command takes one). */
export async function requestedCommand(root, options) {
  const [first, ...more] = await requestedCommands(root, options);
  if (more.length) throw usage('Name one test command with --use.');
  const { targetVariables: _shown, ...command } = first.command;
  return first.source ? { ...command, source: first.source } : command;
}

/** The one test command given in full. */
async function spelledOutCommand(options) {
  const missing = ['id', 'argv', 'working-directory', 'adapter', 'report'].filter((key) => !optionString(options, key));
  if (missing.length || !optionStrings(options, 'affected-root').length) {
    throw usage(`Give the test command in full${missing.length ? ` (missing --${missing.join(', --')})` : ''}, with at least one --affected-root. ${USAGE}`);
  }
  // A JSON array keeps every argument exact, including ones that look like options (`--json`).
  let commandArgv;
  try { commandArgv = JSON.parse(optionString(options, 'argv')); } catch { commandArgv = null; }
  if (!Array.isArray(commandArgv) || !commandArgv.length || commandArgv.some((part) => typeof part !== 'string' || !part)) {
    throw usage('--argv takes the command as a JSON array of strings, for example \'["npx","nx","run","shop-e2e:e2e"]\'.');
  }
  // Literal variables: a secret-looking name or value is never written into workflow.yml.
  const env = {};
  for (const entry of optionStrings(options, 'env')) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(entry);
    if (!assignment) throw usage('--env takes NAME=VALUE, for example --env BASE_URL=http://localhost:3000.');
    const { classifyVariable } = await import('./secret-looking.mjs');
    if (classifyVariable(assignment[1], assignment[2]).kind === 'secret') {
      throw new SingularityFlowError(`--env ${assignment[1]} looks like it carries a secret, and workflow.yml never holds one. Declare it as a secret in `
        + 'singularity/environments.yml, bind it on the machine that runs the tests, and link the command to that environment.',
      { code: 'QUALITY_COMMAND_ENV_SECRET', details: { subjectKind: 'configuration', name: assignment[1] } });
    }
    env[assignment[1]] = assignment[2];
  }
  const ecosystem = optionString(options, 'ecosystem') ?? null;
  if (ecosystem != null && !TEST_COMMAND_ECOSYSTEMS.includes(ecosystem)) {
    throw usage(`--ecosystem takes the language the command tests: ${TEST_COMMAND_ECOSYSTEMS.join(', ')}. Leave it out to cover every file below the affected roots.`);
  }
  const level = optionString(options, 'level') ?? null;
  if (level != null && !TEST_COMMAND_LEVELS.includes(level)) throw usage(`--level takes ${TEST_COMMAND_LEVELS.join(', ')}. Leave it out for other.`);
  // A URL that differs per machine or carries a credential: environments.yml declares it, and each machine binds it.
  const environment = optionString(options, 'environment') ?? null;
  return {
    id: optionString(options, 'id'), kind: 'test', ...(level ? { level } : {}), argv: commandArgv,
    ...(Object.keys(env).length ? { env: Object.fromEntries(Object.keys(env).sort().map((name) => [name, env[name]])) } : {}),
    ...(environment ? { environment } : {}),
    ...(ecosystem ? { ecosystem } : {}),
    workingDirectory: optionString(options, 'working-directory'), affectedRoots: optionStrings(options, 'affected-root'), modelPolicy: 'never',
    result: { adapter: optionString(options, 'adapter'), path: optionString(options, 'report'), minimumDiscovered: 1 }
  };
}

/** One command for the preview: what runs, where, what it covers, its target and report. */
function describedCommand(command, source) {
  return `  ${command.id}${command.level ? ` (${command.level})` : ''}: ${JSON.stringify(command.argv)} · cwd=${command.workingDirectory} · covers ${command.affectedRoots.join(', ')}`
    + `${command.ecosystem ? ` (${command.ecosystem} files only)` : ''} · ${command.result.adapter} ${command.result.path}`
    + `${command.env ? ` · env ${Object.entries(command.env).map(([name, value]) => `${name}=${value}`).join(' ')}` : ''}`
    + `${command.environment ? ` · environment ${command.environment} (bound on each machine)` : ''}${source ? ` · read from ${source.file}:${source.line}` : ''}`
    + `${command.targetVariables?.length ? ` · its config reads ${command.targetVariables.join(', ')}: set it with --env, or --environment for a URL that differs per machine or holds a credential` : ''}`;
}

function cliOnly() {
  throw new SingularityFlowError('A test command is proposed from the command line: singularity-flow capability test-setup.');
}

export async function runTestCommandProposal(options) {
  const json = optionBoolean(options, 'json');
  const confirm = optionString(options, 'confirm');
  if (confirm && !DIGEST.test(confirm)) throw usage('--confirm takes the plan digest the preview printed (sha256:…).');
  const root = repoRoot();
  const step = optionString(options, 'step') ?? null;
  const workflow = optionString(options, 'workflow') ?? null;
  // What the inspection read to name a target variable is shown, never written into workflow.yml.
  const entries = (await requestedCommands(root, options)).map(({ command: { targetVariables, ...command }, source }) => ({ command, source, targetVariables }));
  const { plan, candidate, problems, diff } = await planTestCommandProposal(root, { step, workflow, entries });
  const confirmCommand = `${proposalCommandLine(plan, optionStrings(options, 'source-root'))} --confirm ${plan.planSha256}`;
  const ids = plan.commands.map((command) => command.id);
  const named = ids.length === 1 ? `test command '${ids[0]}'` : `test commands ${ids.map((id) => `'${id}'`).join(', ')}`;
  if (!confirm) {
    if (!json) {
      console.log(`${plan.replaces.length ? 'Replace or add' : 'Add'} ${named} ${plan.target === 'repository' ? 'in' : 'for'} ${plan.label}${workflow ? ` (workflow ${workflow})` : ''}:`);
      for (const { command, source, targetVariables } of entries) console.log(describedCommand({ ...command, targetVariables }, source));
      for (const replaced of plan.replaces) console.log(`  Replaces the test command '${replaced.id}' already there.`);
      if (diff) console.log(diff);
      for (const problem of problems) console.log(`  Problem: ${problem}`);
      if (problems.length) console.log('Nothing can be proposed until these are fixed.');
      else {
        // Proposed by its short code, never the plan digest (confirm-code.mjs).
        const { safeCommandGuidance, commandRouteLines } = await import('./safe-command-guidance.mjs');
        console.log(['Propose it:', ...commandRouteLines(safeCommandGuidance({ command: confirmCommand }) ?? {})].join('\n'));
      }
    }
    const targets = entries.filter((entry) => entry.targetVariables?.length).map((entry) => ({ id: entry.command.id, variables: entry.targetVariables }));
    emitCommandResult(commandResult({
      operation: { id: 'capability.test-setup.preview', classification: 'read' },
      outcome: succeeded('capability.test-setup.previewed', { step, command: ids.join(', ') }),
      effects: noEffects(),
      next: problems.length ? [] : [action({ id: 'capability.test-setup.confirm', command: confirmCommand, rank: 'NOW', kind: 'review',
        label: `Once the person agrees to this exact change, propose ${named} for ${plan.label} as one reviewed configuration change.` })],
      // One command is also named on its own, as before several could be proposed together.
      data: { ...plan, ...(entries.length === 1 ? { command: entries[0].command, ...(entries[0].source ? { source: entries[0].source } : {}) } : {}),
        ...(targets.length ? { targetVariables: targets } : {}), problems, diff, testsExecuted: false, confirmCommand: problems.length ? null : confirmCommand }
    }), { json });
    return;
  }
  if (confirm !== plan.planSha256) {
    throw new SingularityFlowError(`The configuration or the command changed since the preview (${plan.planSha256} now). Preview again and confirm the new plan.`,
      { code: 'TEST_SETUP_PLAN_CHANGED', details: { subjectKind: 'configuration', planSha256: plan.planSha256 } });
  }
  if (problems.length) throw new SingularityFlowError(`${named[0].toUpperCase()}${named.slice(1)} cannot be proposed: ${problems[0]}`, { code: 'TEST_SETUP_PROPOSAL_INVALID', details: { subjectKind: 'configuration', problems } });
  // The same transaction as VS Code's Test setup: `configuration save --propose`, bound to the bytes previewed.
  // The extension host never proposes a test command, so its bundles drop this branch and the whole
  // CLI with it (the CLI's installer module uses top-level await, which a CommonJS bundle cannot hold).
  const [legacy, { withStdinText }, { workflowActivationRoute }] = globalThis.__SFLOW_EXTENSION_HOST__ === true
    ? cliOnly() : await Promise.all([import('./commands/legacy.mjs'), import('./read-stdin.mjs'), import('./configuration-proposal.mjs')]);
  const lines = [];
  const original = console.log;
  // Read as JSON either way: the person's next step is this proposal's exact activation line.
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await withStdinText(candidate, () => legacy.run(['configuration', 'save', WORKFLOW_PATH, '--propose',
      '--expected-sha256', plan.workflowSha256, '--json']));
  } finally { console.log = original; }
  const proposal = JSON.parse(lines.join('\n'));
  // The person who chose the command activates it, in their own terminal or in VS Code [RTC:REQ-006];
  // an agent never does. A protected sflow/config refuses the direct update and says to merge through review.
  const activation = proposal?.pushed && proposal.branch && proposal.commit ? workflowActivationRoute(proposal.branch, proposal.commit) : null;
  // The Story that asked adopts the activated command through its reviewed amendment, at the step it is on
  // unless the command was for one step.
  const workId = (await (await import('./session.mjs')).loadSession(root, { required: false }).catch(() => null))?.workId ?? null;
  const adopt = workId ? `singularity-flow story test-policy amend --work-id ${workId}${step ? ` --phase ${step}` : ''} --reason "Adopt the activated test command${ids.length === 1 ? '' : 's'}" --json` : null;
  const nextCommand = typeof proposal?.nextAction === 'string' ? proposal.nextAction : proposal?.nextAction?.command ?? null;
  if (!json) {
    console.log(`Proposed ${named} for ${plan.label} for review: ${proposal.branch ?? 'no change'}${proposal.commit ? ` (${proposal.commit})` : ''}.`);
    if (activation) {
      console.log(`Activate it yourself: ${activation.command}`);
      console.log(`  ${activation.acknowledgement}`);
      console.log(`  VS Code: ${activation.vscode}`);
    }
    console.log(adopt ? `Once it is activated, a person who approves ${step ?? 'the Story\'s step'} adopts it in Story ${workId}: ${adopt}`
      : 'Stories already started keep their test policy; a Story adopts the activated command through singularity-flow story test-policy amend.');
  }
  emitCommandResult(commandResult({
    operation: { id: 'capability.test-setup.propose', classification: 'mutation' },
    outcome: succeeded('capability.test-setup.proposed', { step, command: ids.join(', ') }),
    effects: effects({ filesChanged: true, publicationCreated: true }),
    next: [
      ...(nextCommand?.startsWith('singularity-flow ') ? [action({ id: 'capability.test-setup.activate', command: nextCommand, rank: 'NOW', kind: 'review',
        label: activation
          ? `Until it is activated no Story runs ${ids.length === 1 ? 'this command' : 'these commands'}. The person who chose ${ids.length === 1 ? 'it' : 'them'} activates it themselves, never an agent: `
            + `in their own terminal, ${activation.command}; or in ${activation.vscode}.`
          : 'A configuration approver reviews and activates the proposal; until then no Story runs this command.' })] : []),
      ...(adopt ? [action({ id: 'capability.test-setup.adopt', command: adopt, rank: 'SOON', kind: 'review',
        label: `Once it is activated, a person who approves ${step ?? 'the Story\'s step'} previews and applies its adoption in Story ${workId}; the tests run fresh.` })] : [])
    ],
    data: { target: plan.target, step, workflow, commands: plan.commands, command: plan.commands[0], planSha256: plan.planSha256,
      branch: proposal?.branch ?? null, proposal, ...(activation ? { activation } : {}), testsExecuted: false }
  }), { json });
}
