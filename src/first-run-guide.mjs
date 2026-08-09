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

/**
 * Runs a real isolated quick-fix lifecycle without a network, remote, Jira account, or model.
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
    await writeFile(path.join(repository, 'greeting.txt'), 'Hello, world.\n');
    run('git', ['add', 'greeting.txt'], { cwd: repository });
    run('git', ['commit', '-m', 'Create the guide repository'], { cwd: repository });

    await initializeDefinition(repository);
    await configureRepository(repository);
    run('git', ['add', '--', ...GOVERNED_ROOTS], { cwd: repository });
    run('git', ['commit', '-m', 'Initialize Singularity Flow'], { cwd: repository });

    const story = path.join(directory, 'story.yml');
    await writeFile(story, YAML.stringify({
      title: 'Correct the greeting punctuation',
      description: 'Change the toy greeting while exercising the governed quick-fix path.',
      desiredOutcome: 'The greeting is precise and the lifecycle completes without network access.',
      acceptanceCriteria: ['The greeting says Hello, Singularity Flow!', 'The verification evidence records the changed file.'],
      risk: 'low',
      repositoryCount: 1
    }));

    steps.push(command(cli, repository, ['start', 'TOY-001', '--story-file', story, '--work-type', 'quick-fix', '--agent', 'developer'], env));
    await writeFile(path.join(repository, 'greeting.txt'), 'Hello, Singularity Flow!\n');
    steps.push(command(cli, repository, ['prepare', 'implement'], env));
    steps.push(command(cli, repository, ['phase', 'publish', 'implement', '--authored', 'deterministic'], env));
    steps.push(command(cli, repository, ['submit', 'implement'], env));
    steps.push(command(cli, repository, ['prepare', 'verify'], env));
    steps.push(command(cli, repository, ['phase', 'publish', 'verify', '--authored', 'deterministic'], env));
    steps.push(command(cli, repository, ['submit', 'verify'], env));
    const status = command(cli, repository, ['status', 'TOY-001', '--json'], env);
    steps.push(status);
    const workflow = JSON.parse(status.rawOutput);
    if (workflow.status !== 'complete') throw new SingularityFlowError(`Guide finished with state '${workflow.status ?? 'unknown'}', not complete.`);
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
