/**
 * Model-free bug triage for the golden journey.
 *
 * The result names suspects and observations. It never upgrades a commit, path, or text match into
 * a cause: causation still requires a reproducer or equivalent governed evidence.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { branch, head } from '../../git.mjs';
import { analyzeRegression } from '../../regression-analysis.mjs';
import { SingularityFlowError, run } from '../../util.mjs';
import { relayFacts, relayRequest, validateInterpretation } from '../assisted-relay.mjs';
import { noEffects, plannerNavigation, preservedAll, sflowResult } from '../result.mjs';

const MAX_MATCHES = 80;
const MAX_COMMITS = 20;
const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'before', 'could', 'does', 'failed', 'failure', 'from',
  'have', 'into', 'issue', 'that', 'this', 'when', 'where', 'which', 'with', 'would'
]);

function nul(output) { return String(output ?? '').split('\0').filter(Boolean); }

function investigationTerms(symptom) {
  return [...new Set(String(symptom).toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) ?? [])]
    .filter((term) => !STOP_WORDS.has(term))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .slice(0, 5);
}

function changedPaths(root) {
  const status = run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root, allowFailure: true
  });
  if (status.status !== 0) return null;
  return nul(status.stdout).map((row) => row.slice(3)).filter(Boolean).sort().slice(0, 200);
}

function textMatches(root, terms) {
  const matches = [];
  for (const term of terms) {
    const found = run('git', ['grep', '-n', '-I', '-F', '-e', term, '--', '.'], {
      cwd: root, allowFailure: true, maxBuffer: 2 * 1024 * 1024
    });
    if (![0, 1].includes(found.status)) continue;
    for (const row of found.stdout.split(/\r?\n/).filter(Boolean)) {
      const [file, line] = row.split(':', 3);
      if (!file || !/^\d+$/.test(line ?? '')) continue;
      matches.push({ term, path: file, line: Number(line) });
      if (matches.length >= MAX_MATCHES) return matches;
    }
  }
  return matches;
}

function recentCommits(root) {
  const result = run('git', [
    'log', `--max-count=${MAX_COMMITS}`, '--format=%H%x00%aI%x00%s'
  ], { cwd: root, allowFailure: true });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).filter(Boolean).map((row) => {
    const [commit, authoredAt, subject] = row.split('\0');
    return { commit, short: commit.slice(0, 8), authoredAt, subject };
  });
}

function repositoryMatches(root, requested, context) {
  if (!requested) return true;
  return [root, context.repositoryId, context.repository?.id]
    .filter(Boolean).map(String).includes(String(requested));
}

function regressionCandidates(root, sinceRef) {
  if (!sinceRef) return { status: 'not-requested', candidates: [], caveat: null };
  try {
    const report = analyzeRegression(root, { base: sinceRef, bad: 'HEAD', maxCandidates: 20 });
    return {
      status: 'observed',
      range: report.range,
      candidates: report.candidates,
      caveat: report.caveat
    };
  } catch (error) {
    return {
      status: 'unavailable', candidates: [],
      reason: error.code ?? error.name ?? 'regression-analysis-unavailable', caveat: null
    };
  }
}

/** Every configured test command that runs as argv: the allowlist `[INT:CON-095]`. */
export function configuredTestCommands(definition) {
  const found = new Map();
  const collect = (commands) => {
    for (const command of commands ?? []) {
      if (command?.kind === 'test' && command.id && Array.isArray(command.argv) && command.argv.length && !found.has(command.id)) {
        found.set(command.id, { id: command.id, argv: command.argv.map(String), workingDirectory: command.workingDirectory ?? '.' });
      }
    }
  };
  for (const phase of Object.values(definition?.phases ?? {})) collect(phase?.qualityCommands);
  for (const type of Object.values(definition?.workTypes ?? {})) {
    for (const override of Object.values(type?.phaseOverrides ?? {})) collect(override?.qualityCommands);
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The evidence sequence, in the order §10.2 gives it `[INT:REQ-091]`. A step that cannot run is
 * recorded as such and the ones after it still run; a step that fails stops the walk, and the
 * report keeps everything already observed and names what did not complete `[INT:REQ-155]`. Every
 * step's status — completed, skipped, unavailable, failed, not run — is disclosed `[INT:REQ-093]`.
 */
export const EVIDENCE_SEQUENCE = Object.freeze([
  'incident-facts', 'build-provenance', 'repository-state', 'change-range', 'tests',
  'ownership-and-active-work', 'deterministic-impact', 'assisted-hypotheses'
]);

/** Record types an investigation keeps apart `[INT:CON-092]`, each with its own catalog wording. */
export const INVESTIGATION_RECORD_TYPES = Object.freeze([
  'observation', 'reproduction', 'correlation', 'hypothesis', 'conclusion', 'contradiction', 'unknown'
]);

/** Categorical, evidence-based confidence; never a number `[INT:CON-098]`. */
export const CONFIDENCE_LABELS = Object.freeze(['verified', 'strong-candidate', 'candidate', 'correlated', 'unknown']);

/**
 * The §10.1 inputs `[INT:REQ-090]`. One not given is recorded as unknown, never filled from an
 * assumption `[INT:CON-091]`. The whole planner is a read: reproduction and bisection are separate,
 * confirmed plans `[INT:CON-090]`.
 */
const INCIDENT_INPUTS = Object.freeze(['expected', 'environment', 'observedVersion', 'observedBuildId', 'since', 'reproduction', 'lastKnownGood']);

const record = (type, statement, { confidence = 'unknown', source = 'deterministic', reference = null } = {}) =>
  Object.freeze({ type, code: `investigation.record.${type}`, statement: String(statement).slice(0, 300), confidence, source, reference });

/**
 * The ID a host keeps this report under, derived from the report itself. `[INT:IFC-061]`
 *
 * An investigation is a read and stores nothing `[INT:CON-090]`, so this names a result rather than
 * a record: the same evidence gives the same ID, and a host that kept the result can open it again
 * by ID while one that did not says so instead of rerunning anything.
 */
export function investigationIdOf(report, repository = {}) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ head: repository.head ?? null, branch: repository.branch ?? null, report }))
    .digest('hex');
  return `inv-${digest.slice(0, 20)}`;
}

