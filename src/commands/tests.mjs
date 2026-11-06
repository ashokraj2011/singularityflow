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

const SUBCOMMANDS = Object.freeze(['plan', 'run', 'summary', 'base']);
const OPTIONS = Object.freeze({
  plan: ['capability', 'work-id', 'phase', 'command', 'json'],
  base: ['work-id', 'phase', 'command', 'json'],
  run: ['capability', 'work-id', 'phase', 'command', 'environment', 'expect-command', 'json'],
  summary: ['capability', 'work-id', 'phase', 'run', 'json']
});
// Runs a gate made itself (evidence class `governed`), in words.
const GATE_LABELS = Object.freeze({
  preflight: 'Run by publication', submission: 'Run by submission', epoch: 'Run by a runner amendment',
  candidate: 'Run on the Auto Candidate before publication'
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

/** Every quality command the code steps of this workflow resolve, first definition of an ID first, each saying how the gate holds it. */
async function codeStepCommands(root, config) {
  const [{ resolveWorkType }, { phaseRequiresCodeDelivery }, { resolveDeliveryQualityCommands, testCommandProvenance }] = await Promise.all([
    import('../config.mjs'), import('../code-delivery-policy.mjs'), import('../delivery-evidence.mjs')]);
  const byId = new Map();
  for (const workTypeId of Object.keys(config.workTypes ?? {})) {
    let phases = [];
    try { phases = resolveWorkType(config, workTypeId).phases; } catch { continue; }
    for (const phase of phases.filter(phaseRequiresCodeDelivery)) {
      for (const command of await resolveDeliveryQualityCommands(root, phase)) {
        if (!command || typeof command !== 'object' || Array.isArray(command) || !command.id) continue;
        if (!byId.has(command.id)) byId.set(command.id, { ...command, provenance: testCommandProvenance(phase, command) });
      }
    }
  }
  if (!byId.size) {
    const { inferRepositoryTestCommands } = await import('../delivery-evidence.mjs');
    for (const command of await inferRepositoryTestCommands(root).catch(() => [])) if (!byId.has(command.id)) byId.set(command.id, { ...command, provenance: 'inferred' });
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

/** One command as `tests plan` shows it: what runs, where, in which environments, its identity, and all of that in words. */
async function plannedCommand(root, command, plan, declaration) {
  const [{ resolveEnvironmentBinding }, { testCommandSha256 }, { describeTestCommand }] = await Promise.all([
    import('../environment-bindings.mjs'), import('../run-environment.mjs'), import('../test-plan.mjs')]);
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
    commandSha256: testCommandSha256(command, plan.allowed),
    ...await describeTestCommand(root, command, { provenance: plan.provenance ?? command.provenance ?? null })
  };
}

/** What a plan adds to its commands: what covers each path, what was seen and not used, and what would surprise someone later. */
async function planDetails(root, commands, { changed = [], planned = [], plannedTests = [] } = {}) {
  const { earlyTestChecks, pathCoverage, suitesNotUsed } = await import('../test-plan.mjs');
  const quiet = async (read, fallback) => { try { return await read(); } catch { return fallback; } };
  return {
    paths: await quiet(() => pathCoverage(root, commands, { changed, planned }), null),
    notUsed: await quiet(() => suitesNotUsed(root, commands), []),
    earlyChecks: await earlyTestChecks(root, commands, { planned: plannedTests })
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
    return { command: normalized, invalid, provenance: command.provenance ?? null, ...environmentPlan(command, { application: application.application, declaration }) };
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
    commands,
    ...await planDetails(root, plans.map((plan) => ({ ...plan.command, provenance: plan.provenance })))
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
    : evidenceClass === 'local-preview' ? 'Local run, not evidence itself: a passing one stands for the next publication while nothing it ran on changes'
      : attempt.reusedFrom ? `Reused from ${attempt.reusedFrom.attemptId}, on the same code`
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

// A reused run keeps the times of the run it reuses; its place in the history is when a gate reused it.
const attemptRecordedAt = (attempt) => String(attempt.reusedFrom?.at ?? attempt.process?.completedAt ?? '');
const newestAttempt = (attempts) => attempts.reduce((newest, attempt) => (attemptRecordedAt(attempt) > attemptRecordedAt(newest) ? attempt : newest), attempts[0]);
const attemptGroupKey = (attempt) => attempt.localRunId ?? `${attempt.purpose}:${attempt.generation ?? ''}:${attempt.epoch ?? ''}`;

/**
 * The gate's run as it bound it. On code that already passed a gate binds a run it did not just make,
 * so its own group's newest attempt (on other code) or a reused run in another group would misstate it.
 * A newer gate run the step did not bind, such as a failed submission, stays what is shown.
 */
function boundRun(group, attempts, delivery) {
  const executions = delivery?.testExecutions?.length ? delivery.testExecutions : delivery?.preflightAttempts ?? [];
  const bound = attempts.filter((attempt) => executions.some((entry) => entry.attemptId === attempt.attemptId));
  const ownGroup = (attempt) => attemptGroupKey(attempt) === group.key;
  if (group.attempts[0].localRunId || !bound.some((attempt) => ownGroup(attempt) || group.members.includes(attempt))) return group;
  const members = new Map(group.members.map((attempt) => [attempt.commandId, attempt]));
  for (const attempt of bound) if (ownGroup(attempt) || !members.has(attempt.commandId)) members.set(attempt.commandId, attempt);
  return { ...group, members: [...members.values()], id: newestAttempt([...members.values()]).attemptId };
}

function attemptGroups(attempts) {
  const groups = new Map();
  for (const attempt of attempts) {
    const key = attemptGroupKey(attempt);
    if (!groups.has(key)) groups.set(key, { key, attempts: [] });
    groups.get(key).attempts.push(attempt);
  }
  return [...groups.values()].map((group) => {
    const latest = new Map();
    for (const attempt of group.attempts) latest.set(attempt.commandId, attempt);
    const members = [...latest.values()];
    const last = newestAttempt(members);
    return { ...group, members, id: group.attempts[0].localRunId ?? last.attemptId, at: attemptRecordedAt(last) || last.process?.startedAt || '' };
  }).sort((left, right) => String(right.at).localeCompare(String(left.at)));
}

/** What a reader must not take this run for: a run of this step, or the whole suite [TCE:REQ-083, REQ-094]. */
function testRunNote(attempt, workflow, phaseId, narrowed = null) {
  const source = attempt.reusedFrom ?? (attempt.phase !== phaseId ? attempt : null);
  const reused = source ? `Not run again: this is ${source.attemptId} recorded by ${source.phase}, on the same code.` : null;
  const scoped = attempt.testScope?.files ? `Only this Story's new and changed tests ran (${attempt.testScope.files.join(', ')}); its existing tests did not.`
    : attempt.testScope?.whole ? `Ran whole although the Story runs only its new and changed tests: ${attempt.testScope.whole}.` : null;
  // A path the Story's script names is shown even when it dropped nothing and nobody was asked.
  const paths = narrowed ? (attempt.narrowing?.paths ?? []).map(narrowed.pathNarrowingWords).join(' ') : '';
  return [reused, scoped, paths].filter(Boolean).join(' ') || null;
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
  const itemRelative = workDirRelative(config, workflow.workItem.id);
  // A step whose tests stood from an earlier step shows that step's run, labelled as reused below.
  const standing = (workflow.phases[phaseId].checks ?? []).filter((check) => check.reusedFrom);
  const own = await stepAttempts(root, itemRelative, workflow.workItem.id, phaseId);
  const attempts = own.length || !standing.length ? own : (await Promise.all([...new Set(standing.map((check) => check.reusedFrom.phase))]
    .map((id) => stepAttempts(root, itemRelative, workflow.workItem.id, id)))).flat().filter((attempt) => standing.some((check) => check.reusedFrom.attemptId === attempt.attemptId));
  const groups = attemptGroups(attempts);
  const wanted = localRunId ?? (typeof options.run === 'string' ? options.run : null);
  const group = wanted
    ? groups.find((entry) => entry.id === wanted || entry.members.some((attempt) => attempt.attemptId === wanted))
    : groups[0] ? boundRun(groups[0], attempts, workflow.phases[phaseId].deliveryEvidence) : null;
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
  const narrowed = group.members.some((attempt) => attempt.narrowing?.reasons?.length || attempt.narrowing?.paths?.length) ? await import('../test-narrowing.mjs') : null;
  for (const attempt of group.members) {
    const contents = await rawReportContents(root, attempt, workflow.workItem.id);
    const locations = await rawReportLocations(attempt, contents);
    const messages = await caseMessages(root, attempt, contents);
    const accepted = narrowed && attempt.narrowing?.reasons?.length
      ? narrowed.coveringTestNarrowing(workflow, { phaseId, attempt, at: new Date().toISOString() }) : null;
    entries.push({
      receipt: attempt, kind: 'test', locations, ...(messages ? { messages } : {}), ...await attemptMeaning(attempt, declaration),
      ...(testRunNote(attempt, workflow, phaseId, narrowed) ? { note: testRunNote(attempt, workflow, phaseId, narrowed) } : {}),
      ...(narrowed && attempt.narrowing?.reasons?.length ? { narrowing: { reasons: attempt.narrowing.reasons, words: narrowed.narrowingWords(attempt.narrowing),
        accepted: accepted ? { id: accepted.id, reason: accepted.reason, actor: accepted.actor } : null } } : {}),
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
      uncommittedChanges: first.uncommittedChanges ?? ['preflight', 'candidate'].includes(first.purpose),
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

/** The paths a step's plan names, and the commands those paths would resolve to once they change. */
async function plannedPaths(root, config, workflow, phase) {
  const [{ plannedStepPaths }, { workDirRelative }] = await Promise.all([import('../candidate-scope.mjs'), import('../story-paths.mjs')]);
  return plannedStepPaths(path.join(root, workDirRelative(config, workflow.workItem.id)), workflow, phase).catch(() => ({ sourcePaths: [], testPaths: [] }));
}

async function planStory(root, options) {
  const [state, { resolveDeliveryQualityCommands, testCommandProvenance }] = await Promise.all([import('../local-test-runs.mjs'), import('../delivery-evidence.mjs')]);
  const context = await storyContext(root, options);
  const phaseId = optionString(options, 'phase', null);
  let resolved = null;
  let stopped = null;
  try { resolved = await state.resolveStoryLocalTestCommands(root, context.config, context.workflow, { phaseId }); }
  catch (error) {
    // A plan says what would stop the run; a step that is not a code step, or does not exist, is still the caller's mistake.
    if (!(error instanceof SingularityFlowError) || /^TESTS_/u.test(error.code ?? '')) throw error;
    stopped = { code: error.code ?? null, words: error.message, ...(error.details?.nextAction ? { nextAction: error.details.nextAction } : {}) };
  }
  const phase = resolved?.phase ?? context.workflow.phases[phaseId ?? context.workflow.currentPhase];
  const planned = await plannedPaths(root, context.config, context.workflow, phase);
  const plannedFiles = [...planned.sourcePaths, ...planned.testPaths];
  let commands = resolved?.commands ?? [];
  // Nothing changed yet and nothing at the root to run: say what the plan's own files will resolve to.
  let prospective = false;
  if (!commands.length && !resolved?.deliveryEvidence?.sourcePaths?.length && plannedFiles.length) {
    const held = { ...phase, deliveryEvidence: planned };
    const found = await resolveDeliveryQualityCommands(root, held, {}).catch(() => []);
    commands = found.filter((command) => command && typeof command === 'object' && !Array.isArray(command) && command.kind === 'test')
      .map((command) => ({ ...command, provenance: testCommandProvenance(phase, command) }));
    prospective = commands.length > 0;
    if (prospective) stopped = null;
  }
  const entries = context.withEnvironments(prospective ? commands : context.select(commands));
  const shown = [];
  for (const entry of entries) shown.push(await plannedCommand(root, entry.command, entry, context.declaration));
  const evidence = resolved?.deliveryEvidence ?? null;
  // What the next gate would find against each command's pin, before it finds it. Only the gate refuses.
  if (phase && shown.length) {
    const { testCommandPinStandings } = await import('../test-command-pins.mjs');
    const standings = await testCommandPinStandings(root, context.config, context.workflow, phase, entries.map((entry) => entry.command), evidence).catch(() => new Map());
    for (const command of shown) if (standings.has(command.id)) command.pin = standings.get(command.id);
  }
  return {
    resultType: 'sflow-test-plan',
    scope: { kind: 'story', capability: context.workflow.resolution?.capability?.id ?? null, workId: context.workflow.workItem.id, phase: phase.id },
    localIntegrationEvidence: context.allowed ? 'allowed' : 'off',
    commands: shown,
    ...(prospective ? { prospective: true } : {}),
    ...(stopped ? { stopped } : {}),
    ...await planDetails(root, entries.map((entry) => entry.command), {
      changed: [...(evidence?.sourcePaths ?? []), ...(evidence?.testPaths ?? [])],
      planned: plannedFiles, plannedTests: planned.testPaths })
  };
}

/**
 * `tests base`: does this also fail without the Story's change? Each command once on the base commit,
 * compared with the step's latest run. See src/verification/base-run.mjs: it runs no gate and records no attempt.
 */
async function baseStory(root, options) {
  const [state, { localTestRunKernel: kernel }, { baseComparison, failedNames, runOnBase, storyBaseCommit }, { stepAttempts }, { workDirRelative }, { nodeVersion }, { parseTestResult }, { realpath }] = await Promise.all([
    import('../local-test-runs.mjs'), import('../state-stores.mjs'), import('../verification/base-run.mjs'), import('../verification/attempts.mjs'),
    import('../story-paths.mjs'), import('../test-toolchain.mjs'), import('../code-delivery-tests.mjs'), import('node:fs/promises')]);
  const context = await storyContext(root, options);
  const { phase, commands } = await state.resolveStoryLocalTestCommands(root, context.config, context.workflow, { phaseId: optionString(options, 'phase', null) });
  const baseCommit = storyBaseCommit(context.workflow, phase);
  const scope = { kind: 'story', capability: context.workflow.resolution?.capability?.id ?? null, workId: context.workflow.workItem.id, phase: phase.id };
  if (!baseCommit) fail(`Story ${context.workflow.workItem.id} names no base commit to compare with.`, 'TESTS_BASE_UNKNOWN');
  const attempts = await stepAttempts(root, workDirRelative(context.config, context.workflow.workItem.id), context.workflow.workItem.id, phase.id);
  const results = [];
  for (const selected of context.select(commands)) {
    // Files only this Story added or changed are no question for the base: it runs the whole command.
    const command = selected.testScope?.baseCommand ?? selected;
    const latest = attempts.filter((attempt) => attempt.commandId === command.id).at(-1) ?? null;
    const here = latest && latest.status !== 'passed' ? failedNames(latest.occurrences) : [];
    const cwd = path.join(root, command.workingDirectory ?? '.');
    const version = await nodeVersion('node', { cwd, environment: process.env }).catch(() => null);
    const result = await runOnBase(root, command, { baseCommit, nodeVersion: version, gateRun: async (workspace) => {
      const [check] = await kernel.qualityChecks(root, phase, context.config, context.workflow, [command], { candidateRoot: await realpath(workspace), candidateIsOtherCode: true });
      try {
        const parsed = await parseTestResult(root, command, { startedAt: check.startedAt }).catch(() => null);
        return { check, parsed, reportError: parsed ? null : 'SFlow could not read a report from this run.' };
      } finally { await kernel.restoreTransientQualityResult(check); }
    } });
    results.push({ ...result, here, ...baseComparison(result, { here }) });
  }
  return { resultType: 'sflow-test-base', scope, baseCommit, results };
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
    else console.log((await import('../test-plan.mjs')).testPlanText(result));
    return result;
  }
  if (subcommand === 'base') {
    if (!story) fail('tests base compares a Story step with the commit it started from; name it with --work-id.');
    const result = await baseStory(root, options);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.scope.workId} step ${result.scope.phase}, against its base commit ${result.baseCommit.slice(0, 12)}. This is a fact for a person: it is not evidence and refuses nothing.`);
      for (const entry of result.results) console.log(`  ${entry.commandId}${entry.reused ? ' (already run on this base)' : ''}: ${entry.words}`);
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
