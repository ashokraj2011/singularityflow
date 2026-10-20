/**
 * `singularity-flow tests plan|run|summary` [RUN M2]: see which tests would run, run a capability's
 * tests or a Story step's the way the code step runs them, and read one summary of every test case.
 *
 * Capability scope saves a `local-preview` run privately (never evidence). Story scope stages one
 * attempt per command for the step, as publish preflight does, with purpose `local`; the step's
 * next publication or submission admits it with the others, and its gates still run their own.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['plan', 'run', 'summary']);
const OPTIONS = Object.freeze({
  plan: ['capability', 'work-id', 'phase', 'command', 'json'],
  run: ['capability', 'work-id', 'phase', 'command', 'environment', 'expect-command', 'json'],
  summary: ['capability', 'work-id', 'phase', 'run', 'json']
});
// Runs a gate made itself (evidence class `governed`), in words.
const GATE_LABELS = Object.freeze({
  preflight: 'Run by publication', submission: 'Run by submission', epoch: 'Run by a runner amendment'
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
  const { gitCommitIdentity } = await import('../git.mjs');
  const identity = (() => { try { return gitCommitIdentity(root); } catch { return null; } })();
  return identity?.email ?? identity?.name ?? null;
}

/** Whether tracked or untracked (not ignored) files differ from HEAD, read through the Git query layer. */
async function worktreeChanged(root) {
  const { executeGitQuery } = await import('../git-query.mjs');
  return executeGitQuery(root, 'repository.status').length > 0;
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

function environmentPlan(command, { application, declaration }) {
  const listed = application?.tests?.find((entry) => entry.use === command.id)?.environments ?? [];
  const linked = declaration?.checks?.[command.id]?.environment ?? command.environment ?? null;
  return { listed: [...listed], linked, allowed: listed.length ? [...listed] : linked ? [linked] : [] };
}

/** One command as `tests plan` shows it: what runs, where, in which environments, and its identity. */
async function plannedCommand(root, command, plan, declaration) {
  const [{ resolveEnvironmentBinding }, { testCommandSha256 }] = await Promise.all([
    import('../environment-bindings.mjs'), import('../run-environment.mjs')]);
  const environments = [];
  for (const [index, name] of plan.allowed.entries()) {
    const status = Object.hasOwn(declaration?.environments ?? {}, name)
      ? (await resolveEnvironmentBinding(root, name).catch(() => ({ status: 'unavailable' }))).status : 'undeclared';
    environments.push({ name, status, default: index === 0 });
  }
  return {
    id: command.id, kind: command.kind ?? null, argv: command.argv ? [...command.argv] : null,
    workingDirectory: command.workingDirectory ?? '.', adapter: command.result?.adapter ?? null,
    environments, ...(plan.linked ? { linkedEnvironment: plan.linked } : {}),
    commandSha256: testCommandSha256(command, plan.allowed)
  };
}

/**
 * --expect-command: every command a run is about to run must carry an identity the person
 * confirmed, and every confirmed identity must still be one of them; otherwise nothing runs.
 */
async function assertExpectedCommands(options, entries) {
  const expected = optionStrings(options, 'expect-command');
  if (!expected.length) return;
  const { testCommandSha256 } = await import('../run-environment.mjs');
  const planned = entries.map(({ command, allowed }) => ({ id: command.id, commandSha256: testCommandSha256(command, allowed) }));
  const changed = planned.filter((entry) => !expected.includes(entry.commandSha256));
  const stale = expected.filter((value) => !planned.some((entry) => entry.commandSha256 === value));
  if (changed.length || stale.length) {
    fail(`The test commands changed since they were confirmed${changed.length ? `: ${changed.map((entry) => entry.id).join(', ')}` : ''}. Nothing ran; read singularity-flow tests plan --json and confirm again.`,
      'TESTS_COMMAND_CHANGED', { changed, stale });
  }
}

/** The raw report bytes an attempt retained, each checked against its digest, or null. */
async function rawReportContents(root, receipt, workId) {
  if (!receipt.rawReports?.length) return null;
  const { gitDir } = await import('../git.mjs');
  const contents = [];
  for (const report of receipt.rawReports) {
    let bytes = null;
    for (const candidate of [path.join(root, report.path), path.join(gitDir(root), 'singularity-flow', 'test-attempts', workId, 'raw', report.sha256)]) {
      try { bytes = await readFile(candidate); break; } catch { /* try the next place it may be kept */ }
    }
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== report.sha256) return null;
    contents.push(bytes);
  }
  return contents;
}