export function problemInvestigationResult({
  symptom, repositoryId, repository, terms, matches, paths, commits, regression, subject = null,
  assistedRequested = false, report = null, assisted = null, next = [], investigationId = null
} = {}) {
  const boundedMatches = [...new Map(matches.map((entry) => [
    `${entry.path}:${entry.line}`, { path: entry.path, line: entry.line }
  ])).values()];
  const incomplete = (report?.steps ?? []).filter((step) => ['failed', 'not-run'].includes(step.status));
  return sflowResult({
    kind: 'read',
    operation: {
      id: assistedRequested ? 'problem.investigate.assisted' : 'problem.investigate',
      classification: 'read'
    },
    subject,
    outcome: {
      status: 'succeeded', messageId: 'gateway.read',
      slots: { matches: String(boundedMatches.length), commits: String(commits.length) }
    },
    effects: noEffects(),
    why: [{
      code: 'investigation.deterministic-triage', source: 'deterministic', reference: repository.head,
      slots: { matches: String(boundedMatches.length), terms: String(terms.length) }
    }, ...(report ? [{
      code: 'investigation.evidence-sequence', source: 'deterministic', reference: null,
      slots: { completed: String(report.steps.filter((step) => step.status === 'completed').length), total: String(report.steps.length) }
    }] : [])],
    warnings: [
      ...(assistedRequested && !assisted?.accepted?.length ? [{ code: 'investigation.assistance-not-invoked', source: 'unavailable', slots: {} }] : []),
      ...incomplete.map((step) => ({ code: 'investigation.step-incomplete', source: 'unavailable', slots: { step: step.id } })),
      ...(report?.unknown ?? []).map((field) => ({ code: 'investigation.unknown-input', source: 'unavailable', slots: { field } }))
    ],
    preserved: preservedAll('investigation.nothing-was-carried-out', { reference: repositoryId }),
    next,
    restState: next.length ? null : 'informational',
    data: {
      symptomProvided: Boolean(symptom),
      repository: { id: repositoryId, ...repository },
      observations: {
        searchTermCount: terms.length,
        textMatches: boundedMatches,
        changedPaths: paths,
        recentCommits: commits,
        regression
      },
      bounds: {
        maximumTextMatches: MAX_MATCHES,
        maximumRecentCommits: MAX_COMMITS,
        sourceBodiesIncluded: false
      },
      // A person concludes; this report never does.
      conclusion: null,
      caveat: 'These observations narrow investigation. Only a reproducer or equivalent evidence can establish a cause.',
      assisted: assisted ?? { requested: assistedRequested, invoked: false },
      ...(investigationId ? { investigationId } : {}),
      ...(report ? { report } : {})
    }
  });
}

