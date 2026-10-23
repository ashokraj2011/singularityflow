/**
 * Local test runs a person starts with `tests run` [RUN M2]: a capability preview outside any
 * Story, and a Story step's run staged as attempts. Both use the gates' own kernel pieces from
 * state.mjs, so they run exactly what publication runs; nothing here admits or publishes.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { evaluateCodeDeliveryPreflight, phaseRequiresCodeDelivery, resolveDeliveryQualityCommands, testCommandProvenance } from './delivery-evidence.mjs';
import { normalizeRequiredTestCommand, parseTestResult, structuredTestCommandRequiredError } from './code-delivery-tests.mjs';
import { evaluateExternalCommandForModelMode } from './external-command-policy.mjs';
import { head } from './git.mjs';
import { operationContext } from './operation-context.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { runQualityCommand, withoutHostSurfaceVariables } from './quality-command-runner.mjs';
import { localTestRunKernel as kernel, sourceTreeHash } from './state-stores.mjs';
import { workDirRelative } from './story-paths.mjs';
import { normalizeTestRuntime, testRuntimeEnvironment, testRuntimeIdentity } from './test-runtime.mjs';
import { nowIso, secureRepositoryPath, SingularityFlowError } from './util.mjs';
import { recordTestAttempt } from './verification/attempts.mjs';
import { nodeTestReporterEnvironment } from './verification/node-test-observation.mjs';
import { prepareInferredSwiftTestReports } from './verification/swift-reports.mjs';

/**
 * Run one quality command for a local preview outside any Story [RUN M2], the way the code step
 * runs it: the secured working directory, a freshly cleared report path, the approved test runtime,
 * the Node reporter and the same stdout capture, through runQualityCommand. Nothing is recorded in a
 * Story and nothing is admitted. `materialized` (from the environment runner boundary) gives one
 * environment's values to this process only and redacts its output and report.
 */
