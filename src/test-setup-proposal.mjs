/**
 * Propose one structured test command for a workflow step from the command line:
 *
 *   singularity-flow capability test-setup --step S [--workflow W] --use <SUGGESTION-ID> [--source-root DIR]...
 *   singularity-flow capability test-setup --step S [--workflow W] --id ID --argv '["tool","arg"]'
 *     --working-directory DIR --affected-root DIR... --adapter ADAPTER --report PATH [--env NAME=VALUE]...
 *   ... --confirm sha256:PLAN [--json]
 *
 * /sf-test-setup could suggest a runner but not save the one a person chose: its Copilot turn edits
 * no file and `configuration save` takes the whole workflow.yml on stdin, so it sent the person to
 * /sf-configuration, which validated and ended, and the consented command was never saved. This
 * previews exactly the change and, with the preview's digest, saves it through `configuration save
 * --propose`, the transaction VS Code's Test setup uses, so a packaged step takes a test command here
 * just as it does there. Nothing applies until the proposal is activated, and Stories already
 * started keep their pinned test policy.
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
import { normalizeExternalCommand } from './external-command-policy.mjs';
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
const PROPOSAL_OPTIONS = ['step', 'workflow', 'use', 'id', 'argv', 'working-directory', 'affected-root', 'adapter', 'report', 'env', 'confirm'];
const USAGE = 'Use: singularity-flow capability test-setup --step <STEP> [--workflow <WORKFLOW>] (--use <SUGGESTION-ID> [--source-root <DIRECTORY>]... '
  + '| --id <ID> --argv \'["<COMMAND>","<ARGUMENT>"]\' --working-directory <DIRECTORY> --affected-root <DIRECTORY>... --adapter <ADAPTER> --report <PATH> [--env <NAME>=<VALUE>]...) '
  + '[--confirm sha256:PLAN] [--json]';
// A workflow step's configuration is refused, never a Story phase to recover.
const usage = (message = USAGE) => new SingularityFlowError(message, { code: 'TEST_SETUP_PROPOSAL_USAGE', details: { subjectKind: 'configuration' } });
const quote = (value) => (/^[A-Za-z0-9_./:@=+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

/** Whether these options ask to propose a command rather than only inspect the repository. */
export function proposesTestCommand(options = {}) {
  return PROPOSAL_OPTIONS.some((key) => options[key] !== undefined);
}

/**
 * The exact command line that proposes `command` for the step: spelled out, so no inference runs again
 * on confirm; an instruction candidate by `--use`, its digest binding what was read.
 */
function proposalCommandLine({ step, workflow, command, source = null }, sourceRoots = []) {
  const target = ['singularity-flow', 'capability', 'test-setup', '--step', step, ...(workflow ? ['--workflow', workflow] : [])];
  if (source) return [...target, '--use', command.id, ...sourceRoots.flatMap((root) => ['--source-root', root])].map(quote).join(' ');
  return [...target, '--id', command.id, '--argv', JSON.stringify(command.argv), '--working-directory', command.workingDirectory,
    ...command.affectedRoots.flatMap((root) => ['--affected-root', root]),
    '--adapter', command.result.adapter, '--report', command.result.path,
    ...Object.entries(command.env ?? {}).flatMap(([name, value]) => ['--env', `${name}=${value}`])].map(quote).join(' ');
}

