/**
 * Propose one structured test command for a workflow step from the command line:
 *
 *   singularity-flow capability test-setup --step S [--workflow W] --use <SUGGESTION-ID> [--source-root DIR]...
 *   singularity-flow capability test-setup --step S [--workflow W] --id ID --argv '["tool","arg"]'
 *     --working-directory DIR --affected-root DIR... --adapter ADAPTER --report PATH
 *   ... --confirm sha256:PLAN [--json]
 *
 * /sf-test-setup could suggest a runner but not save the one a person chose: its Copilot turn edits
 * no file and `configuration save` takes the whole workflow.yml on stdin, so it sent the person to
 * /sf-configuration, which validated and ended, and the consented command was never saved. This
 * previews exactly the change and, with the preview's digest, saves it through `configuration save
 * --propose`, the transaction VS Code's Test setup uses, so a packaged step takes a test command here
 * just as it does there. Nothing applies until the proposal is activated, and Stories already
 * started keep their pinned test policy.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { withApprovedConfigurationRead } from './approved-configuration-reader.mjs';
import { normalizeRequiredTestCommand } from './code-delivery-tests.mjs';
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
const PROPOSAL_OPTIONS = ['step', 'workflow', 'use', 'id', 'argv', 'working-directory', 'affected-root', 'adapter', 'report', 'confirm'];
const USAGE = 'Use: singularity-flow capability test-setup --step <STEP> [--workflow <WORKFLOW>] (--use <SUGGESTION-ID> [--source-root <DIRECTORY>]... '
  + '| --id <ID> --argv \'["<COMMAND>","<ARGUMENT>"]\' --working-directory <DIRECTORY> --affected-root <DIRECTORY>... --adapter <ADAPTER> --report <PATH>) '
  + '[--confirm sha256:PLAN] [--json]';
// A workflow step's configuration is refused, never a Story phase to recover.
const usage = (message = USAGE) => new SingularityFlowError(message, { code: 'TEST_SETUP_PROPOSAL_USAGE', details: { subjectKind: 'configuration' } });
const quote = (value) => (/^[A-Za-z0-9_./:@=+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

/** Whether these options ask to propose a command rather than only inspect the repository. */
export function proposesTestCommand(options = {}) {
  return PROPOSAL_OPTIONS.some((key) => options[key] !== undefined);
}

/** The exact command line that proposes `command` for the step: no inference runs again on confirm. */
function proposalCommandLine({ step, workflow, command }) {
  return ['singularity-flow', 'capability', 'test-setup', '--step', step, ...(workflow ? ['--workflow', workflow] : []),
    '--id', command.id, '--argv', JSON.stringify(command.argv), '--working-directory', command.workingDirectory,
    ...command.affectedRoots.flatMap((root) => ['--affected-root', root]),
    '--adapter', command.result.adapter, '--report', command.result.path].map(quote).join(' ');
}

/** The step's checks with `command` added, or replacing the test command with its ID. */
export async function planTestCommandProposal(root, { step: phase, workflow = null, command }) {
  if (!STEP_ID.test(String(phase ?? ''))) throw usage('Name the workflow step the tests run in with --step <STEP>.');
  if (workflow != null && !STEP_ID.test(String(workflow))) throw usage('--workflow takes a workflow ID.');
  // The same contract publication holds the command to: argv, a structured report, nothing suppressed.
  try { normalizeRequiredTestCommand(command); }
  catch (error) {
    throw new SingularityFlowError(`Test command '${command.id}' cannot be proposed: ${error.message}`,
      { code: 'TEST_SETUP_COMMAND_INVALID', details: { subjectKind: 'configuration', reason: error.code ?? null } });
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
    document.setIn([...scope, 'qualityCommands'], document.createNode(index >= 0
      ? current.map((entry, at) => (at === index ? command : entry)) : [...current, command]));
    const candidate = renderPreservingFormatting(text, document);
    const problems = [];
    try { validateDefinition(YAML.parse(candidate)); } catch (error) { problems.push(error.message); }
    const { unifiedDiff } = await import('./workflow-studio.mjs');
    const plan = {
      step: phase, workflow, label: stepDefinition.label ?? phase, command, replaces: index >= 0 ? current[index] : null,
      kept: current.filter((_entry, at) => at !== index).map((entry) => (typeof entry === 'string' ? entry : entry?.id ?? null)),
      workflowSha256: createHash('sha256').update(text).digest('hex')
    };
    plan.planSha256 = `sha256:${createHash('sha256').update(canonicalJson(plan)).digest('hex')}`;
    return { plan, candidate, problems, diff: unifiedDiff(text, candidate, WORKFLOW_PATH) };
  }, { preferAuthority: true });
}

/**
 * Test commands the activated configuration now gives a Story's step that its pinned policy lacks:
 * what `story test-policy amend` would adopt. Empty when there are none or the authority cannot be read.
 */
export async function activatedTestCommandsFor(root, workflow, phaseId) {
  try {
    return await withApprovedConfigurationRead(root, async () => {
      const raw = YAML.parse(await readFile(path.join(configurationReadRoot(root), WORKFLOW_PATH), 'utf8')) ?? {};
      const commands = raw.workTypes?.[workflow.workItem?.workType]?.phaseOverrides?.[phaseId]?.qualityCommands
        ?? raw.phases?.[phaseId]?.qualityCommands ?? [];
      const pinned = (workflow.resolution?.phases?.find((entry) => entry.id === phaseId)?.qualityCommands ?? []).map(canonicalJson);
      return commands.filter((entry) => entry?.kind === 'test' && !pinned.includes(canonicalJson(entry)));
    }, { preferAuthority: true });
  } catch { return []; }
}

/** The test command the options name: an inspected suggestion (--use), or the one given in full. */
export async function requestedCommand(root, options) {
  const use = optionString(options, 'use');
  if (use) {
    const { inspectRepositoryTestSetup } = await import('./repository-test-setup.mjs');
    const selected = optionStrings(options, 'source-root');
    const inspection = await inspectRepositoryTestSetup(root, { sourceRoots: selected.length ? selected : ['.'] });
    const suggestion = inspection.suggestions.find((entry) => entry.id === use);
    if (!suggestion) {
      throw usage(`No suggestion is called '${use}'${inspection.suggestions.length ? `; inspection suggested ${inspection.suggestions.map((entry) => entry.id).join(', ')}` : ''}. `
        + 'Inspect with singularity-flow capability test-setup --source-root <DIRECTORY> --json, or give the command in full.');
    }
    return suggestion;
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
  return {
    id: optionString(options, 'id'), kind: 'test', argv: commandArgv,
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
  const command = await requestedCommand(root, options);
  const { plan, candidate, problems, diff } = await planTestCommandProposal(root, { step, workflow, command });
  const confirmCommand = `${proposalCommandLine(plan)} --confirm ${plan.planSha256}`;
  if (!confirm) {
    if (!json) {
      console.log(`${plan.replaces ? 'Replace' : 'Add'} test command '${command.id}' ${plan.replaces ? 'in' : 'to'} ${plan.label}${workflow ? ` (workflow ${workflow})` : ''}:`);
      console.log(`  ${JSON.stringify(command.argv)} · cwd=${command.workingDirectory} · covers ${command.affectedRoots.join(', ')} · ${command.result.adapter} ${command.result.path}`);
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
  // The extension host loads this module only for activatedTestCommandsFor, so its bundles drop this
  // branch and the whole CLI with it (the CLI's installer module uses top-level await, which a
  // CommonJS bundle cannot hold).
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
