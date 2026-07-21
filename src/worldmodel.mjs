import { mkdtemp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { head } from './git.mjs';
import { SingularityFlowError, optionBoolean, optionString, run } from './util.mjs';
import { loadDefinition, WORKFLOW_PATH } from './config.mjs';
import { loadSession } from './session.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configRelative = '.singularity/worldmodel.json';

function defaults() {
  return JSON.parse(requireTemplate('worldmodel.json'));
}

function requireTemplate(name) {
  const file = path.join(packageRoot, 'templates', name);
  if (!existsSync(file)) throw new SingularityFlowError(`Packaged world-model template is missing: ${name}`);
  return requireText(file);
}

function requireText(file) {
  try { return readFileSync(file, 'utf8'); }
  catch (error) { throw new SingularityFlowError(`Unable to read ${file}: ${error.message}`); }
}

async function load(root) {
  if (existsSync(path.join(root, WORKFLOW_PATH))) {
    const definition = await loadDefinition(root);
    const session = await loadSession(root, { required: false });
    const activeId = run('git', ['branch', '--show-current'], { cwd: root, allowFailure: true }).stdout.trim();
    const activeStatePath = path.join(root, definition.workItemRoot ?? '.singularity/work-items', activeId, 'workflow.json');
    const activeState = existsSync(activeStatePath) ? JSON.parse(await readFile(activeStatePath, 'utf8')) : null;
    const phaseEntries = activeState?.resolution?.phases?.length
      ? activeState.resolution.phases.map((phase) => [phase.id, phase])
      : Object.entries(definition.phases);
    const phases = Object.fromEntries(phaseEntries.map(([id, phase]) => {
      const personaViews = session ? definition.personas[session.persona]?.worldModelViews ?? [] : [];
      return [id, { views: [...new Set([...(phase.worldModel?.views ?? []), ...personaViews])], depth: phase.worldModel?.depth ?? 'standard', evidence: phase.worldModel?.evidence ?? false }];
    }));
    return {
      outputDir: definition.worldModel?.outputDir ?? '.singularity/world-model',
      promptSource: definition.worldModel?.promptSource ?? '.singularity/prompts/worldmodel-builder.md',
      runner: definition.worldModel?.runner ?? 'copilot -p "$(cat {prompt_file})" --allow-all-tools',
      staleness: definition.worldModel?.staleness ?? 'warn', phases,
      context: { always: ['core/summary.md'], includeDomains: 'matched', includeEvidence: false },
      personaPrompt: session ? path.posix.join(definition.personaPromptsRoot, definition.personas[session.persona].prompt) : null
    };
  }
  const file = path.join(root, configRelative);
  if (!existsSync(file)) throw new SingularityFlowError('World model is not initialized. Run: singularity-flow wm init');
  const user = JSON.parse(await readFile(file, 'utf8'));
  const base = defaults();
  return { ...base, ...user, phases: { ...base.phases, ...(user.phases ?? {}) }, context: { ...base.context, ...(user.context ?? {}) } };
}

function render(template, root, config, options) {
  const phase = optionString(options, 'phase');
  const phaseConfig = phase ? config.phases[phase] : null;
  if (phase && !phaseConfig) throw new SingularityFlowError(`Unknown world-model phase: ${phase}`);
  const values = {
    repository: root,
    outputDir: config.outputDir,
    views: optionString(options, 'views') ?? phaseConfig?.views?.join(', ') ?? 'auto',
    focus: optionString(options, 'focus', 'none'),
    task: optionString(options, 'task', 'none'),
    depth: optionString(options, 'depth', phaseConfig?.depth ?? 'standard')
  };
  const tokens = {
    '{{REPOSITORY_PATH_OR_CURRENT_DIRECTORY}}': values.repository,
    '{{OUTPUT_DIRECTORY_OR_.agent/world-model}}': values.outputDir,
    '{{REQUESTED_VIEWS_OR_AUTO}}': values.views,
    '{{FOCUS_AREA_OR_NONE}}': values.focus,
    '{{CURRENT_TASK_OR_NONE}}': values.task,
    '{{QUICK_OR_STANDARD_OR_DEEP}}': values.depth
  };
  let result = template;
  for (const [token, value] of Object.entries(tokens)) result = result.split(token).join(value);
  return result;
}

async function init(root) {
  const promptFile = path.join(root, '.singularity/prompts/worldmodel-builder.md');
  await mkdir(path.dirname(promptFile), { recursive: true });
  if (!existsSync(promptFile)) await copyFile(path.join(packageRoot, 'templates/worldmodel-builder.md'), promptFile);
  console.log('World-model builder prompt initialized; phase routing comes from .singularity/workflow.yml.');
}

async function prompt(root, config, options) {
  const source = config.promptSource === 'builtin'
    ? path.join(packageRoot, 'templates/worldmodel-builder.md')
    : path.resolve(root, config.promptSource);
  const rendered = render(await readFile(source, 'utf8'), root, config, options);
  const destination = optionString(options, 'out');
  if (destination) {
    await writeFile(path.resolve(root, destination), rendered);
    console.log(`World-model prompt written to ${destination}.`);
  } else process.stdout.write(rendered);
  return rendered;
}

async function build(root, config, options) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-wm-'));
  const promptFile = path.join(temporary, 'prompt.md');
  const source = config.promptSource === 'builtin' ? path.join(packageRoot, 'templates/worldmodel-builder.md') : path.resolve(root, config.promptSource);
  await writeFile(promptFile, render(await readFile(source, 'utf8'), root, config, options));
  const command = (optionString(options, 'runner') ?? config.runner).replaceAll('{prompt_file}', promptFile);
  const result = run('bash', ['-lc', command], { cwd: root, stdio: 'inherit', allowFailure: true });
  if (result.status !== 0) throw new SingularityFlowError(`World-model builder exited with status ${result.status}.`);
  const manifest = path.join(root, config.outputDir, 'manifest.json');
  if (!existsSync(manifest)) throw new SingularityFlowError(`Builder completed without ${config.outputDir}/manifest.json.`);
  console.log(`World model built for commit ${head(root).slice(0, 10)}.`);
}

