/** Isolated local-only qualification fixture; never imported by product commands. */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
export async function createWarmReadFixture({ files = 0, branches = 0, storyMode = 'legacy' } = {}) {
  if (!['legacy', 'pinned'].includes(storyMode)) throw new Error('Unknown qualification Story mode.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-warm-read-'));
  const engine = path.join(directory, 'engine'), repository = path.join(directory, 'repository');
  try {
    await mkdir(engine); await mkdir(repository);
    await Promise.all(['src', 'bin', 'templates', 'plugin', 'schemas', 'package.json', 'scripts',
      'distribution', 'docs', 'revision-trace-manifest.json'].map(name =>
      cp(path.join(source, name), path.join(engine, name), { recursive: true })));
    await symlink(path.join(source, 'node_modules'), path.join(engine, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const stamp = path.join(engine, 'src/build-info.mjs');
    await writeFile(stamp, (await readFile(stamp, 'utf8')).replace('commit: null', `commit: '${'1'.repeat(40)}'`));
    const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
      SINGULARITY_FLOW_BUNDLE: 'off', SINGULARITY_FLOW_GIT_FACT_STORE: 'off',
      HOME: path.join(directory, 'home'), SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(directory, 'workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(directory, 'active.json'),
      SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(directory, 'mode.json'),
      SINGULARITY_FLOW_TEST_IDENTITY: 'Warm Read Tester',
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'chore', agent: 'developer' }) };
    const git = (args, { cwd = repository } = {}) => {
      try {
        // The generated files are known LF text. Suppress setup-only round-trip warnings that
        // otherwise flood Windows pipes; keep autocrlf and every measured checkout unchanged.
        return execFileSync('git', args[0] === 'add' ? ['-c', 'core.safecrlf=false', ...args] : args, {
          cwd, env, encoding: 'utf8', timeout: process.platform === 'win32' ? 120_000 : 30_000,
          maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
        }).trim();
      } catch (error) {
        throw new Error(`Qualification fixture Git '${args[0]}' failed: ${error.message}`, { cause: error });
      }
    };
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'Warm Read Tester']); git(['config', 'user.email', 'warm@example.invalid']);
    await mkdir(path.join(repository, 'singularity/templates/chore'), { recursive: true });
    await writeFile(path.join(repository, 'singularity/templates/chore/intake.md'), '# Intake\n\nDescribe the requested change.\n');
    await writeFile(path.join(repository, 'singularity/workflow.yml'), [
      'version: 2', 'defaultBaseBranch: main', 'workItemRoot: singularity/work-items', 'templatesRoot: singularity/templates',
      'worldModel:', '  views: [arch.contracts@4, biz.rules@4, dev.hotspots@4, dev.impact@4]', '  outputDir: singularity/world-model',
      'phases:', '  intake:', '    id: intake', '    label: Intake', '    writeScope: artifact-only',
      '    defaultTemplate: chore/intake.md', '    artifact:', '      path: artifacts/intake/intake.md',
      'workTypes:', '  chore:', '    label: Chore', '    phases: [intake]', ''
    ].join('\n'));
    const state = {
      schemaVersion: 2, workItem: { id: 'PERF-001', title: 'Read fixture', branch: 'PERF-001', workType: 'chore' },
      status: 'active', currentPhase: 'intake', phaseOrder: ['intake'],
      phases: { intake: { id: 'intake', status: 'in_progress', generation: 0, defaultAgent: 'developer', artifacts: [], approvals: [],
        generationPolicy: { requirement: 'required' }, requiredArtifact: { path: 'artifacts/intake/intake.md' } } },
      resolution: { worldModelGrounding: 'off', collaboration: { assignmentMode: 'off' }, session: {}, contextPolicy: {}, sequenceGates: {} },
      lineage: { canonicalBranch: 'PERF-001', childBranches: [], requiredChecks: [] }, usage: {}, telemetry: {}, history: []
    };
    const statePath = path.join(repository, 'singularity/work-items/PERF-001/workflow.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    if (storyMode === 'pinned') {
      await mkdir(path.join(repository, '.github/agents'), { recursive: true });
      await writeFile(path.join(repository, '.github/agents/developer.agent.md'),
        '---\nname: developer\ndescription: Read qualification\nmetadata:\n  sflow-phases: intake\n---\n# Developer\n\nDraft only the approved intake.\n');
      const { loadDefinition, resolveWorkType, snapshotResolution } = await import(pathToFileURL(path.join(engine, 'src/config.mjs')));
      const { captureWorkflowSnapshot } = await import(pathToFileURL(path.join(engine, 'src/workflow-snapshots.mjs')));
      const definition = await loadDefinition(repository), resolved = resolveWorkType(definition, 'chore');
      state.workItem.createdAt = '2026-10-17T00:00:00.000Z';
      state.resolution = { ...await snapshotResolution(repository, definition, resolved),
        session: {}, sequenceGates: {}, collaboration: { assignmentMode: 'off' }, phases: resolved.phases };
      state.resolution.agents = { developer: state.resolution.agents.developer };
      state.workflowSnapshot = await captureWorkflowSnapshot(repository, definition, state);
    }
    await writeFile(statePath, JSON.stringify(state));
    await mkdir(path.join(repository, 'src'));
    for (let index = 0; index < files; index++) await writeFile(path.join(repository, `src/file-${index}.txt`), `file ${index}\n`);
    git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'local qualification fixture']);
    for (let index = 0; index < branches; index++) git(['branch', `unrelated-${index}`]);
    git(['switch', '-qc', 'PERF-001']);
    let pinnedVerification = null;
    if (storyMode === 'pinned') {
      const { loadAcceptedStoryExecution } = await import(pathToFileURL(path.join(engine, 'src/accepted-story-execution.mjs')));
      const accepted = await loadAcceptedStoryExecution(repository, 'PERF-001');
      if (accepted.executionCatalog?.mode !== 'workflow-snapshot') throw new Error('Pinned qualification lacks an accepted execution closure.');
      pinnedVerification = { mode: accepted.executionCatalog.mode, snapshotHash: accepted.executionCatalog.snapshotHash,
        creationCommit: git(['rev-parse', 'HEAD']) };
    }
    const cli = path.join(engine, 'bin/singularity-flow.mjs');
    const cold = (args, { cwd = repository, json = true } = {}) => {
      const output = execFileSync(process.execPath, [cli, ...args], { cwd, env,
        encoding: 'utf8', timeout: 90_000, maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      return json ? JSON.parse(output) : output;
    };
    return { directory, engine, repository, cli, env, git, state, statePath, cold, storyMode, pinnedVerification,
      cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }) };
  } catch (error) {
    try { await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); }
    catch (cleanup) { console.warn(`Qualification fixture cleanup failed: ${cleanup.code ?? cleanup.message}`); }
    throw error;
  }
}