/** The step's checks with `command` added, or replacing the test command with its ID. */
export async function planTestCommandProposal(root, { step: phase, workflow = null, command, source = null }) {
  if (!STEP_ID.test(String(phase ?? ''))) throw usage('Name the workflow step the tests run in with --step <STEP>.');
  if (workflow != null && !STEP_ID.test(String(workflow))) throw usage('--workflow takes a workflow ID.');
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
      { code: 'TEST_SETUP_COMMAND_INVALID', details: { subjectKind: 'configuration', reason: error.code ?? null, field: field ?? null,
        nextAction: 'singularity-flow capability test-setup --json' } });
  }
  return withApprovedConfigurationRead(root, async () => {
    const text = await readFile(path.join(configurationReadRoot(root), WORKFLOW_PATH), 'utf8');
    const document = YAML.parseDocument(text);
    if (document.errors.length) throw usage(`${WORKFLOW_PATH} is not valid YAML; repair it before adding a test command.`);
    const raw = document.toJS() ?? {};
    const stepDefinition = raw.phases?.[phase];
    if (!stepDefinition) throw usage(`${WORKFLOW_PATH} has no step '${phase}'. Name a step with --step.`);
    if (workflow && !(raw.workTypes?.[workflow]?.phases ?? []).includes(phase)) throw usage(`Workflow '${workflow}' does not use step '${phase}'.`);
    // Where VS Code's Test setup writes: the workflow's own override when one is named, else the step.
    const scope = workflow ? ['workTypes', workflow, 'phaseOverrides', phase] : ['phases', phase];
    const current = (workflow ? raw.workTypes[workflow].phaseOverrides?.[phase]?.qualityCommands : undefined) ?? stepDefinition.qualityCommands ?? [];
    const index = current.findIndex((entry) => entry && typeof entry === 'object' && entry.id === command.id);
    if (index >= 0 && current[index].kind !== 'test') {
      throw usage(`${stepDefinition.label ?? phase} already has a check called '${command.id}' that is not a test; choose another --id.`);
    }
    const list = document.createNode(index >= 0 ? current.map((entry, at) => (at === index ? command : entry)) : [...current, command]);
    // Where an instruction candidate was read stays beside it for the approver.
    if (source) list.items[index >= 0 ? index : current.length].commentBefore = ` Read from ${source.file}:${source.line} by capability test-setup.`;
    document.setIn([...scope, 'qualityCommands'], list);
    const candidate = renderPreservingFormatting(text, document);
    const problems = [];
    try { validateDefinition(YAML.parse(candidate)); } catch (error) { problems.push(error.message); }
    const { unifiedDiff } = await import('./workflow-studio.mjs');
    const plan = {
      step: phase, workflow, label: stepDefinition.label ?? phase, command, ...(source ? { source } : {}), replaces: index >= 0 ? current[index] : null,
      kept: current.filter((_entry, at) => at !== index).map((entry) => (typeof entry === 'string' ? entry : entry?.id ?? null)),
      workflowSha256: createHash('sha256').update(text).digest('hex')
    };
    plan.planSha256 = `sha256:${createHash('sha256').update(canonicalJson(plan)).digest('hex')}`;
    return { plan, candidate, problems, diff: unifiedDiff(text, candidate, WORKFLOW_PATH) };
  }, { preferAuthority: true });
}

export { activatedTestCommandsFor } from './activated-test-commands.mjs';

/**
 * The test command the options name: an inspected suggestion or instruction candidate (--use), or the
 * one given in full. An instruction candidate's command carries its `source` (file and line).
 */
export async function requestedCommand(root, options) {
  const use = optionString(options, 'use');
  if (use) {
    const { inspectRepositoryTestSetup } = await import('./repository-test-setup.mjs');
    const selected = optionStrings(options, 'source-root');
    const inspection = await inspectRepositoryTestSetup(root, { sourceRoots: selected.length ? selected : ['.'] });
    const suggestion = inspection.suggestions.find((entry) => entry.id === use);
    if (suggestion) return suggestion;
    const written = inspection.instructionCandidates.find((entry) => entry.id === use);
    // Provenance `instruction`, with the file and line it was read from.
    if (written?.command) return { ...written.command, source: { kind: 'instruction', file: written.source.file, line: written.source.line } };
    if (written) throw usage(`'${use}' (${written.source.file}:${written.source.line}) cannot be proposed as written: ${written.reason} Give the command in full.`);
    const ids = [...inspection.suggestions, ...inspection.instructionCandidates.filter((entry) => entry.command)].map((entry) => entry.id);
    throw usage(`No suggestion is called '${use}'${ids.length ? `; inspection suggested ${ids.join(', ')}` : ''}. `
      + 'Inspect with singularity-flow capability test-setup --source-root <DIRECTORY> --json, or give the command in full.');
  }
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
  return {
    id: optionString(options, 'id'), kind: 'test', argv: commandArgv,
    ...(Object.keys(env).length ? { env: Object.fromEntries(Object.keys(env).sort().map((name) => [name, env[name]])) } : {}),
    workingDirectory: optionString(options, 'working-directory'), affectedRoots: optionStrings(options, 'affected-root'), modelPolicy: 'never',
    result: { adapter: optionString(options, 'adapter'), path: optionString(options, 'report'), minimumDiscovered: 1 }
  };
}

function cliOnly() {
  throw new SingularityFlowError('A test command is proposed from the command line: singularity-flow capability test-setup.');
}

