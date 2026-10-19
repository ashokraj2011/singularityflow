/**
 * `singularity-flow tests run|summary` [RUN M2]: run a capability's tests, or a Story step's, the
 * way the code step runs them, and read one summary of every test case.
 *
 * Capability scope saves a `local-preview` run privately (never evidence). Story scope stages one
 * attempt per command for the step, as publish preflight does, with purpose `local`; the step's
 * next publication or submission admits it with the others, and its gates still run their own.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['run', 'summary']);
const OPTIONS = Object.freeze({
  run: ['capability', 'work-id', 'phase', 'command', 'environment', 'json'],
  summary: ['capability', 'work-id', 'phase', 'run', 'json']
});
const GATE_LABELS = Object.freeze({
  preflight: 'Governed run at publication', submission: 'Governed run at submission', epoch: 'Governed run for a runner amendment'
});

function fail(message, code = 'TESTS_COMMAND_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function rejectOptions(subcommand, options) {
  const allowed = new Set([...OPTIONS[subcommand], 'timings']);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) {
    fail(`tests ${subcommand} does not accept ${unknown.map((key) => `--${key}`).join(', ')}. Use: ${OPTIONS[subcommand].map((key) => `--${key}`).join(', ')}.`);
  }
  if (optionString(options, 'capability', null) && optionString(options, 'work-id', null)) {
    fail('Name either --capability (a local preview) or --work-id (a Story step), not both.');
  }
  if (optionString(options, 'phase', null) && !optionString(options, 'work-id', null)) {
    fail('--phase names a step of a Story; add --work-id.');
  }
}

function summaryCommand(scope) {
  return scope.kind === 'story'
    ? `singularity-flow tests summary --work-id ${scope.workId} --phase ${scope.phase}`
    : `singularity-flow tests summary --capability ${scope.capability}`;
}

/** The identity a run is recorded as having been run by: the session actor, else Git's identity. */
async function localActorKey(root) {
  const { loadSession } = await import('../session.mjs');
  const session = await loadSession(root, { required: false }).catch(() => null);
  const actor = session?.actor;
  if (actor) return actor.login ?? actor.email ?? actor.name ?? null;
  const { run } = await import('../util.mjs');
  for (const key of ['user.email', 'user.name']) {
    const value = run('git', ['config', '--get', key], { cwd: root, allowFailure: true }).stdout.trim();
    if (value) return value;
  }
  return null;
}