async function rawReportLocations(receipt, contents) {
  if (receipt.adapter !== 'junit-xml' || !contents) return null;
  const { junitCaseLocations } = await import('../code-delivery-tests.mjs');
  try { return junitCaseLocations(contents); } catch { return null; }
}

/**
 * Each occurrence's failure message, redacted. A run given an environment's values is redacted with
 * them: `materialized` when the caller holds the binding, else the binding as it is now, and only
 * when it is still the one the run used (same fingerprint). Otherwise no message is shown at all.
 */
async function caseMessages(root, receipt, contents, { materialized = null } = {}) {
  if (!contents || !receipt.occurrences?.length) return null;
  const { testCaseMessages } = await import('../test-case-messages.mjs');
  const messages = testCaseMessages(receipt.adapter, contents, receipt.occurrences.length);
  if (!messages) return null;
  let redactor = materialized;
  const bound = receipt.boundEnvironment;
  if (!redactor && bound?.name) {
    const { materializeEnvironmentBinding } = await import('../environment-bindings.mjs');
    const current = await materializeEnvironmentBinding(root, bound.name).catch(() => null);
    if (current?.status !== 'bound' || !bound.fingerprintSha256 || current.environment?.fingerprintSha256 !== bound.fingerprintSha256) return null;
    redactor = current;
  }
  return redactor?.redactsAnything ? messages.map((message) => (message == null ? null : redactor.redact(message))) : messages;
}

/**
 * Every environment file the runs need, proven before any command runs [ENVF]: a missing one refuses
 * the whole run with ENV_FILE_MISSING naming both fixes. Nothing more loads without one.
 */
async function assertEnvironmentFilesReady(root, declaration, runs) {
  if (!runs.length) return;
  const { environmentFilesInPlay } = await import('../environment-bindings.mjs');
  if (!environmentFilesInPlay(root, declaration)) return;
  const { placeEnvironmentFilesForRun } = await import('../environment-files.mjs');
  for (const run of runs) await placeEnvironmentFilesForRun(root, run.environment, { declaration, ...run, check: true });
}

// ---------------------------------------------------------------------------------------------
// Capability scope: a local preview, never evidence.

/** The commands a capability-scope plan or run selects, each with its environments. */
async function capabilitySelection(root, options) {
  const [{ resolveCapabilityApplication }, { loadDefinition }, { loadEnvironmentDeclaration }, { normalizeRequiredTestCommand }] = await Promise.all([
    import('../capability-application-context.mjs'), import('../config.mjs'), import('../environment-declaration.mjs'), import('../code-delivery-tests.mjs')]);
  const application = await resolveCapabilityApplication(root, { capabilityId: optionString(options, 'capability', null) });
  const config = await loadDefinition(root);
  const declaration = await loadEnvironmentDeclaration(root, { optional: true });
  const subject = `Capability '${application.capabilityId}'`;
  const selected = selectCommands(await codeStepCommands(root, config), {
    commandIds: optionStrings(options, 'command'), application: application.application, subject
  });
  const plans = selected.map((command, index) => {
    let normalized = command;
    let invalid = null;
    try { if (command.kind === 'test') normalized = normalizeRequiredTestCommand(command, index); }
    catch (error) { invalid = error.message; }
    return { command: normalized, invalid, ...environmentPlan(command, { application: application.application, declaration }) };
  });
  return { application, config, declaration, subject, plans };
}

async function planCapability(root, options) {
  const { application, declaration, plans } = await capabilitySelection(root, options);
  const commands = [];
  for (const plan of plans) commands.push(await plannedCommand(root, plan.command, plan, declaration));
  return {
    resultType: 'sflow-test-plan',
    scope: { kind: 'capability', capability: application.capabilityId, workId: null, phase: null },
    localIntegrationEvidence: application.policy?.localIntegrationEvidence ?? 'off',
    commands
  };
}

