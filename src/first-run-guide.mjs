import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { GOVERNED_ROOTS, initializeDefinition } from './config.mjs';
import { nowIso, run, SingularityFlowError } from './util.mjs';

function boundedOutput(text, limit = 4_000) {
  const value = text.trim();
  if (value.length <= limit) return { output: value, outputTruncated: false };
  return { output: `${value.slice(0, limit)}\n… output truncated …`, outputTruncated: true };
}

function command(cli, root, args, env) {
  const result = run(process.execPath, [cli, ...args], { cwd: root, env, allowFailure: true });
  if (result.status !== 0) {
    throw new SingularityFlowError(
      `First-run step failed: singularity-flow ${args.join(' ')}\n${result.stderr.trim() || result.stdout.trim()}`
    );
  }
  const record = { command: `singularity-flow ${args.join(' ')}`, ...boundedOutput(result.stdout) };
  Object.defineProperty(record, 'rawOutput', { value: result.stdout.trim(), enumerable: false });
  return record;
}

async function configureRepository(root) {
  const file = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(file, 'utf8'));
  definition.git.publish = 'off';
  definition.worldModel.grounding = 'off';
  await writeFile(file, YAML.stringify(definition));
}

function greetingSource(greeting, { story = false } = {}) {
  return `${story ? '// @clause:TOY-001:AC-001\n' : ''}export const greeting = ${JSON.stringify(greeting)};\n`;
}

function greetingTest(expected, { story = false } = {}) {
  return [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { greeting } from '../greeting.mjs';",
    '',
    ...(story ? ['/** @ac:TOY-001:AC-001 */'] : []),
    "test('the governed greeting is exact', () => {",
    `  assert.equal(greeting, ${JSON.stringify(expected)});`,
    '});',
    ''
  ].join('\n');
}

/** The toy Story's scope-and-plan checkpoint: one criterion, the file that meets it and its test. */
const TOY_INTAKE = [
  '# TOY-001 — Quick fix scope and plan', '',
  '## Problem and fix', '', 'The toy greeting says Hello, world. and should name Singularity Flow.', '',
  '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
  '| [TOY-001:AC-001] | The greeting says Hello, Singularity Flow! |', '',
  '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
  '| `TOY-001:AC-001` | `greeting.mjs` | `tests/greeting.test.mjs` |', '',
  '## Out of scope', '', 'Nothing but the greeting and its test changes.', ''
].join('\n');

/**
 * Runs a real isolated quick-fix lifecycle without network access, Jira, or a model. A local bare
 * remote exercises the same explicit remote-base contract as a team repository.
 * A failed walkthrough remains on disk with diagnostics so the failure can be reproduced.
 */