function worktreeChanged(root, run) {
  return run('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, allowFailure: true }).stdout.trim() !== '';
}

/** Every quality command the code steps of this workflow resolve, first definition of an ID first. */
async function codeStepCommands(root, config) {
  const [{ resolveWorkType }, { phaseRequiresCodeDelivery }, { resolveDeliveryQualityCommands }] = await Promise.all([
    import('../config.mjs'), import('../code-delivery-policy.mjs'), import('../delivery-evidence.mjs')]);
  const byId = new Map();
  for (const workTypeId of Object.keys(config.workTypes ?? {})) {
    let phases = [];
    try { phases = resolveWorkType(config, workTypeId).phases; } catch { continue; }
    for (const phase of phases.filter(phaseRequiresCodeDelivery)) {
      for (const command of await resolveDeliveryQualityCommands(root, phase)) {
        if (!command || typeof command !== 'object' || Array.isArray(command) || !command.id) continue;
        if (!byId.has(command.id)) byId.set(command.id, command);
      }
    }
  }
  if (!byId.size) {
    const { inferRepositoryTestCommands } = await import('../delivery-evidence.mjs');
    for (const command of await inferRepositoryTestCommands(root).catch(() => [])) if (!byId.has(command.id)) byId.set(command.id, command);
  }
  return [...byId.values()];
}

/** The commands a run selects: --command IDs, else the capability's tests, else every test command. */
function selectCommands(available, { commandIds, application, subject }) {
  const tests = application?.tests ?? [];
  const wanted = commandIds.length ? commandIds : tests.map((entry) => entry.use);
  if (!wanted.length) return available.filter((command) => command.kind === 'test');
  const ids = available.map((command) => command.id);
  const unknown = wanted.filter((id) => !ids.includes(id));
  if (unknown.length) {
    fail(`${subject} resolves no quality command named ${unknown.map((id) => `'${id}'`).join(', ')}. Available: ${ids.join(', ') || 'none'}.`,
      'TESTS_COMMAND_UNKNOWN', { unknown, available: ids });
  }
  return wanted.map((id) => available.find((command) => command.id === id));
}

function environmentPlan(command, { application, declaration, requested }) {
  const listed = application?.tests?.find((entry) => entry.use === command.id)?.environments ?? [];
  const linked = declaration?.checks?.[command.id]?.environment ?? command.environment ?? null;
  return { listed: [...listed], linked };
}

async function rawReportLocations(root, receipt, workId) {
  if (receipt.adapter !== 'junit-xml' || !receipt.rawReports?.length) return null;
  const [{ gitDir }, { junitCaseLocations }] = await Promise.all([import('../git.mjs'), import('../code-delivery-tests.mjs')]);
  const contents = [];
  for (const report of receipt.rawReports) {
    let bytes = null;
    for (const candidate of [path.join(root, report.path), path.join(gitDir(root), 'singularity-flow', 'test-attempts', workId, 'raw', report.sha256)]) {
      try { bytes = await readFile(candidate); break; } catch { /* try the next place it may be kept */ }
    }
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== report.sha256) return null;
    contents.push(bytes);
  }
  try { return junitCaseLocations(contents); } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Capability scope: a local preview, never evidence.

async function runCapability(root, options) {
  const [{ resolveCapabilityApplication }, { loadDefinition }, { loadEnvironmentDeclaration }, state, store, summary,
    { buildTestExecutionReceipt, junitCaseLocations, normalizeRequiredTestCommand }, { newAttemptIdentity }, adapters, runEnvironment, util, git] = await Promise.all([
    import('../capability-context.mjs'), import('../config.mjs'), import('../environment-declaration.mjs'), import('../state.mjs'),
    import('../test-runs.mjs'), import('../test-summary.mjs'), import('../code-delivery-tests.mjs'), import('../verification/attempts.mjs'),
    import('../verification/adapters.mjs'), import('../run-environment.mjs'), import('../util.mjs'), import('../git.mjs')]);
  const application = await resolveCapabilityApplication(root, { capabilityId: optionString(options, 'capability', null) });
  const config = await loadDefinition(root);
  const declaration = await loadEnvironmentDeclaration(root, { optional: true });
  const subject = `Capability '${application.capabilityId}'`;
  const selected = selectCommands(await codeStepCommands(root, config), {
    commandIds: optionStrings(options, 'command'), application: application.application, subject
  });
  if (!selected.length) {
    fail(`${subject} has no test command to run: the code step runs none and the capability names none. Run singularity-flow capability test-setup --json.`,
      'TESTS_NONE_RESOLVED');
  }
  const requested = optionString(options, 'environment', null);
  const plans = selected.map((command) => ({ command, ...environmentPlan(command, { application: application.application, declaration }) }));
  if (requested && !plans.some((plan) => plan.listed.includes(requested) || plan.linked === requested)) {
    fail(`No selected command may run in '${requested}'. ${plans.filter((plan) => plan.listed.length || plan.linked)
      .map((plan) => `${plan.command.id}: ${(plan.listed.length ? plan.listed : [plan.linked]).join(', ')}`).join('; ') || 'None declares an environment.'}`,
    'RUN_ENVIRONMENT_NOT_ALLOWED', { requested });
  }
  const ranBy = await localActorKey(root);
  const runId = store.newTestRunId();
  const startedAt = new Date().toISOString();
  const commit = git.head(root);
  const uncommittedChanges = worktreeChanged(root, util.run);
  const entries = [];
  for (const [index, plan] of plans.entries()) {
    const usesEnvironment = plan.listed.length || plan.linked;
    const environment = usesEnvironment ? runEnvironment.selectRunEnvironment({
      listed: plan.listed, linked: plan.linked, declaration, subject: `Test command '${plan.command.id}'`,
      requested: requested && (plan.listed.includes(requested) || plan.linked === requested) ? requested : null
    }) : null;
    let command = plan.command;
    let materialized = null;
    let note = null;
    let check = null;
    if (environment && application.policy?.localIntegrationEvidence !== 'allowed') {
      note = runEnvironment.localIntegrationPolicyRefusal({ capabilityId: application.capabilityId, environment, subject: `Test command '${command.id}'` }).message;
    } else if (environment) {
      const { materializeEnvironmentBinding } = await import('../environment-bindings.mjs');
      materialized = await materializeEnvironmentBinding(root, environment, { commandId: plan.linked === environment ? command.id : null });
      if (materialized.status !== 'bound') {
        note = runEnvironment.environmentBindingRefusal({ environment, status: materialized.status, missing: materialized.missing,
          subject: `Test command '${command.id}'` }).message;
        materialized = null;
      }
    }
    try {
      if (command.kind === 'test') command = normalizeRequiredTestCommand(command, index);
    } catch (error) {
      note = error.message;
    }
    let parsed = null;
    let reportError = null;
    if (!note) ({ check, parsed, reportError } = await state.runLocalPreviewQualityCommand(root, config, command, { index, materialized }));
    else {
      const now = new Date().toISOString();
      check = { id: command.id, kind: command.kind, status: 'blocked', exitCode: null, sourceCommit: commit, startedAt: now, completedAt: now, stderr: note };
    }
    const profile = adapters.profileForCommand(command);
    const receipt = buildTestExecutionReceipt(command, check, parsed, {
      ...newAttemptIdentity(), purpose: 'local-preview', profile, reportError,
      selection: command.argv ? adapters.classifyTestCommand(profile, command) : null
    });
    if (command.kind !== 'test') receipt.status = check.status === 'passed' ? 'passed' : check.status;
    let junitLocations = null;
    if (parsed?.adapter === 'junit-xml') {
      try { junitLocations = junitCaseLocations(parsed.rawReports.map((report) => report.contents)); } catch { junitLocations = null; }
    }
    entries.push({
      receipt, kind: command.kind ?? 'test', environment, countsForStep: false,
      ...(environment && materialized ? { boundEnvironment: materialized.environment } : {}),
      clauses: await summary.occurrenceClauses(root, { occurrences: receipt.occurrences, profile, locations: junitLocations }),
      ...(junitLocations ? { locations: junitLocations } : {}),
      ...(note ? { note } : {}),
      ...(check.stderr && check.status !== 'passed' ? { diagnostic: String(check.stderr).slice(0, 2_000) } : {})
    });
  }
  const environments = [...new Set(entries.map((entry) => entry.environment).filter(Boolean))];
  const record = {
    format: store.TEST_RUN_FORMAT, runId, capability: application.capabilityId, scope: 'capability',
    evidenceClass: 'local-preview', label: store.LOCAL_PREVIEW_LABEL, environment: environments.length === 1 ? environments[0] : null,
    startedAt, completedAt: new Date().toISOString(), commit, uncommittedChanges, ranBy, commands: entries
  };
  await store.saveTestRun(root, record);
  return capabilitySummary(root, application.capabilityId, record);
}

async function capabilitySummary(root, capabilityId, record = null, { runId = null } = {}) {
  const [store, summary] = await Promise.all([import('../test-runs.mjs'), import('../test-summary.mjs')]);
  const runs = await store.listTestRuns(root, capabilityId);
  const chosen = record ?? (runId ? await store.readTestRun(root, capabilityId, runId) : runs[0] ?? null);
  const scope = { kind: 'capability', capability: capabilityId, workId: null, phase: null };
  const history = runs.map((entry) => ({
    runId: entry.runId, at: entry.startedAt, evidenceClass: entry.evidenceClass, environment: entry.environment ?? null,
    totals: summary.historyTotals(entry.commands.map((command) => command.receipt))
  }));
  if (!chosen) return summary.buildTestSummary({ scope, run: null, entries: [], history });
  return summary.buildTestSummary({
    scope,
    run: {
      id: chosen.runId, evidenceClass: chosen.evidenceClass, label: chosen.label, environment: chosen.environment ?? null,
      countsForStep: false, startedAt: chosen.startedAt, commit: chosen.commit, uncommittedChanges: chosen.uncommittedChanges, ranBy: chosen.ranBy
    },
    entries: chosen.commands,
    history
  });
}

// ---------------------------------------------------------------------------------------------
// Story scope: attempts staged for the step, read back with every earlier attempt of it.

function attemptClass(attempt) {
  if (attempt.evidenceClass) return attempt.evidenceClass;
  return attempt.purpose === 'local' ? 'local-preview' : 'governed';
}

function attemptGroups(attempts) {
  const groups = new Map();
  for (const attempt of attempts) {
    const key = attempt.localRunId ?? `${attempt.purpose}:${attempt.generation ?? ''}:${attempt.epoch ?? ''}`;
    if (!groups.has(key)) groups.set(key, { key, attempts: [] });
    groups.get(key).attempts.push(attempt);
  }
  return [...groups.values()].map((group) => {
    const latest = new Map();
    for (const attempt of group.attempts) latest.set(attempt.commandId, attempt);
    const members = [...latest.values()];
    const last = members.reduce((newest, attempt) => (String(attempt.process?.completedAt ?? '') > String(newest.process?.completedAt ?? '') ? attempt : newest), members[0]);
    return { ...group, members, id: group.attempts[0].localRunId ?? last.attemptId, at: last.process?.completedAt ?? last.process?.startedAt ?? '' };
  }).sort((left, right) => String(right.at).localeCompare(String(left.at)));
}

async function storySummary(root, options, { localRunId = null } = {}) {
  const [{ loadAcceptedStoryExecution }, { stepAttempts }, { workDirRelative }, summary, runEnvironment, { loadEnvironmentDeclaration }] = await Promise.all([
    import('../accepted-story-execution.mjs'), import('../verification/attempts.mjs'), import('../story-paths.mjs'),
    import('../test-summary.mjs'), import('../run-environment.mjs'), import('../environment-declaration.mjs')]);
  const { config, workflow } = await loadAcceptedStoryExecution(root, optionString(options, 'work-id'));
  const phaseId = optionString(options, 'phase', null) ?? workflow.currentPhase;
  if (!workflow.phases?.[phaseId]) {
    fail(`Story ${workflow.workItem.id} has no step '${phaseId}'.`, 'TESTS_PHASE_UNKNOWN', { available: Object.keys(workflow.phases ?? {}) });
  }
  const declaration = await loadEnvironmentDeclaration(root, { optional: true }).catch(() => null);
  const attempts = await stepAttempts(root, workDirRelative(config, workflow.workItem.id), workflow.workItem.id, phaseId);
  const groups = attemptGroups(attempts);
  const wanted = localRunId ?? optionString(options, 'run', null);
  const group = wanted
    ? groups.find((entry) => entry.id === wanted || entry.members.some((attempt) => attempt.attemptId === wanted))
    : groups[0] ?? null;
  if (wanted && !group) fail(`No run ${wanted} is recorded for ${workflow.workItem.id} step ${phaseId}.`, 'TESTS_RUN_UNKNOWN');
  const scope = { kind: 'story', capability: workflow.resolution?.capability?.id ?? null, workId: workflow.workItem.id, phase: phaseId };
  const history = groups.slice(0, 20).map((entry) => ({
    runId: entry.id, at: entry.at, evidenceClass: [...new Set(entry.members.map(attemptClass))].join('+'),
    totals: summary.historyTotals(entry.members)
  }));
  if (!group) return summary.buildTestSummary({ scope, run: null, entries: [], history });
  const entries = [];
  for (const attempt of group.members) {
    const evidenceClass = attemptClass(attempt);
    const environment = attempt.boundEnvironment?.name ?? null;
    const linked = attempt.linkedEnvironment ?? declaration?.checks?.[attempt.commandId]?.environment ?? null;
    const countsForStep = evidenceClass === 'governed' ? true
      : evidenceClass === 'local-integration'
        ? attempt.countsForStep ?? runEnvironment.environmentCountsForStep({ environment, listed: attempt.allowedEnvironments ?? [], linked })
        : false;
    const locations = await rawReportLocations(root, attempt, workflow.workItem.id);
    entries.push({
      receipt: attempt, kind: 'test', evidenceClass, environment, countsForStep, locations,
      label: evidenceClass === 'local-integration'
        ? (await import('../code-delivery-tests.mjs')).localIntegrationLabel({ ranBy: attempt.ranBy, environment, commit: attempt.candidate?.commit, countsForStep, linked })
        : evidenceClass === 'local-preview' ? 'Local run, not evidence: publication and submission run the tests again'
          : GATE_LABELS[attempt.purpose] ?? 'Governed run',
      clauses: await summary.occurrenceClauses(root, { occurrences: attempt.occurrences ?? [], profile: attempt.profile, locations })
    });
  }
  const classes = [...new Set(entries.map((entry) => entry.evidenceClass))];
  const environments = [...new Set(entries.map((entry) => entry.environment).filter(Boolean))];
  const first = group.members[0];
  const runClass = classes.length === 1 ? classes[0] : classes.includes('local-integration') ? 'local-integration' : classes[0];
  return summary.buildTestSummary({
    scope,
    run: {
      id: group.id, evidenceClass: runClass,
      label: classes.length === 1 ? entries[0].label : entries.map((entry) => `${entry.receipt.commandId}: ${entry.label}`).join(' · '),
      environment: environments.length === 1 ? environments[0] : null,
      countsForStep: entries.every((entry) => entry.countsForStep),
      startedAt: group.members.map((attempt) => attempt.process?.startedAt).filter(Boolean).sort()[0] ?? null,
      commit: first.candidate?.commit ?? null,
      uncommittedChanges: first.uncommittedChanges ?? first.purpose === 'preflight',
      ranBy: first.ranBy ?? null
    },
    entries,
    history
  });
}

async function runStory(root, options) {
  const [{ loadAcceptedStoryExecution }, state, store, { resolveCapabilityApplication }, util] = await Promise.all([
    import('../accepted-story-execution.mjs'), import('../state.mjs'), import('../test-runs.mjs'), import('../capability-context.mjs'),
    import('../util.mjs')]);
  const { config, workflow } = await loadAcceptedStoryExecution(root, optionString(options, 'work-id'));
  const application = await resolveCapabilityApplication(root, { capabilityId: workflow.resolution?.capability?.id ?? null })
    .then((value) => value.application).catch(() => null);
  const commandIds = optionStrings(options, 'command');
  const localRunId = store.newTestRunId();
  const subject = `Story ${workflow.workItem.id}`;
  await state.stageStoryLocalTests(root, config, workflow, {
    phaseId: optionString(options, 'phase', null),
    localRunId,
    uncommittedChanges: worktreeChanged(root, util.run),
    ranBy: await localActorKey(root),
    requestedEnvironment: optionString(options, 'environment', null),
    select: (commands) => selectCommands(commands, { commandIds, application: commandIds.length ? null : application, subject })
  });
  return storySummary(root, options, { localRunId });
}

// ---------------------------------------------------------------------------------------------

function runResult(summary) {
  const { cases: _cases, truncated: _truncated, untagged: _untagged, history: _history, resultType: _type, schemaVersion: _version, ...rest } = summary;
  return { resultType: 'sflow-test-run', ...rest, next: summaryCommand(summary.scope) };
}

function runText(result) {
  const lines = [`${result.scope.kind === 'story' ? `${result.scope.workId} step ${result.scope.phase}` : `Capability ${result.scope.capability}`}: ${result.run.label} (${result.run.id})`];
  for (const command of result.commands) {
    const counts = command.tests?.discovered != null ? `${command.tests.discovered} tests, ${command.tests.passed} passed, ${command.tests.failed} failed, ${command.tests.skipped} skipped` : 'no test counts';
    lines.push(`  ${command.id}: ${command.status}${command.exitCode != null ? ` (exit ${command.exitCode})` : ''} · ${counts}${command.environment ? ` · environment ${command.environment}` : ''}`);
    if (command.note) lines.push(`    ${command.note}`);
  }
  const t = result.totals;
  lines.push(`Totals: ${t.discovered} discovered · ${t.passed} passed · ${t.failed} failed · ${t.skipped} skipped`);
  lines.push(`Read every test case: ${result.next}`);
  return lines.join('\n');
}

export async function run(_argv, { positionals, options = {} }) {
  const subcommand = positionals[1] ?? 'summary';
  if (!SUBCOMMANDS.includes(subcommand)) {
    fail(`Unknown tests subcommand '${subcommand}'. Supported: ${SUBCOMMANDS.join(', ')}.`, 'UNKNOWN_SUBCOMMAND',
      { command: 'tests', subcommand, available: [...SUBCOMMANDS] });
  }
  // `run` is a registered boolean flag elsewhere, so `--run RUN-ID` arrives as a flag and a word.
  if (subcommand === 'summary' && options.run === true) {
    if (positionals.length !== 3) fail('tests summary --run needs a run ID: a RUN- local run or a TA- attempt.');
    options = { ...options, run: positionals[2] };
    positionals = positionals.slice(0, 2);
  }
  if (positionals.length > 2) fail(`tests ${subcommand} takes no positional arguments; name the scope with --capability or --work-id.`);
  rejectOptions(subcommand, options);
  const json = optionBoolean(options, 'json');
  const { repoRoot } = await import('../git.mjs');
  const root = repoRoot(process.cwd());
  const story = Boolean(optionString(options, 'work-id', null));
  if (subcommand === 'run') {
    const result = runResult(story ? await runStory(root, options) : await runCapability(root, options));
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(runText(result));
    if (result.commands.some((command) => command.status !== 'passed')) process.exitCode = 1;
    return result;
  }
  let result;
  if (story) result = await storySummary(root, options);
  else {
    const { resolveCapabilityApplication } = await import('../capability-context.mjs');
    const application = await resolveCapabilityApplication(root, { capabilityId: optionString(options, 'capability', null) });
    result = await capabilitySummary(root, application.capabilityId, null, { runId: optionString(options, 'run', null) });
  }
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    const { testSummaryText } = await import('../test-summary.mjs');
    const scope = result.scope;
    console.log(testSummaryText(result, {
      next: result.run ? null : scope.kind === 'story'
        ? `singularity-flow tests run --work-id ${scope.workId} --phase ${scope.phase}`
        : `singularity-flow tests run --capability ${scope.capability}`
    }));
  }
  return result;
}