async function manifest(root, config) {
  const file = path.join(root, config.outputDir, 'manifest.json');
  if (!existsSync(file)) throw new SingularityFlowError('No world model exists. Run: singularity-flow wm build --phase <phase>');
  return JSON.parse(await readFile(file, 'utf8'));
}

function freshness(root, model) {
  const built = model.repository_commit ?? model.repository?.commit;
  return { built, current: head(root), fresh: built === head(root) };
}

async function context(root, config, phase, options) {
  const phaseConfig = config.phases[phase];
  if (!phaseConfig) throw new SingularityFlowError(`Unknown world-model phase: ${phase}`);
  const model = await manifest(root, config);
  const state = freshness(root, model);
  if (!state.fresh && config.staleness === 'fail') throw new SingularityFlowError(`World model is stale (${String(state.built).slice(0, 10)} != ${state.current.slice(0, 10)}). Rebuild it.`);
  if (!state.fresh && config.staleness === 'warn') console.warn(`Warning: world model is stale (${String(state.built).slice(0, 10)} != ${state.current.slice(0, 10)}).`);
  const selected = [];
  const add = (relative, level, reason) => {
    if (relative && existsSync(path.join(root, config.outputDir, relative)) && !selected.some((item) => item.relative === relative)) selected.push({ relative, level, reason });
  };
  for (const relative of config.context.always ?? []) add(relative, 0, 'shared repository core');
  if (config.personaPrompt && existsSync(path.join(root, config.personaPrompt))) selected.push({ relative: path.relative(config.outputDir, config.personaPrompt), absolute: config.personaPrompt, level: 0, reason: 'active persona prompt' });
  for (const view of phaseConfig.views ?? []) add(model.views?.[view]?.path ?? `views/${view}.md`, 1, `${phase} view: ${view}`);
  if (config.context.includeDomains !== 'none') {
    for (const domain of model.domains ?? []) {
      if (config.context.includeDomains === 'all' || (domain.relevant_views ?? []).some((view) => phaseConfig.views.includes(view))) add(domain.path, 2, `domain: ${domain.id}`);
    }
  }
  if (optionBoolean(options, 'evidence') || phaseConfig.evidence || config.context.includeEvidence) add(model.evidence?.path, 3, 'evidence ledger');
  if (optionBoolean(options, 'concat')) {
    for (const item of selected) {
      console.log(`\n<!-- L${item.level} ${item.relative}: ${item.reason} -->\n`);
      process.stdout.write(await readFile(path.join(root, item.absolute ?? path.join(config.outputDir, item.relative)), 'utf8'));
    }
  } else {
    console.log(`# World-model context: phase=${phase} commit=${String(state.built).slice(0, 10)}${state.fresh ? '' : ' STALE'}`);
    selected.forEach((item) => console.log(`L${item.level}  ${item.absolute ?? path.posix.join(config.outputDir, item.relative)}  # ${item.reason}`));
  }
}

export async function worldModelCommand(root, positionals, options) {
  const command = positionals[1];
  if (command === 'init') return init(root);
  const config = await load(root);
  if (command === 'prompt') return prompt(root, config, options);
  if (command === 'build') return build(root, config, options);
  if (command === 'context') return context(root, config, positionals[2] ?? optionString(options, 'phase'), options);
  if (command === 'check') {
    const state = freshness(root, await manifest(root, config));
    console.log(state.fresh ? `fresh: ${state.current}` : `stale: ${state.built} != ${state.current}`);
    if (!state.fresh) throw new SingularityFlowError('World model is stale.', { exitCode: 2 });
    return;
  }
  throw new SingularityFlowError('Usage: singularity-flow wm init|prompt|build|context <phase>|check');
}