/**
 * The investigation report `[INT:IFC-043]`, built from the steps that completed.
 *
 * Change candidates are commits in the range that touch a path the symptom's terms matched; the
 * rest of the range is only correlated. A build is related to the range through exact provenance
 * or not at all. Nothing here runs a test — reproduction belongs to the separately confirmed
 * bisection plan — so no record in this report is `verified`.
 */
async function investigationReport({ args, root, context, repository, terms, matches, paths, commits, regression, env, runs }) {
  const steps = [];
  const records = [];
  // `stopAfter` narrows progressively `[INT:REQ-092]`: the person may stop after any step and keep
  // what it found; a failed step stops the walk the same way `[INT:REQ-155]`.
  let stopped = null;
  const step = async (id, read) => {
    if (stopped) { steps.push({ id, status: 'not-run', reason: stopped }); return; }
    try {
      const status = await read();
      steps.push({ id, status: status ?? 'completed' });
    } catch (error) {
      steps.push({ id, status: 'failed', reason: String(error?.code ?? 'failed').slice(0, 64) });
      stopped = 'after-failure';
    }
    if (!stopped && args.stopAfter === id) stopped = 'stopped-by-request';
  };
  const unknown = INCIDENT_INPUTS.filter((field) => args[field] == null);
  let buildMappings = [];
  let changeCandidates = [];
  const contradictions = [];
  const missingEvidence = [];
  const ownersSeen = [];
  await step('incident-facts', () => {
    // The person's words stay out of results and logs; that a symptom was given is the fact.
    records.push(record('observation', 'a symptom was reported', { source: 'evidence' }));
    for (const field of unknown) records.push(record('unknown', field));
  });
  await step('build-provenance', async () => {
    const { buildRelation, gitAncestry, readBuilds } = await import('../build-provenance.mjs');
    const read = await readBuilds(root, { repositoryId: context.repositoryId ?? null, env, runs });
    if (read.gap) { missingEvidence.push(read.gap); return 'unavailable'; }
    const isAncestor = await gitAncestry(root);
    buildMappings = read.builds.slice(0, 20).map((build) => ({
      buildId: build.buildId, pipeline: build.pipeline, result: build.result, sourceCommit: build.sourceCommit,
      providerReference: build.providerReference, ...buildRelation(build, repository.head, { isAncestor })
    }));
    const observed = args.observedBuildId ? buildMappings.find((build) => build.buildId === args.observedBuildId) : null;
    if (args.observedBuildId && !observed) records.push(record('unknown', `build ${args.observedBuildId} was not among the provider's recent builds`));
    for (const build of buildMappings) {
      records.push(record(build.relation === 'mapping-unavailable' || build.relation === 'observed-near' ? 'correlation' : 'observation',
        `build ${build.buildId} ${build.language}`, { source: 'provider', confidence: build.relation === 'built-from' || build.relation === 'contains' ? 'strong-candidate' : 'correlated', reference: build.providerReference }));
    }
  });
  await step('repository-state', () => {
    records.push(record('observation', `HEAD ${repository.head ?? 'unborn'} on ${repository.branch ?? 'a detached HEAD'}`, { reference: repository.head }));
    if (paths === null) { missingEvidence.push('working-tree-status'); return 'unavailable'; }
    if (paths.length) records.push(record('observation', `${paths.length} uncommitted path(s) in the working tree`));
  });
  await step('change-range', () => {
    if (regression?.status !== 'observed') { if (args.sinceRef) missingEvidence.push('change-range'); return args.sinceRef ? 'unavailable' : 'skipped'; }
    const matched = new Set(matches.map((entry) => entry.path));
    changeCandidates = (regression.candidates ?? []).slice(0, 20).map((candidate) => {
      const touches = (candidate.paths ?? candidate.files ?? []).some((file) => matched.has(file));
      return { commit: candidate.commit ?? candidate.sha ?? null, subject: candidate.subject ?? null, confidence: touches ? 'candidate' : 'correlated' };
    });
    for (const candidate of changeCandidates) {
      records.push(record(candidate.confidence === 'candidate' ? 'observation' : 'correlation',
        `${String(candidate.commit ?? '').slice(0, 12)} ${candidate.subject ?? ''}`.trim(), { confidence: candidate.confidence, reference: candidate.commit }));
    }
  });
  await step('tests', async () => {
    const { loadDefinition } = await import('../../config.mjs');
    const commands = configuredTestCommands(await loadDefinition(root).catch(() => ({})));
    if (!commands.length) { missingEvidence.push('configured-test-command'); return 'unavailable'; }
    records.push(record('observation', `configured test commands: ${commands.map((command) => command.id).join(', ')}`));
    return 'completed';
  });
  await step('ownership-and-active-work', async () => {
    const [{ typedFileText }, { ownersOf }, { workRecords }] = await Promise.all([
      import('../../git-access.mjs'), import('./impact-quick.mjs'), import('../work-records.mjs')
    ]);
    const files = [...new Set(matches.map((entry) => entry.path))];
    const text = repository.head ? ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']
      .map((file) => typedFileText(root, repository.head, file)).find((value) => value != null) : null;
    if (text == null) missingEvidence.push('ownership');
    else ownersSeen.push(...ownersOf(text, files));
    const work = await workRecords(root, context);
    for (const item of work.items.slice(0, 10)) records.push(record('observation', `active work ${item.id} in ${item.phase ?? 'no phase'}`, { source: 'lifecycle', reference: item.id }));
  });
  await step('deterministic-impact', () => {
    records.push(record('observation', `${matches.length} line(s) match the symptom's terms in ${new Set(matches.map((entry) => entry.path)).size} file(s)`));
  });
  steps.push(stopped ? { id: 'assisted-hypotheses', status: 'not-run', reason: stopped } : { id: 'assisted-hypotheses', status: 'skipped' });
  return Object.freeze({
    subject: { repository: context.repositoryId ?? null, workId: context.workId ?? null },
    symptomProvided: Boolean(args.symptom),
    // Identifiers are echoed; prose a person typed is reported only as given or not.
    inputs: Object.fromEntries(INCIDENT_INPUTS.map((field) => [field,
      ['observedVersion', 'observedBuildId', 'lastKnownGood', 'since'].includes(field) ? args[field] ?? null : args[field] != null])),
    unknown,
    evidenceScope: { head: repository.head, branch: repository.branch, since: args.sinceRef ?? null },
    revisions: { head: repository.head, since: typeof regression?.range === 'string' ? regression.range.split('..')[0] : null },
    records,
    buildMappings,
    changeCandidates,
    owners: ownersSeen,
    hypotheses: [],
    contradictions,
    missingEvidence,
    steps,
    effects: noEffects()
  });
}

