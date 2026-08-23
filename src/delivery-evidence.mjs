import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { isTestAutomationPath } from './source-boundary.mjs';
import { SingularityFlowError, exists, posix, snapshot } from './util.mjs';
import {
  changedApplicationPathsSinceBaseline, verifyWorkIntervalBaseline
} from './work-intervals.mjs';

export { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';

export async function acceptanceIds(root, config, workflow, phase) {
  if (!config.governance?.requireAcceptanceCriteriaTags) return [];
  const position = workflow.phaseOrder.indexOf(phase.id);
  const ids = new Set();
  for (const phaseId of workflow.phaseOrder.slice(0, Math.max(0, position))) {
    const prior = workflow.phases[phaseId];
    if (!prior?.requiredArtifact?.path) continue;
    const relative = posix(path.join(
      config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
      prior.requiredArtifact.path
    ));
    const absolute = path.join(root, relative);
    if (!(await exists(absolute))) continue;
    const text = await readFile(absolute, 'utf8');
    for (const match of text.matchAll(/\bAC-\d+\b/g)) ids.add(match[0]);
  }
  return [...ids].sort();
}

async function taggedAcceptanceIds(root, testPaths) {
  const ids = new Set();
  for (const relative of testPaths) {
    const absolute = path.join(root, relative);
    if (!(await exists(absolute))) continue;
    const text = await readFile(absolute, 'utf8');
    for (const match of text.matchAll(/@ac:\s*(AC-\d+)/g)) ids.add(match[1]);
  }
  return [...ids].sort();
}

async function pathEvidence(root, paths) {
  const records = [];
  for (const relative of paths) {
    const current = await snapshot(path.join(root, relative));
    records.push({
      path: relative,
      kind: isTestAutomationPath(relative) ? 'test' : 'source',
      exists: current.exists,
      size: current.size,
      sha256: current.sha256
    });
  }
  return records;
}

/** Refuse a code phase before generation state or telemetry is mutated. */
export async function evaluateCodeDeliveryPreflight(root, config, workflow, phase) {
  if (!phaseRequiresCodeDelivery(phase)) return null;
  if ((phase.writeScope ?? 'artifact-only') !== 'source-and-artifact') {
    throw new SingularityFlowError(
      `Phase '${phase.id}' is a code-generation phase but its write scope does not permit source changes.`,
      { code: 'CODE_DELIVERY_SCOPE_INVALID' }
    );
  }

  const itemDirectory = path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  await verifyWorkIntervalBaseline(root, config, workflow, { phaseId: phase.id, itemDirectory });
  const changedPaths = changedApplicationPathsSinceBaseline(root, workflow, { phaseId: phase.id });
  const changedTestPaths = changedPaths.filter(isTestAutomationPath);
  const intentRevalidation = Boolean(
    phase.intentAmendmentRevalidation?.id && !phase.intentAmendmentRevalidation?.revalidatedAt
  );
  // A correction generation may exercise acceptance tests delivered by its previous generation
  // without changing their source merely to satisfy the gate. Reuse only the exact governed test
  // paths from the prior receipt; first generations still have to introduce/change their tests.
  const reusableTestPaths = Number(phase.generation ?? 0) > 0
    ? (phase.deliveryEvidence?.testPaths ?? []).filter((candidate) => !changedTestPaths.includes(candidate))
    : [];
  const testPaths = [...new Set([...changedTestPaths, ...reusableTestPaths])].sort();
  const changedSourcePaths = changedPaths.filter((candidate) => !isTestAutomationPath(candidate));
  const reusableSourcePaths = intentRevalidation
    ? (phase.deliveryEvidence?.sourcePaths ?? []).filter((candidate) => !changedSourcePaths.includes(candidate))
    : [];
  const sourcePaths = [...new Set([...changedSourcePaths, ...reusableSourcePaths])].sort();
  const errors = [];

  if (!changedPaths.length && !intentRevalidation) {
    errors.push('no application source or test paths changed during the governed work interval');
  }
  if (phase.sourceBoundary !== 'test-automation' && !sourcePaths.length) {
    errors.push('no product source path changed; a summary or test-only edit is not an implementation');
  }
  if (!testPaths.length) errors.push('no acceptance test is available for the implementation');

  const requiredAcIds = await acceptanceIds(root, config, workflow, phase);
  const taggedAcIds = await taggedAcceptanceIds(root, testPaths);
  const missingAcIds = requiredAcIds.filter((id) => !taggedAcIds.includes(id));
  if (missingAcIds.length) {
    errors.push(`changed tests do not contain required traceability tags: ${missingAcIds.map((id) => `@ac:${id}`).join(', ')}`);
  }
  if (errors.length) {
    throw new SingularityFlowError(
      `Phase ${phase.id} has no publishable code delivery:\n- ${errors.join('\n- ')}\n`
      + 'Implement the approved behavior, add acceptance-mapped tests, and publish again.',
      { code: 'CODE_DELIVERY_EVIDENCE_REQUIRED' }
    );
  }

  return {
    requirement: 'source-and-tests',
    baselineCommit: workflow.workIntervals.current.sourceBaseCommit,
    paths: await pathEvidence(root, [...new Set([
      ...changedPaths, ...reusableSourcePaths, ...reusableTestPaths
    ])].sort()),
    sourcePaths,
    testPaths,
    intentRevalidation: intentRevalidation ? phase.intentAmendmentRevalidation.id : null,
    acceptanceCriteria: { required: requiredAcIds, tagged: taggedAcIds, missing: [] }
  };
}

function commandText(command) {
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.join(' ');
  if (Array.isArray(command?.argv)) return command.argv.join(' ');
  return String(command?.command ?? '');
}

function commandTokens(command) {
  if (Array.isArray(command)) return command.map(String);
  if (Array.isArray(command?.argv)) return command.argv.map(String);
  return commandText(command).trim().split(/\s+/).filter(Boolean);
}

function executableName(value) {
  return path.basename(String(value ?? '')).toLowerCase().replace(/\.(?:cmd|exe)$/i, '');
}

/** A code receipt must execute tests; lint/compile/diff commands alone are not sufficient. */
export function isTestQualityCommand(command) {
  const [rawExecutable, ...rawArguments] = commandTokens(command);
  const executable = executableName(rawExecutable);
  const args = rawArguments.map((argument) => argument.toLowerCase());
  const hasTask = (names) => args.some((argument) => names.has(argument.replace(/^.*:/, '')));

  if (['mvn', 'mvnw'].includes(executable)) return hasTask(new Set(['test', 'verify', 'integration-test']));
  if (['gradle', 'gradlew'].includes(executable)) return hasTask(new Set(['test', 'check']));
  if (['go', 'cargo', 'dotnet', 'swift'].includes(executable)) return args[0] === 'test';
  if (['pytest', 'jest', 'vitest', 'mocha'].includes(executable)) return true;
  if (['python', 'python3', 'py'].includes(executable)) {
    return args.some((argument, index) => argument === '-m' && ['pytest', 'unittest'].includes(args[index + 1]));
  }
  if (executable === 'node') return args.some((argument) => argument === '--test' || argument.startsWith('--test='));
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    if (args[0] === 'test') return true;
    const script = args[0] === 'run' ? args[1] : args[0];
    return /(^|[:_-])(test|tests|acceptance|e2e|integration|unit)(?:$|[:_.-])/.test(script ?? '');
  }
  if (['npx', 'pnpx', 'yarnx', 'bunx'].includes(executable)) {
    const packageIndex = args.findIndex((argument) => !argument.startsWith('-'));
    const runner = executableName(args[packageIndex]);
    const runnerArgs = args.slice(packageIndex + 1);
    if (['jest', 'vitest', 'mocha'].includes(runner)) return true;
    if (runner === 'playwright') return runnerArgs.includes('test');
  }
  if (['bash', 'sh', 'zsh'].includes(executable)) {
    return /(^|[._-])(test|tests|acceptance|e2e)(?:[._-]|$)/.test(executableName(args[0]));
  }
  return /(^|[._-])(test|tests|acceptance|e2e)(?:[._-]|$)/.test(executable);
}