export async function runTestCommandProposal(options) {
  const json = optionBoolean(options, 'json');
  const confirm = optionString(options, 'confirm');
  if (confirm && !DIGEST.test(confirm)) throw usage('--confirm takes the plan digest the preview printed (sha256:…).');
  const root = repoRoot();
  const step = optionString(options, 'step');
  const workflow = optionString(options, 'workflow') ?? null;
  const { source = null, ...command } = await requestedCommand(root, options);
  const { plan, candidate, problems, diff } = await planTestCommandProposal(root, { step, workflow, command, source });
  const confirmCommand = `${proposalCommandLine(plan, optionStrings(options, 'source-root'))} --confirm ${plan.planSha256}`;
  if (!confirm) {
    if (!json) {
      console.log(`${plan.replaces ? 'Replace' : 'Add'} test command '${command.id}' ${plan.replaces ? 'in' : 'to'} ${plan.label}${workflow ? ` (workflow ${workflow})` : ''}:`);
      console.log(`  ${JSON.stringify(command.argv)} · cwd=${command.workingDirectory} · covers ${command.affectedRoots.join(', ')} · ${command.result.adapter} ${command.result.path}`
        + `${command.env ? ` · env ${Object.entries(command.env).map(([name, value]) => `${name}=${value}`).join(' ')}` : ''}${source ? ` · read from ${source.file}:${source.line}` : ''}`);
      if (diff) console.log(diff);
      for (const problem of problems) console.log(`  Problem: ${problem}`);
      console.log(problems.length ? 'Nothing can be proposed until these are fixed.' : `Plan: ${plan.planSha256}\nPropose it: ${confirmCommand}`);
    }
    emitCommandResult(commandResult({
      operation: { id: 'capability.test-setup.preview', classification: 'read' },
      outcome: succeeded('capability.test-setup.previewed', { step, command: command.id }),
      effects: noEffects(),
      next: problems.length ? [] : [action({ id: 'capability.test-setup.confirm', command: confirmCommand, rank: 'NOW', kind: 'review',
        label: `Once the person agrees to this exact change, propose test command '${command.id}' for ${plan.label} as one reviewed configuration change.` })],
      data: { ...plan, problems, diff, testsExecuted: false, confirmCommand: problems.length ? null : confirmCommand }
    }), { json });
    return;
  }
  if (confirm !== plan.planSha256) {
    throw new SingularityFlowError(`The configuration or the command changed since the preview (${plan.planSha256} now). Preview again and confirm the new plan.`,
      { code: 'TEST_SETUP_PLAN_CHANGED', details: { subjectKind: 'configuration', planSha256: plan.planSha256 } });
  }
  if (problems.length) throw new SingularityFlowError(`Test command '${command.id}' cannot be proposed: ${problems[0]}`, { code: 'TEST_SETUP_PROPOSAL_INVALID', details: { subjectKind: 'configuration', problems } });
  // The same transaction as VS Code's Test setup: `configuration save --propose`, bound to the bytes previewed.
  // The extension host never proposes a test command, so its bundles drop this branch and the whole
  // CLI with it (the CLI's installer module uses top-level await, which a CommonJS bundle cannot hold).
  const [legacy, { withStdinText }] = globalThis.__SFLOW_EXTENSION_HOST__ === true
    ? cliOnly() : await Promise.all([import('./commands/legacy.mjs'), import('./read-stdin.mjs')]);
  const lines = [];
  const original = console.log;
  if (json) console.log = (...args) => lines.push(args.join(' '));
  try {
    await withStdinText(candidate, () => legacy.run(['configuration', 'save', WORKFLOW_PATH, '--propose',
      '--expected-sha256', plan.workflowSha256, ...(json ? ['--json'] : [])]));
  } finally { console.log = original; }
  const proposal = json ? JSON.parse(lines.join('\n')) : null;
  // The Story that asked adopts the activated command through its reviewed amendment.
  const workId = (await (await import('./session.mjs')).loadSession(root, { required: false }).catch(() => null))?.workId ?? null;
  const adopt = workId ? `singularity-flow story test-policy amend --work-id ${workId} --phase ${step} --reason "Adopt the activated test command for this step" --json` : null;
  const nextCommand = typeof proposal?.nextAction === 'string' ? proposal.nextAction : proposal?.nextAction?.command ?? null;
  if (!json) console.log(adopt ? `Once it is activated, a person who approves ${step} adopts it in Story ${workId}: ${adopt}`
    : 'Stories already started keep their test policy; a Story adopts the activated command through singularity-flow story test-policy amend.');
  emitCommandResult(commandResult({
    operation: { id: 'capability.test-setup.propose', classification: 'mutation' },
    outcome: succeeded('capability.test-setup.proposed', { step, command: command.id }),
    effects: effects({ filesChanged: true, publicationCreated: true }),
    next: [
      ...(nextCommand?.startsWith('singularity-flow ') ? [action({ id: 'capability.test-setup.activate', command: nextCommand, rank: 'NOW', kind: 'review',
        label: 'A configuration approver reviews and activates the proposal; until then no Story runs this command.' })] : []),
      ...(adopt ? [action({ id: 'capability.test-setup.adopt', command: adopt, rank: 'SOON', kind: 'review',
        label: `Once it is activated, a person who approves ${step} previews and applies its adoption in Story ${workId}; the tests run fresh.` })] : [])
    ],
    data: { step, workflow, command, planSha256: plan.planSha256, branch: proposal?.branch ?? null, proposal, testsExecuted: false }
  }), { json });
}
