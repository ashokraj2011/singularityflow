import { cp, mkdtemp, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { add, branch, changedFiles, head, pushBranch } from './git.mjs';
import { SingularityFlowError, optionBoolean, optionString, posix, run, snapshot, writeJson } from './util.mjs';
import { loadDefinition, WORKFLOW_PATH } from './config.mjs';
import { injectPersonaPrompt, recordInjection } from './inject.mjs';
import { loadSession } from './session.mjs';
import { renderAgentSkills } from './agents.mjs';
import { assertNoPendingPublication, pendingPublicationPath, saveWorkflow } from './state.mjs';
import { assertPhaseSequence } from './sequence.mjs';
import {
  changedSnapshotPaths, groundingMode, repositoryContentSnapshot, resolveWorldModelContext,
  validateWorldModelDirectory, worldModelCommit, worldModelFreshness, worldModelSourceSnapshot
} from './grounding.mjs';

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

async function load(root, { persona: selectedPersona = null } = {}) {
  if (existsSync(path.join(root, WORKFLOW_PATH))) {
    const definition = await loadDefinition(root);
    const session = await loadSession(root, { required: false });
    const activeId = run('git', ['branch', '--show-current'], { cwd: root, allowFailure: true }).stdout.trim();
    const activeStatePath = path.join(root, definition.workItemRoot ?? '.singularity/work-items', activeId, 'workflow.json');
    const activeState = existsSync(activeStatePath) ? JSON.parse(await readFile(activeStatePath, 'utf8')) : null;
    const phaseEntries = activeState?.resolution?.phases?.length
      ? activeState.resolution.phases.map((phase) => [phase.id, phase])
      : Object.entries(definition.phases);
    const persona = selectedPersona ?? session?.persona ?? null;
    const phases = Object.fromEntries(phaseEntries.map(([id, phase]) => {
      const personaViews = persona ? definition.personas[persona]?.worldModelViews ?? [] : [];
      return [id, { views: [...new Set([...(phase.worldModel?.views ?? []), ...personaViews])], depth: phase.worldModel?.depth ?? 'standard', evidence: phase.worldModel?.evidence ?? false }];
    }));
    return {
      definition,
      workflow: activeState,
      workItemRoot: definition.workItemRoot ?? '.singularity/work-items',
      outputDir: definition.worldModel?.outputDir ?? '.singularity/world-model',
      promptSource: definition.worldModel?.promptSource ?? '.singularity/prompts/worldmodel-builder.md',
      runner: definition.worldModel?.runner ?? 'copilot -p "$(cat {prompt_file})" --allow-all-tools',
      grounding: groundingMode(definition, activeState), staleness: definition.worldModel?.staleness ?? 'warn', phases,
      context: { always: ['core/summary.md'], includeDomains: 'matched', includeEvidence: false },
      personaPrompt: persona && definition.personas[persona] ? path.posix.join(definition.personaPromptsRoot, definition.personas[persona].prompt) : null
    };
  }
  const file = path.join(root, configRelative);
  if (!existsSync(file)) throw new SingularityFlowError('World model is not initialized. Run: singularity-flow wm init');
  const user = JSON.parse(await readFile(file, 'utf8'));
  const base = defaults();
  return { ...base, ...user, grounding: user.grounding ?? 'off', phases: { ...base.phases, ...(user.phases ?? {}) }, context: { ...base.context, ...(user.context ?? {}) } };
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

async function installWorldModel(staging, target) {
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const incoming = `${target}.incoming-${process.pid}-${Date.now()}`;
  const backup = `${target}.backup-${process.pid}-${Date.now()}`;
  await rm(incoming, { recursive: true, force: true });
  await cp(staging, incoming, { recursive: true, force: false });
  let backedUp = false;
  try {
    if (existsSync(target)) { await rename(target, backup); backedUp = true; }
    await rename(incoming, target);
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(incoming, { recursive: true, force: true });
    if (backedUp && !existsSync(target) && existsSync(backup)) await rename(backup, target);
    throw error;
  }
}

async function publishWorldModel(root, config, workflow, sourceHash, phase = 'repository') {
  add(root, [config.outputDir]);
  const staged = run('git', ['diff', '--cached', '--quiet', '--', config.outputDir], { cwd: root, allowFailure: true }).status !== 0;
  let commit = worldModelCommit(root, config.outputDir);
  if (staged) {
    run('git', ['commit', '--only', '-m', `[world-model][source:${sourceHash.replace(/^sha256:/, '').slice(0, 12)}] ${phase}`, '--', config.outputDir], { cwd: root, stdio: 'inherit' });
    commit = head(root);
  }
  if ((config.definition?.git?.publish ?? 'required') === 'off') return { commit, pushed: false, changed: staged };
  const remote = config.definition?.git?.remote ?? 'origin';
  const result = pushBranch(root, remote, branch(root));
  if (result.status !== 0) {
    if (workflow?.workItem?.id) {
      await writeJson(pendingPublicationPath(root, config.definition, workflow.workItem.id), {
        schemaVersion: 1, workId: workflow.workItem.id, branch: branch(root), remote,
        commit, createdAt: new Date().toISOString(), error: (result.stderr || result.stdout).trim(), kind: 'world-model'
      });
      throw new SingularityFlowError(`World-model commit ${commit?.slice(0, 8)} was retained locally but push failed. Run singularity-flow sync after fixing remote access.`);
    }
    throw new SingularityFlowError(`World-model commit ${commit?.slice(0, 8)} was retained locally but push failed. Run git push after fixing remote access.`);
  }
  return { commit, pushed: true, changed: staged };
}

async function build(root, config, options) {
  const cacheRoot = path.join(root, '.git/singularity-flow');
  await mkdir(cacheRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-world-model-'));
  const promptFile = path.join(temporary, 'prompt.md');
  const staging = path.join(temporary, 'output');
  const analysisRoot = path.join(temporary, 'repository');
  await mkdir(staging, { recursive: true });
  const source = config.promptSource === 'builtin' ? path.join(packageRoot, 'templates/worldmodel-builder.md') : path.resolve(root, config.promptSource);
  const buildConfig = { ...config, outputDir: staging };
  run('git', ['worktree', 'add', '--detach', analysisRoot, head(root)], { cwd: root, stdio: 'inherit' });
  try {
    for (const relative of changedFiles(root)) {
      const sourceFile = path.join(root, relative);
      const destination = path.join(analysisRoot, relative);
      if (existsSync(sourceFile)) {
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(sourceFile, destination, { recursive: true, force: true });
      } else await rm(destination, { recursive: true, force: true });
    }
    await rm(path.join(analysisRoot, config.outputDir), { recursive: true, force: true });
    await rm(path.join(analysisRoot, config.definition?.workItemRoot ?? '.singularity/work-items'), { recursive: true, force: true });
    await writeFile(promptFile, render(await readFile(source, 'utf8'), analysisRoot, buildConfig, options));
    const before = await repositoryContentSnapshot(analysisRoot);
    const command = (optionString(options, 'runner') ?? config.runner).replaceAll('{prompt_file}', promptFile);
    const result = run('bash', ['-lc', command], { cwd: analysisRoot, stdio: 'inherit', allowFailure: true });
    if (result.status !== 0) throw new SingularityFlowError(`World-model builder exited with status ${result.status}.`);
    const after = await repositoryContentSnapshot(analysisRoot);
    const unexpected = changedSnapshotPaths(before, after);
    if (head(analysisRoot) !== head(root)) unexpected.push('Git history (builder created a commit)');
    if (unexpected.length) throw new SingularityFlowError(`World-model builder modified files outside its isolated output directory: ${unexpected.join(', ')}`);
    const phase = optionString(options, 'phase');
    const requiredViews = phase ? config.phases[phase]?.views ?? [] : [];
    if (phase && !config.phases[phase]) throw new SingularityFlowError(`Unknown world-model phase: ${phase}`);
    const validated = await validateWorldModelDirectory(staging, {
      expectedCommit: head(root), expectedTask: optionString(options, 'task'), requiredViews, requireEvidence: true
    });
    const sourceState = await worldModelSourceSnapshot(root, config.definition ?? config);
    validated.manifest.source_tree_sha256 = sourceState.sha256;
    validated.manifest.generated_for_phase = phase ?? null;
    validated.manifest.requested_views = requiredViews;
    validated.manifest.analysis_depth = optionString(options, 'depth', phase ? config.phases[phase].depth : 'standard');
    await writeJson(path.join(staging, 'manifest.json'), validated.manifest);
    await installWorldModel(staging, path.join(root, config.outputDir));
    const publication = await publishWorldModel(root, config, config.workflow, sourceState.sha256, phase ?? 'repository');
    console.log(`World model built from source ${sourceState.sha256.slice(7, 19)} and recorded in ${publication.commit?.slice(0, 10) ?? 'the working tree'}${publication.pushed ? ' (pushed)' : ''}.`);
  } finally {
    run('git', ['worktree', 'remove', '--force', analysisRoot], { cwd: root, allowFailure: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

async function manifest(root, config) {
  const file = path.join(root, config.outputDir, 'manifest.json');
  if (!existsSync(file)) throw new SingularityFlowError('No world model exists. Run: singularity-flow wm build --phase <phase>');
  return JSON.parse(await readFile(file, 'utf8'));
}

async function context(root, config, phase, options) {
  const resolved = await resolveWorldModelContext(root, config, phase, {
    task: optionString(options, 'task'), evidence: optionBoolean(options, 'evidence'), includePersonaPrompt: optionBoolean(options, 'persona', true)
  });
  const state = resolved.freshness;
  if (!state.fresh && config.staleness === 'fail') throw new SingularityFlowError(`World model is stale (${String(state.built).slice(0, 10)} != ${state.current.slice(0, 10)}). Rebuild it.`);
  if (!state.fresh && config.staleness === 'warn') console.warn(`Warning: world model is stale (${String(state.built).slice(0, 10)} != ${state.current.slice(0, 10)}).`);
  const selected = [...resolved.selected];
  if (optionBoolean(options, 'persona', true) && config.personaPrompt) selected.unshift({
    relative: config.personaPrompt, absolute: path.join(root, config.personaPrompt), level: 0, reason: 'active persona prompt'
  });
  if (optionBoolean(options, 'concat')) {
    for (const item of selected) {
      console.log(`\n<!-- L${item.level} ${item.relative}: ${item.reason} -->\n`);
      process.stdout.write(await readFile(item.absolute ?? path.join(root, config.outputDir, item.relative), 'utf8'));
    }
  } else {
    console.log(`# World-model context: phase=${phase} commit=${String(state.built).slice(0, 10)}${state.fresh ? '' : ' STALE'}`);
    selected.forEach((item) => console.log(`L${item.level}  ${item.absolute ? posix(path.relative(root, item.absolute)) : path.posix.join(config.outputDir, item.relative)}  # ${item.reason}`));
  }
}

function workflowChangedPaths(root, workflow) {
  const pending = changedFiles(root);
  if (!workflow?.workItem?.baseBranch) return pending;
  const committed = run('git', ['diff', '--name-only', `${workflow.workItem.baseBranch}...HEAD`], { cwd: root, allowFailure: true });
  const files = committed.status === 0 ? committed.stdout.split(/\r?\n/).filter(Boolean) : [];
  return [...new Set([...files, ...pending])].map(posix).filter((file) => !file.startsWith('.singularity/')).sort();
}

function groundingSectionsText(selected, rulePaths) {
  const sections = selected.filter((item) => !rulePaths.has(item.path));
  if (!sections.length) return '';
  return [
    '<!-- required repository world-model grounding -->',
    ...sections.map((section) => `\n## Repository grounding: ${section.path}\n\n${section.body.trim()}\n`)
  ].join('\n');
}

async function compose(root, options) {
  const session = await loadSession(root, { required: false });
  const persona = optionString(options, 'persona') ?? session?.persona;
  if (!persona) throw new SingularityFlowError('Provide --persona or start a persona session first.');
  const config = await load(root, { persona });
  const definition = config.definition ?? await loadDefinition(root);
  const workItemRoot = definition.workItemRoot ?? '.singularity/work-items';
  const workflow = config.workflow ?? null;
  const requestedPhase = optionString(options, 'phase');
  const dryRun = optionBoolean(options, 'dry-run');
  if (workflow && !dryRun) {
    const overridesBefore = workflow.sequenceOverrides?.length ?? 0;
    await assertNoPendingPublication(root, definition, workflow, 'compose and record a generation prompt');
    await assertPhaseSequence(root, workflow, 'compose and record a generation prompt', { requestedPhase });
    if ((workflow.sequenceOverrides?.length ?? 0) > overridesBefore) await saveWorkflow(root, definition, workflow);
  }
  const sourcePath = workflow ? path.join(root, workItemRoot, workflow.workItem.id, 'source.json') : null;
  const source = sourcePath && existsSync(sourcePath) ? JSON.parse(readFileSync(sourcePath, 'utf8')) : null;
  const signals = {
    persona,
    phase: requestedPhase ?? workflow?.currentPhase ?? null,
    workType: workflow?.workItem?.workType ?? null,
    changedPaths: workflowChangedPaths(root, workflow),
    labels: source?.labels ?? []
  };
  if (!signals.phase) throw new SingularityFlowError('Provide --phase or run from an active work-item branch.');
  const required = await resolveWorldModelContext(root, config, signals.phase, {
    task: optionString(options, 'task'), evidence: optionBoolean(options, 'evidence')
  });
  if (!required.freshness.fresh) {
    const message = `World model is stale (${String(required.freshness.built).slice(0, 18)} != ${required.freshness.current.slice(0, 18)}).`;
    if (config.staleness === 'fail') throw new SingularityFlowError(`${message} Rebuild it.`);
    if (config.staleness === 'warn') console.error(`Warning: ${message}`);
  }
  const { text, injection } = await injectPersonaPrompt(root, definition, persona, signals);
  const phase = workflow?.phases?.[signals.phase] ?? null;
  if (workflow && !phase) throw new SingularityFlowError(`Unknown workflow phase '${signals.phase}'.`);
  const remote = phase ? await renderAgentSkills(root, workflow, phase, session ? { ...session, persona } : null, {
    record: !dryRun,
    itemDirectory: path.join(root, workItemRoot, workflow.workItem.id)
  }) : { text: '', skills: [], warnings: [] };
  const mandatory = [];
  for (const item of required.selected) {
    const content = await readFile(item.absolute, 'utf8');
    mandatory.push({
      path: posix(path.join(config.outputDir, item.relative)), sha256: item.sha256, bytes: item.size,
      injectedBytes: item.size, truncated: false, level: item.level, reason: item.reason, category: 'required', body: content
    });
  }
  const rulePaths = new Set(injection.sections.map((section) => section.path));
  const requiredText = groundingSectionsText(mandatory, rulePaths);
  const pieces = [text.trimEnd(), requiredText, remote.text].filter((part) => part?.trim());
  const composedText = `${pieces.join('\n\n')}\n`;
  remote.warnings.forEach((warning) => console.error(`Warning: ${warning}`));
  const manifestInfo = await snapshot(path.join(root, config.outputDir, 'manifest.json'));
  const modelCommit = worldModelCommit(root, config.outputDir);
  const modelChanges = run('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', config.outputDir], { cwd: root }).stdout.trim();
  if (modelChanges && config.grounding === 'enforce') throw new SingularityFlowError('The world-model directory has uncommitted changes. Rebuild it before composing a governed prompt.');
  if (modelChanges && config.grounding === 'warn') console.error('Warning: the world-model directory has uncommitted changes; its committed hashes will not verify.');
  if (config.grounding === 'enforce' && !modelCommit) throw new SingularityFlowError('The world model is not committed. Run singularity-flow wm build --phase <phase> before composing a governed prompt.');
  if (config.grounding === 'enforce' && !required.freshness.fresh) throw new SingularityFlowError('The world model is stale. Rebuild it before composing a governed prompt.');
  const files = [...mandatory, ...injection.sections.map((section) => ({ ...section, category: 'rule', level: null, reason: 'matched injection rule' }))]
    .filter((section, index, all) => all.findIndex((candidate) => candidate.path === section.path) === index);

  if (dryRun) {
    console.log(`phase: ${signals.phase}  persona: ${persona}  required files: ${mandatory.length}  rules matched: ${injection.matchedRules}  rule files: ${injection.sections.length}  remote skills: ${remote.skills.length}  fresh: ${required.freshness.fresh ? 'yes' : 'no'}`);
    files.forEach((section) => console.log(`  ${section.category}:${section.path} (${section.injectedBytes}/${section.bytes} bytes)${section.truncated ? ' (truncated)' : ''}`));
    remote.skills.forEach((skill) => console.log(`  agent:${session?.agent ?? 'unknown'}/${skill.id} (${skill.size} bytes) @${skill.sha256.slice(0, 12)}`));
    return;
  }

  if (workflow) {
    const renderedSha256 = createHash('sha256').update(composedText).digest('hex');
    const { file } = await recordInjection(root, workflow, phase, {
      ...injection, persona, sections: files, modelCommit,
      manifestSha256: manifestInfo.sha256,
      modelSourceTreeSha256: required.manifest.source_tree_sha256 ?? null,
      composedSourceTreeSha256: required.freshness.current,
      fresh: required.freshness.fresh,
      renderedSha256,
      renderedText: composedText,
      requiredViews: config.phases[signals.phase]?.views ?? [],
      task: optionString(options, 'task') ?? null
    }, { workDir: path.join(root, workItemRoot, workflow.workItem.id) });
    console.error(`Grounding composition recorded: ${file}`);
  }
  const destination = optionString(options, 'out');
  if (destination) {
    await writeFile(path.resolve(root, destination), composedText);
    console.log(`Composed prompt written to ${destination}.`);
  } else process.stdout.write(composedText);
}

export async function worldModelCommand(root, positionals, options) {
  const command = positionals[1];
  if (command === 'init') return init(root);
  if (command === 'inject' || command === 'compose') return compose(root, options);
  const config = await load(root);
  if (command === 'prompt') return prompt(root, config, options);
  if (command === 'build') return build(root, config, options);
  if (command === 'context') return context(root, config, positionals[2] ?? optionString(options, 'phase'), options);
  if (command === 'check') {
    const model = await manifest(root, config);
    await validateWorldModelDirectory(path.join(root, config.outputDir), { requiredViews: model.requested_views ?? [], requireEvidence: true });
    const state = await worldModelFreshness(root, config, model);
    console.log(state.fresh ? `fresh: ${state.current}` : `stale: ${state.built} != ${state.current}`);
    if (!state.fresh) throw new SingularityFlowError('World model is stale.', { exitCode: 2 });
    return;
  }
  throw new SingularityFlowError('Usage: singularity-flow wm init|prompt|build|context <phase>|compose|inject|check');
}