export async function runLocalPreviewQualityCommand(root, config, value, { index = 0, materialized = null } = {}) {
  const modelEnabled = operationContext()?.modelMode?.enabled !== false;
  const policy = evaluateExternalCommandForModelMode(value, {
    modelEnabled, unknownStrictness: config.noModel?.unknownExternalCommands ?? 'warn', index
  });
  const command = policy.command ?? policy.argv.join(' ');
  const sourceCommit = head(root);
  const sourceTreeSha256 = await sourceTreeHash(root, config);
  const startedAt = nowIso();
  if (policy.action !== 'run' && policy.action != null) {
    return { policy, check: { id: policy.id, command, kind: policy.kind, requirement: policy.requirement, sourceCommit,
      sourceTreeSha256, startedAt, completedAt: nowIso(), status: 'skipped-warning', exitCode: null, stdout: '', stderr: policy.reason } };
  }
  const commandRoot = (await secureRepositoryPath(root,
    policy.workingDirectory && policy.workingDirectory !== '.' ? policy.workingDirectory : '.',
    { label: `Quality command '${policy.id}' working directory`, mustExist: true, type: 'directory' })).absolute;
  let restore = null;
  let structuredResultTarget = null;
  try {
    if (policy.kind === 'test' && policy.result?.path) {
      const repositoryRoot = (await secureRepositoryPath(root, '.', { label: 'Repository root', mustExist: true, type: 'directory' })).absolute;
      const resultTarget = path.resolve(commandRoot, policy.result.path);
      if (resultTarget !== repositoryRoot && !resultTarget.startsWith(`${repositoryRoot}${path.sep}`)) {
        throw new SingularityFlowError(`Test result path resolves outside the repository: ${policy.result.path}`, { code: 'CODE_TEST_RESULT_REQUIRED' });
      }
      await mkdir(path.dirname(resultTarget), { recursive: true });
      const staged = await kernel.stageTransientQualityResult(repositoryRoot, commandRoot, policy.result.path, policy.result.adapter);
      restore = staged.restore;
      await staged.clear();
      structuredResultTarget = resultTarget;
    }
    await prepareInferredSwiftTestReports(root, policy);
    let commandEnvironment = { ...process.env };
    const testRuntime = normalizeTestRuntime(config.repositoryReadiness?.testRuntime);
    if (policy.kind === 'test') commandEnvironment = testRuntimeEnvironment(testRuntime, commandEnvironment);
    if (policy.kind === 'test' && policy.result?.adapter === 'node-tap') {
      commandEnvironment = nodeTestReporterEnvironment(commandEnvironment, root, { argv: policy.argv, cwd: commandRoot });
    }
    delete commandEnvironment.NODE_TEST_CONTEXT;
    commandEnvironment = withoutHostSurfaceVariables(commandEnvironment);
    if (policy.kind === 'test' && policy.result?.adapter === 'playwright-json' && structuredResultTarget) {
      for (const key of Object.keys(commandEnvironment)) {
        if (key.toLocaleUpperCase('en-US') === 'PLAYWRIGHT_JSON_OUTPUT_FILE') delete commandEnvironment[key];
      }
      commandEnvironment.PLAYWRIGHT_JSON_OUTPUT_FILE = structuredResultTarget;
    }
    if (materialized) commandEnvironment = materialized.childEnvironment(commandEnvironment);
    const timeoutMs = policy.timeoutMs ?? kernel.defaultTimeoutMs;
    const result = policy.argv
      ? await runQualityCommand(policy.argv[0], policy.argv.slice(1), {
        cwd: commandRoot, env: commandEnvironment, timeoutMs, killTree: true,
        stdoutFile: kernel.stdoutReportCaptured(policy) ? structuredResultTarget : null,
        redactor: materialized?.redactsAnything ? materialized.streamRedactor : null
      })
      : await runQualityCommand(policy.command, [], { cwd: commandRoot, env: commandEnvironment, shell: true, timeoutMs, killTree: true });
    if (materialized?.redactsAnything && policy.kind === 'test') {
      await (await import('./code-delivery-tests.mjs')).redactTestReportFiles(root, policy, materialized.redact);
    }
    const infrastructureError = result.error ? `Unable to run quality command: ${result.error.message}` : null;
    const check = {
      id: policy.id, command, kind: policy.kind, requirement: policy.requirement, workingDirectory: policy.workingDirectory,
      resultIsolated: Boolean(structuredResultTarget), externalModelPolicy: policy.modelPolicy, timeoutMs,
      sourceCommit, sourceTreeSha256,
      ...(policy.kind === 'test' ? { testRuntime: testRuntimeIdentity(testRuntime, commandEnvironment) } : {}),
      startedAt, completedAt: nowIso(),
      status: result.timedOut || infrastructureError ? 'blocked' : result.status === 0 ? 'passed' : 'failed',
      ...(result.error?.code === 'ENOENT' ? { infrastructureUnavailable: true } : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
      exitCode: result.status, signal: result.signal ?? null, stdout: kernel.boundedQualityDiagnostic(result.stdout),
      stderr: kernel.boundedQualityDiagnostic(result.timedOut ? `Command exceeded its ${timeoutMs}ms timeout.` : infrastructureError ?? result.stderr),
      stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes,
      stdoutTruncated: result.stdoutTruncated || String(result.stdout ?? '').length > 2000,
      stderrTruncated: result.stderrTruncated || String(result.stderr ?? '').length > 2000
    };
    // The report is read now, while it is the fresh file this invocation wrote.
    let parsed = null;
    let reportError = null;
    if (policy.kind === 'test' && check.status !== 'blocked' && policy.result?.path) {
      try { parsed = await parseTestResult(root, value, { startedAt }); }
      catch (error) { reportError = String(error?.message ?? error).slice(0, 500); }
    }
    return { policy, check, parsed, reportError };
  } finally {
    // A native report location keeps the fresh report, as an accepted run does; a disposable
    // .sflow/results report returns to what was there before, as for any run that is not evidence.
    await restore?.({ accepted: true });
  }
}

/**
 * Run a Story step's test commands locally and stage one attempt per command [RUN M2], exactly as
 * publish preflight stages them, with purpose `local`. The attempts stay in the checkout's private
 * Git storage until the step's next publication or submission admits them; this never admits,
 * publishes, submits or changes the Story. `select` narrows the resolved commands.
 */
export async function stageStoryLocalTests(root, config, workflow, {
  phaseId = null, select = (commands) => commands, localRunId, uncommittedChanges = null,
  ranBy = null, requestedEnvironment = null
} = {}) {
  const { phase, commands: resolved } = await resolveStoryLocalTestCommands(root, config, workflow, { phaseId });
  const commands = await select(resolved);
  if (!commands.length) throw structuredTestCommandRequiredError(phase, { workId: workflow.workItem.id });
  const checks = await kernel.qualityChecks(root, phase, config, workflow, commands, {
    commandProvenance: new Map(commands.map((command) => [command, command.provenance])),
    localRun: { ranBy, requestedEnvironment }
  });
  const attempts = [];
  try {
    for (const command of commands) {
      const check = checks.find((entry) => entry.id === command.id);
      if (!check) continue;
      const recorded = await recordTestAttempt(root, workDirRelative(config, workflow.workItem.id), {
        command, check, purpose: 'local', workId: workflow.workItem.id, phaseId: phase.id,
        generation: nextPhaseGeneration(phase), localRunId, uncommittedChanges
      });
      attempts.push({ command, check, ...recorded });
    }
  } finally {
    // A local run is never accepted evidence: every report path returns to its earlier bytes.
    for (const check of checks) await kernel.restoreTransientQualityResult(check);
  }
  return { phase, commands, attempts };
}

/** The test commands a Story step's local run runs: exactly those its publish preflight would. */
export async function resolveStoryLocalTestCommands(root, config, workflow, { phaseId = null } = {}) {
  const phase = workflow.phases?.[phaseId ?? workflow.currentPhase] ?? null;
  if (!phase) {
    throw new SingularityFlowError(`Story ${workflow.workItem.id} has no step '${phaseId}'.`, {
      code: 'TESTS_PHASE_UNKNOWN', details: { workId: workflow.workItem.id, phase: phaseId, available: Object.keys(workflow.phases ?? {}) } });
  }
  if (!phaseRequiresCodeDelivery(phase)) {
    throw new SingularityFlowError(`Step '${phase.id}' of ${workflow.workItem.id} is not a code step; it runs no tests. Name the code step with --phase.`, {
      code: 'TESTS_PHASE_NOT_CODE', details: { workId: workflow.workItem.id, phase: phase.id } });
  }
  const deliveryEvidence = await evaluateCodeDeliveryPreflight(root, config, workflow, phase)
    .catch(() => phase.deliveryEvidence ?? null);
  const resolved = (await resolveDeliveryQualityCommands(root, { ...phase, deliveryEvidence: deliveryEvidence ?? undefined },
    { executionMode: workflow.resolution?.testExecutionMode }))
    .filter((command) => command && typeof command === 'object' && !Array.isArray(command) && command.kind === 'test')
    .map((command, index) => ({
      ...normalizeRequiredTestCommand(command, index),
      provenance: testCommandProvenance(phase, command)
    }))
    .map((command) => ({
      ...command,
      result: {
        ...command.result,
        minimumDiscovered: Math.max(command.result.minimumDiscovered, workflow.resolution?.codeDelivery?.tests?.minimumDiscovered ?? 1),
        minimumPassed: Math.max(command.result.minimumPassed, workflow.resolution?.codeDelivery?.tests?.minimumPassed ?? 1)
      }
    }));
  return { phase, commands: resolved };
}