export async function problemInvestigate({ arguments: args = {}, subject = null, root = null, context = {}, assistedRequested = false,
  env = process.env, runs = null } = {}) {
  const operationId = assistedRequested ? 'problem.investigate.assisted' : 'problem.investigate';
  if (!root) throw new SingularityFlowError(`${operationId} requires the repository root it should read.`, { code: 'PROBLEM_INVESTIGATE_NO_ROOT' });
  if (!repositoryMatches(root, args.repositoryId, context)) {
    return sflowResult({
      kind: 'refusal', operation: { id: operationId, classification: 'read' },
      outcome: { status: 'refused', messageId: 'gateway.refused', slots: { repository: args.repositoryId } },
      effects: noEffects(),
      why: [{ code: 'investigation.wrong-repository', source: 'deterministic', slots: { repository: args.repositoryId } }],
      preserved: preservedAll('investigation.nothing-was-carried-out', { reference: args.repositoryId }),
      restState: 'blocked'
    });
  }
  const terms = investigationTerms(args.symptom);
  // Machine paths are not evidence and must not cross into a result card or model context.
  const repository = { branch: branch(root), head: head(root) };
  const observed = {
    terms, matches: textMatches(root, terms), paths: changedPaths(root), commits: recentCommits(root),
    regression: regressionCandidates(root, args.sinceRef ?? args.lastKnownGood ?? null)
  };
  const report = await investigationReport({ args, root, context, repository, env, runs, ...observed });
  let assisted = null;
  if (assistedRequested) {
    const request = relayRequest('problem.investigate.assisted', relayFacts(report.records.map((entry) => ({ kind: entry.type, statement: entry.statement }))));
    assisted = args.interpretation
      ? { requested: true, invoked: 'host-relay', ...validateInterpretation(request, args.interpretation) }
      : { requested: true, invoked: false, relay: request };
    if (assisted.accepted?.length) {
      report.hypotheses.push(...assisted.accepted.map((entry) => record('hypothesis', entry.text, { source: 'assisted', reference: entry.cites.join(',') })));
      report.steps[report.steps.length - 1] = { id: 'assisted-hypotheses', status: 'completed' };
    }
  }
  const next = [];
  const good = report.revisions.since;
  if (good && repository.head && !report.missingEvidence.includes('configured-test-command')) {
    const { loadDefinition } = await import('../../config.mjs');
    const [command] = configuredTestCommands(await loadDefinition(root).catch(() => ({})));
    if (command) {
      next.push(plannerNavigation({
        handle: 'investigation:bisect', id: 'investigation:bisect', label: 'Find the introducing commit', rank: 0, kind: 'plan',
        reasonCode: 'investigation.bisect-available', confirmation: 'host-confirm', interaction: 'form', executable: false
      }, 'investigation.bisect', { good, bad: repository.head, testCommandId: command.id }));
    }
  }
  // `[INT:REQ-096]`: a finding may become governed work, through its own reviewed start plan.
  next.push(plannerNavigation({
    handle: 'investigation:start', id: 'investigation:start', label: 'Start a bug Story from this', rank: next.length,
    kind: 'read', reasonCode: 'investigation.start-from-finding', confirmation: 'none', interaction: 'navigation',
    emphasis: 'link', executable: false, fallback: { label: 'Start in the terminal', command: 'sflow start <WORK-ID>' }
  }, 'work.start.intake', { source: 'bug-report', summary: String(args.symptom).slice(0, 1900) }));
  const investigationId = investigationIdOf(report, repository);
  const workId = typeof context.workId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(context.workId) ? context.workId : null;
  /**
   * The whole report in the editor's Investigation view, by its ID only. `[INT:IFC-061]` `[INT:CON-131]`
   *
   * Opening a view, nothing more: the kernel withholds it from a host that has no such view, and
   * the documentation route beside it is the continuation there, since this result already carries
   * every record the view would show `[INT:REQ-130]`.
   */
  next.push({
    handle: 'host-action:investigation', id: 'investigation:open-view', label: 'Open the investigation', rank: next.length,
    kind: 'host-action', reasonCode: 'investigation.open-view', confirmation: 'none', interaction: 'navigation',
    emphasis: 'link', executable: false,
    hostAction: { id: 'vscode.openInvestigation', arguments: { investigationId, ...(workId ? { workId } : {}) } },
    fallback: { label: 'Read about investigations in the terminal', command: 'sflow explain investigation' }
  });
  return problemInvestigationResult({
    symptom: args.symptom,
    repositoryId: args.repositoryId ?? context.repositoryId ?? path.basename(root),
    repository, ...observed, subject, assistedRequested, report, assisted, next, investigationId
  });
}

export function problemInvestigateAssisted(input = {}) {
  // The model boundary belongs to a host: this returns the deterministic report and the relay, and
  // accepts back only interpretations that cite its facts.
  return problemInvestigate({ ...input, assistedRequested: true });
}