async function runCapability(root, options) {
  const [state, store, summary, { buildTestExecutionReceipt, junitCaseLocations }, { newAttemptIdentity }, adapters, runEnvironment, git] = await Promise.all([
    import('../local-test-runs.mjs'), import('../test-runs.mjs'), import('../test-summary.mjs'), import('../code-delivery-tests.mjs'),
    import('../verification/attempts.mjs'), import('../verification/adapters.mjs'), import('../run-environment.mjs'), import('../git.mjs')]);
  const { application, config, declaration, subject, plans } = await capabilitySelection(root, options);
  if (!plans.length) {
    fail(`${subject} has no test command to run: the code step runs none and the capability names none. Run singularity-flow capability test-setup --json.`,
      'TESTS_NONE_RESOLVED');
  }
  await assertExpectedCommands(options, plans);
  const requested = optionString(options, 'environment', null);
  if (requested && !plans.some((plan) => plan.listed.includes(requested) || plan.linked === requested)) {
    fail(`No selected command may run in '${requested}'. ${plans.filter((plan) => plan.listed.length || plan.linked)
      .map((plan) => `${plan.command.id}: ${(plan.listed.length ? plan.listed : [plan.linked]).join(', ')}`).join('; ') || 'None declares an environment.'}`,
    'RUN_ENVIRONMENT_NOT_ALLOWED', { requested });
  }
  const allowed = application.policy?.localIntegrationEvidence === 'allowed';
  const environmentFor = (plan) => ((plan.listed.length || plan.linked) ? runEnvironment.selectRunEnvironment({
    listed: plan.listed, linked: plan.linked, declaration, subject: `Test command '${plan.command.id}'`,
    requested: requested && (plan.listed.includes(requested) || plan.linked === requested) ? requested : null
  }) : null);
  const sourceRoots = application.capability?.sourceRoots ?? [];
  await assertEnvironmentFilesReady(root, declaration, allowed ? plans.filter((plan) => !plan.invalid && environmentFor(plan))
    .map((plan) => ({ environment: environmentFor(plan), sourceRoots, workingDirectory: plan.command.workingDirectory ?? '.' })) : []);
  const ranBy = await localActorKey(root);
  const runId = store.newTestRunId();
  const startedAt = new Date().toISOString();
  const commit = git.head(root);
  const uncommittedChanges = await worktreeChanged(root);
  const entries = [];
  for (const [index, plan] of plans.entries()) {
    const environment = environmentFor(plan);
    const command = plan.command;
    let materialized = null;
    let note = plan.invalid;
    let check = null;
    if (note) { /* the command cannot run as declared */ } else if (environment && application.policy?.localIntegrationEvidence !== 'allowed') {
      note = runEnvironment.localIntegrationPolicyRefusal({ capabilityId: application.capabilityId, environment, subject: `Test command '${command.id}'` }).message;
    } else if (environment) {
      const { materializeEnvironmentBinding } = await import('../environment-bindings.mjs');
      materialized = await materializeEnvironmentBinding(root, environment, { commandId: plan.linked === environment ? command.id : null,
        files: { sourceRoots, workingDirectory: command.workingDirectory ?? '.' } }).catch((error) => {
        if (!String(error?.code ?? '').startsWith('ENV_FILE_')) throw error;
        note = error.message;
        return null;
      });
      if (note) materialized = null;
      else if (materialized.status !== 'bound') {
        note = runEnvironment.environmentBindingRefusal({ environment, status: materialized.status, missing: materialized.missing,
          subject: `Test command '${command.id}'` }).message;
        materialized = null;
      }
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
    // Kept with this private run record, redacted with the values the run was given.
    const messages = parsed?.rawReports?.length
      ? await caseMessages(root, receipt, parsed.rawReports.map((report) => report.contents), { materialized }) : null;
    entries.push({
      receipt, kind: command.kind ?? 'test', environment, countsForStep: false,
      ...(environment && materialized ? { boundEnvironment: materialized.environment } : {}),
      clauses: await summary.occurrenceClauses(root, { occurrences: receipt.occurrences, profile, locations: junitLocations }),
      ...(junitLocations ? { locations: junitLocations } : {}),
      ...(messages ? { messages } : {}),
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
    label: entry.label, totals: summary.historyTotals(entry.commands.map((command) => command.receipt))
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

/** One attempt's class, environment, whether it counts for the step, and its label. */
async function attemptMeaning(attempt, declaration) {
  const evidenceClass = attemptClass(attempt);
  const environment = attempt.boundEnvironment?.name ?? null;
  const linked = attempt.linkedEnvironment ?? declaration?.checks?.[attempt.commandId]?.environment ?? null;
  const countsForStep = evidenceClass === 'governed' ? true
    : evidenceClass === 'local-integration'
      ? attempt.countsForStep ?? (await import('../run-environment.mjs')).environmentCountsForStep({ environment, listed: attempt.allowedEnvironments ?? [], linked })
      : false;
  const label = evidenceClass === 'local-integration'
    ? (await import('../code-delivery-tests.mjs')).localIntegrationLabel({ ranBy: attempt.ranBy, environment, commit: attempt.candidate?.commit, countsForStep, linked })
    : evidenceClass === 'local-preview' ? 'Local run, not evidence: publication and submission run the tests again'
      : GATE_LABELS[attempt.purpose] ?? 'Run by a gate';
  return { evidenceClass, environment, countsForStep, label };
}

/** A run's label from its commands' labels: one when they agree, else each command's. */
function groupLabel(entries) {
  const labels = [...new Set(entries.map((entry) => entry.label))];
  return labels.length === 1 ? labels[0] : entries.map((entry) => `${entry.receipt.commandId}: ${entry.label}`).join(' · ');
}

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
  const [{ loadAcceptedStoryExecution }, { stepAttempts }, { workDirRelative }, summary, { loadEnvironmentDeclaration }] = await Promise.all([
    import('../accepted-story-execution.mjs'), import('../verification/attempts.mjs'), import('../story-paths.mjs'),
    import('../test-summary.mjs'), import('../environment-declaration.mjs')]);
  const { config, workflow } = await loadAcceptedStoryExecution(root, optionString(options, 'work-id'));
  const phaseId = optionString(options, 'phase', null) ?? workflow.currentPhase;
  if (!workflow.phases?.[phaseId]) {
    fail(`Story ${workflow.workItem.id} has no step '${phaseId}'.`, 'TESTS_PHASE_UNKNOWN', { available: Object.keys(workflow.phases ?? {}) });
  }
  const declaration = await loadEnvironmentDeclaration(root, { optional: true }).catch(() => null);
  const attempts = await stepAttempts(root, workDirRelative(config, workflow.workItem.id), workflow.workItem.id, phaseId);
  const groups = attemptGroups(attempts);
  const wanted = localRunId ?? (typeof options.run === 'string' ? options.run : null);
  const group = wanted
    ? groups.find((entry) => entry.id === wanted || entry.members.some((attempt) => attempt.attemptId === wanted))
    : groups[0] ?? null;
  if (wanted && !group) fail(`No run ${wanted} is recorded for ${workflow.workItem.id} step ${phaseId}.`, 'TESTS_RUN_NOT_FOUND');
  const scope = { kind: 'story', capability: workflow.resolution?.capability?.id ?? null, workId: workflow.workItem.id, phase: phaseId };
  const history = [];
  for (const entry of groups.slice(0, 20)) {
    const meanings = await Promise.all(entry.members.map(async (attempt) => ({ receipt: attempt, ...await attemptMeaning(attempt, declaration) })));
    const environments = [...new Set(meanings.map((meaning) => meaning.environment).filter(Boolean))];
    history.push({ runId: entry.id, at: entry.at, evidenceClass: [...new Set(meanings.map((meaning) => meaning.evidenceClass))].join('+'),
      environment: environments.length === 1 ? environments[0] : null, label: groupLabel(meanings), totals: summary.historyTotals(entry.members) });
  }
  if (!group) return summary.buildTestSummary({ scope, run: null, entries: [], history });
  const entries = [];
  for (const attempt of group.members) {
    const contents = await rawReportContents(root, attempt, workflow.workItem.id);
    const locations = await rawReportLocations(attempt, contents);
    const messages = await caseMessages(root, attempt, contents);
    entries.push({
      receipt: attempt, kind: 'test', locations, ...(messages ? { messages } : {}), ...await attemptMeaning(attempt, declaration),
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
      label: groupLabel(entries),
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

/** The Story, its pinned capability's application, and how a step's commands are selected. */
async function storyContext(root, options) {
  const [{ loadAcceptedStoryExecution }, { resolveCapabilityApplication }, { loadEnvironmentDeclaration }] = await Promise.all([
    import('../accepted-story-execution.mjs'), import('../capability-application-context.mjs'), import('../environment-declaration.mjs')]);
  const { config, workflow } = await loadAcceptedStoryExecution(root, optionString(options, 'work-id'));
  const application = await resolveCapabilityApplication(root, { capabilityId: workflow.resolution?.capability?.id ?? null })
    .then((value) => value.application).catch(() => null);
  const declaration = await loadEnvironmentDeclaration(root, { optional: true }).catch(() => null);
  const commandIds = optionStrings(options, 'command');
  const subject = `Story ${workflow.workItem.id}`;
  // The capability's test environments apply only when the Story's pinned policy allows them.
  const allowed = workflow.resolution?.capability?.policy?.localIntegrationEvidence === 'allowed';
  const environmentApplication = allowed ? application : null;
  const select = (commands) => selectCommands(commands, { commandIds, application: commandIds.length ? null : application, subject });
  const withEnvironments = (commands) => commands.map((command) => ({ command, ...environmentPlan(command, { application: environmentApplication, declaration }) }));
  return { config, workflow, declaration, allowed, select, withEnvironments };
}

async function planStory(root, options) {
  const state = await import('../local-test-runs.mjs');
  const context = await storyContext(root, options);
  const { phase, commands } = await state.resolveStoryLocalTestCommands(root, context.config, context.workflow, {
    phaseId: optionString(options, 'phase', null) });
  const planned = [];
  for (const entry of context.withEnvironments(context.select(commands))) {
    planned.push(await plannedCommand(root, entry.command, entry, context.declaration));
  }
  return {
    resultType: 'sflow-test-plan',
    scope: { kind: 'story', capability: context.workflow.resolution?.capability?.id ?? null, workId: context.workflow.workItem.id, phase: phase.id },
    localIntegrationEvidence: context.allowed ? 'allowed' : 'off',
    commands: planned
  };
}

async function runStory(root, options) {
  const [state, store] = await Promise.all([import('../local-test-runs.mjs'), import('../test-runs.mjs')]);
  const context = await storyContext(root, options);
  const localRunId = store.newTestRunId();
  await state.stageStoryLocalTests(root, context.config, context.workflow, {
    phaseId: optionString(options, 'phase', null),
    localRunId,
    uncommittedChanges: await worktreeChanged(root),
    ranBy: await localActorKey(root),
    requestedEnvironment: optionString(options, 'environment', null),
    select: async (commands) => {
      const selected = context.select(commands);
      await assertExpectedCommands(options, context.withEnvironments(selected));
      // The environment each command's run uses, as the gate chooses it: the requested one when it may, else the linked or first listed.
      const requested = optionString(options, 'environment', null);
      const sourceRoots = context.workflow.resolution?.capability?.sourceScope?.sourceRoots ?? [];
      await assertEnvironmentFilesReady(root, context.declaration, context.allowed ? context.withEnvironments(selected).filter((plan) => plan.allowed.length)
        .map((plan) => ({ environment: requested && plan.listed.includes(requested) ? requested : plan.linked ?? plan.allowed[0],
          sourceRoots, workingDirectory: plan.command.workingDirectory ?? '.' })) : []);
      return selected;
    }
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
  // `run` is a boolean flag of precheck and story test commands, so `--run RUN-ID` arrives as the
  // flag and a separate word, and `--run=RUN-ID` as text. Both are taken here, before validation.
  if (subcommand === 'summary' && options.run !== undefined) {
    const value = options.run === true ? positionals[2] : options.run;
    if (typeof value !== 'string' || !value || (options.run === true ? positionals.length !== 3 : positionals.length > 2)) {
      fail('tests summary --run needs one run ID: a RUN- local run or a TA- attempt.');
    }
    options = { ...options, run: value };
    positionals = positionals.slice(0, 2);
  }
  if (positionals.length > 2) fail(`tests ${subcommand} takes no positional arguments; name the scope with --capability or --work-id.`);
  rejectOptions(subcommand, options);
  const json = optionBoolean(options, 'json');
  const { repoRoot } = await import('../git.mjs');
  const root = repoRoot(process.cwd());
  const story = Boolean(optionString(options, 'work-id', null));
  if (subcommand === 'plan') {
    const result = story ? await planStory(root, options) : await planCapability(root, options);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      const scope = result.scope.kind === 'story' ? `${result.scope.workId} step ${result.scope.phase}` : `capability ${result.scope.capability}`;
      console.log(`Tests of ${scope} (local integration evidence ${result.localIntegrationEvidence}):`);
      for (const command of result.commands) {
        const environments = command.environments.map((entry) => `${entry.name}${entry.default ? ' (default)' : ''}: ${entry.status}`).join(', ');
        console.log(`  ${command.id}: ${(command.argv ?? []).join(' ')} · in ${command.workingDirectory}${environments ? ` · ${environments}` : ''}`);
      }
      console.log(`Run: singularity-flow tests run${result.scope.kind === 'story' ? ` --work-id ${result.scope.workId} --phase ${result.scope.phase}` : ` --capability ${result.scope.capability}`}`);
    }
    return result;
  }
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
    const { resolveCapabilityApplication } = await import('../capability-application-context.mjs');
    const application = await resolveCapabilityApplication(root, { capabilityId: optionString(options, 'capability', null) });
    result = await capabilitySummary(root, application.capabilityId, null, { runId: typeof options.run === 'string' ? options.run : null });
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