export async function runFirstRunGuide({ keep = false, onBoundary } = {}) {
  const startedAt = nowIso();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-first-run-'));
  const repository = path.join(directory, 'greeting-service');
  const home = path.join(directory, 'home');
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/singularity-flow.mjs');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NODE_ENV: 'production',
    NO_COLOR: '1'
  };
  const steps = [];
  let completed = false;
  try {
    onBoundary?.(directory);
    await mkdir(repository, { recursive: true });
    await mkdir(home, { recursive: true });
    run('git', ['init', '--initial-branch=main'], { cwd: repository });
    run('git', ['config', 'user.name', 'Singularity Flow Guide'], { cwd: repository });
    run('git', ['config', 'user.email', 'guide@localhost'], { cwd: repository });
    await writeFile(path.join(repository, 'greeting.mjs'), greetingSource('Hello, world.'));
    // The demo starts from a real passing baseline, just like an application repository. All
    // tests use Node built-ins; there are no packages to restore or download for this walkthrough.
    await writeFile(path.join(repository, 'package.json'), `${JSON.stringify({
      name: 'sflow-guide-greeting', private: true, type: 'module',
      scripts: { test: 'node --test' }
    }, null, 2)}\n`);
    await mkdir(path.join(repository, 'tests'), { recursive: true });
    await writeFile(path.join(repository, 'tests/greeting.test.mjs'), greetingTest('Hello, world.'));
    run('git', ['add', 'greeting.mjs', 'package.json', 'tests/greeting.test.mjs'], { cwd: repository });
    run('git', ['commit', '-m', 'Create the guide repository'], { cwd: repository });

    await initializeDefinition(repository);
    await configureRepository(repository);
    run('git', ['add', '--', ...GOVERNED_ROOTS], { cwd: repository });
    run('git', ['commit', '-m', 'Initialize Singularity Flow'], { cwd: repository });
    const remote = path.join(directory, 'origin.git');
    run('git', ['clone', '--bare', '--', repository, remote], { cwd: directory });
    run('git', ['remote', 'add', 'origin', remote], { cwd: repository });

    const story = path.join(directory, 'story.yml');
    await writeFile(story, YAML.stringify({
      title: 'Correct the greeting punctuation',
      description: 'Change the toy greeting while exercising the governed quick-fix path.',
      desiredOutcome: 'The greeting is precise and the lifecycle completes without network access.',
      acceptanceCriteria: ['The greeting says Hello, Singularity Flow!', 'The verification evidence records the changed file.'],
      risk: 'low',
      repositoryCount: 1
    }));

    const preview = command(cli, repository, ['precheck', '--run', '--scope', 'dependency-test', '--json'], env);
    steps.push(preview);
    const plan = JSON.parse(preview.rawOutput).data?.plan;
    if (plan?.status !== 'ready' || plan.scope !== 'dependency-test'
        || plan.blockers?.length !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(plan.planId)
        || plan.commands?.length !== 1 || plan.commands[0].purpose !== 'test') {
      throw new SingularityFlowError('The isolated guide requires one ready, dependency-free test plan before Story start.');
    }
    // This confirms only the fixed demo's plan, never a user's repository or a human risk decision.
    steps.push(command(cli, repository, ['precheck', '--run', '--scope', 'dependency-test',
      '--confirm-plan', plan.planId, '--json'], env));
    steps.push(command(cli, repository, ['start', 'TOY-001', '--from-branch', 'main', '--story-file', story, '--work-type', 'quick-fix', '--agent', 'developer'], env));
    // Quick fix signs off its scope and plan before any code changes.
    steps.push(command(cli, repository, ['prepare', 'intake'], env));
    await writeFile(path.join(repository, 'singularity/work-items/TOY-001/artifacts/intake/intake.md'), TOY_INTAKE);
    steps.push(command(cli, repository, ['wm', 'compose', '--phase', 'intake'], env));
    steps.push(command(cli, repository, ['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place'], env));
    steps.push(command(cli, repository, ['submit', 'intake'], env));
    steps.push(command(cli, repository, ['approve', 'intake', '--yes'], env));
    steps.push(command(cli, repository, ['prepare', 'implement'], env));
    await writeFile(path.join(repository, 'greeting.mjs'), greetingSource('Hello, Singularity Flow!', { story: true }));
    await writeFile(path.join(repository, 'tests/greeting.test.mjs'), greetingTest('Hello, Singularity Flow!', { story: true }));
    steps.push(command(cli, repository, ['phase', 'publish', 'implement', '--authored', 'deterministic'], env));
    steps.push(command(cli, repository, ['submit', 'implement'], env));
    steps.push(command(cli, repository, ['prepare', 'verify'], env));
    steps.push(command(cli, repository, ['phase', 'publish', 'verify', '--authored', 'deterministic'], env));
    steps.push(command(cli, repository, ['submit', 'verify'], env));
    const status = command(cli, repository, ['status', 'TOY-001', '--json'], env);
    steps.push(status);
    const workflow = JSON.parse(status.rawOutput);
    if (workflow.status !== 'closed') throw new SingularityFlowError(`Guide finished with state '${workflow.status ?? 'unknown'}', not closed.`);
    const finalStateBytes = await readFile(path.join(repository, 'singularity/work-items/TOY-001/workflow.json'));
    completed = true;
    return {
      schemaVersion: 1,
      completed,
      networkAccess: false,
      modelInvocations: 0,
      workId: 'TOY-001',
      repository,
      retained: keep,
      interactionCount: 1,
      typedCommandCount: 1,
      finalStateSha256: createHash('sha256').update(finalStateBytes).digest('hex'),
      startedAt,
      completedAt: nowIso(),
      steps
    };
  } catch (error) {
    await writeFile(path.join(directory, 'failure.json'), `${JSON.stringify({
      failedAt: nowIso(),
      error: { name: error.name, message: error.message },
      steps
    }, null, 2)}\n`).catch(() => {});
    error.details = { ...(error.details ?? {}), guideDirectory: directory };
    throw error;
  } finally {
    if (completed && !keep) await rm(directory, { recursive: true, force: true });
  }
}