/** Repository-native, deterministic defaults. No model is needed to identify a build manifest. */
export async function inferRepositoryTestCommands(root) {
  const regular = async (relative) => await exists(path.join(root, relative));
  if (await regular('mvnw')) return [{ id: 'maven-tests', argv: ['./mvnw', '-q', 'test'], modelPolicy: 'never' }];
  if (await regular('pom.xml')) return [{ id: 'maven-tests', argv: ['mvn', '-q', 'test'], modelPolicy: 'never' }];
  if (await regular('gradlew')) return [{ id: 'gradle-tests', argv: ['./gradlew', 'test'], modelPolicy: 'never' }];
  if (await regular('build.gradle') || await regular('build.gradle.kts')) {
    return [{ id: 'gradle-tests', argv: ['gradle', 'test'], modelPolicy: 'never' }];
  }
  if (await regular('go.mod')) return [{ id: 'go-tests', argv: ['go', 'test', './...'], modelPolicy: 'never' }];
  if (await regular('Cargo.toml')) return [{ id: 'cargo-tests', argv: ['cargo', 'test'], modelPolicy: 'never' }];
  if (await regular('pyproject.toml') || await regular('pytest.ini')) {
    return [{ id: 'python-tests', argv: ['python3', '-m', 'pytest'], modelPolicy: 'never' }];
  }
  if (await regular('package.json')) {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const script = String(manifest.scripts?.test ?? '').trim();
    if (script && !/no test specified/i.test(script)) {
      if (await regular('pnpm-lock.yaml')) return [{ id: 'node-tests', argv: ['pnpm', 'test'], modelPolicy: 'never' }];
      if (await regular('yarn.lock')) return [{ id: 'node-tests', argv: ['yarn', 'test'], modelPolicy: 'never' }];
      if (await regular('bun.lockb') || await regular('bun.lock')) return [{ id: 'node-tests', argv: ['bun', 'test'], modelPolicy: 'never' }];
      return [{ id: 'node-tests', argv: ['npm', 'test'], modelPolicy: 'never' }];
    }
  }
  return [];
}

export async function resolveDeliveryQualityCommands(root, phase) {
  const configured = [...(phase.qualityCommands ?? [])];
  if (!phaseRequiresCodeDelivery(phase)) return configured;
  const inferred = await inferRepositoryTestCommands(root);
  if (!inferred.length) {
    const tests = phase.deliveryEvidence?.testPaths ?? [];
    if (tests.length && tests.every((candidate) => /\.(?:c|m)?js$/i.test(candidate))) {
      inferred.push({ id: 'node-tests', argv: ['node', '--test', ...tests], modelPolicy: 'never' });
    }
  }
  const seen = new Set(configured.map(commandText));
  return [...configured, ...inferred.filter((command) => !seen.has(commandText(command)))];
}
