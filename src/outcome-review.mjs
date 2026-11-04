/**
 * What a person checks once a Story's code and tests are in (docs/topics/outcome-review.md): the
 * application to try, each acceptance criterion with the tests that prove it and how they last ran,
 * the screens and files a person signs off, and what the Story's end still waits for.
 *
 * A standard post-code read. It records nothing and gates nothing, and
 * every route it shows is a command that already exists. The decisions it lists stay the person's:
 * a sign-off after inspecting the file, a scope disposition, an approval.
 */
import { loadAcceptedStoryExecution } from './accepted-story-execution.mjs';
import { owedDecisions } from './owed-decisions.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { applicationReviewPhase, authoringRoute, phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';

const MAX_TEXT = 400;
const PORT_PROBE_MS = 300;

function shortText(value) {
  // A clause's source links and scenario references are for the engine, not the person reading it.
  const text = String(value ?? '').replace(/\[scope:[^\]]+\]|\*\([^)]*\)\*/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** The Story's outcome, read from its records and this checkout's application state. */
export async function outcomeReview(root, { workId = null, capabilityId = null } = {}) {
  const { definition, workflow } = await loadAcceptedStoryExecution(root, workId);
  const [{ evidenceGraphFromAggregate }, { evaluateEvidence }, { mergedVerificationContracts }] = await Promise.all([
    import('./evidence/graph.mjs'), import('./evidence/evaluate.mjs'), import('./verification/contracts.mjs')
  ]);
  const graph = await evidenceGraphFromAggregate(root, definition, workflow);
  const evaluation = evaluateEvidence(graph);
  const [owed, application] = await Promise.all([
    owedDecisions(root, definition, workflow, workflow.phaseOrder ?? []),
    applicationOutcome(root, capabilityId)
  ]);
  const reviewPhase = applicationReviewPhase(workflow);
  const reviewSession = workflow.applicationReviews?.findLast(item => item.subject.phaseId === reviewPhase);
  const applicationReview = phaseRequiresCodeDelivery(workflow.phases[reviewPhase]) && workflow.resolution?.applicationReview?.mode && workflow.resolution.applicationReview.mode !== 'off'
    ? { required: workflow.resolution.applicationReview.mode === 'required', sessionId: reviewSession?.id ?? null,
      command: reviewSession ? `singularity-flow app-review inspect ${reviewSession.id} --work-id ${workflow.workItem.id}`
        : `singularity-flow app-review start --work-id ${workflow.workItem.id}`, copilotCommand: '/sf-app-review' } : null;
  return { ...(applicationReview ? { applicationReview } : {}), ...buildOutcomeReview({ workflow, graph, evaluation, owed, application,
    contracts: mergedVerificationContracts(graph.records?.planned ?? []),
    workItemRoot: workflow.resolution?.workItemRoot ?? definition?.workItemRoot ?? 'singularity/work-items' }) };
}

/** The outcome from what the readers returned. Pure, so the shape is tested without a Story. */
export function buildOutcomeReview({ workflow, graph, evaluation, owed = null, application = null, contracts = new Map(), workItemRoot = 'singularity/work-items' }) {
  const workId = workflow.workItem.id;
  const clauses = new Map((graph?.records?.indexes ?? []).flatMap((index) => index.clauses ?? []).map((clause) => [clause.id, clause]));
  const signOffs = owed?.status === 'owed' ? owed.witnesses ?? [] : [];
  // A visual check the plan gave no screenshot path: suggest one, and use it in the sign-off command.
  // Named for the criterion and slot, so two criteria with a slot of the same name never share a file.
  const suggested = (clauseId, slot) => `${String(workItemRoot).replace(/\/+$/u, '')}/${workId}/evidence/${String(clauseId).split(':').pop().toLowerCase()}-${slot}.png`;
  const filled = (entry) => entry.method === 'visual' && !(entry.files ?? []).length && entry.command
    ? { suggestedFile: suggested(entry.clauseId, entry.slot), command: entry.command.replace("'<EVIDENCE-PATH>'", suggested(entry.clauseId, entry.slot)) }
    : { command: entry.command ?? null };
  const criteria = (evaluation?.rows ?? []).filter((row) => row.type === 'AC').map((row) => {
    const verification = row.verification ?? {};
    const planned = contracts.get?.(row.id)?.slots ?? [];
    return {
      id: row.id,
      text: shortText(clauses.get(row.id)?.body),
      result: row.result ?? null,
      methods: clauses.get(row.id)?.verification?.methods ?? null,
      tests: (verification.witnesses ?? []).map((witness) => ({
        test: witness.test ?? null, file: witness.testSource ?? null, outcome: witness.outcome ?? null, status: witness.status ?? null
      })),
      checks: (verification.contract?.slots ?? []).map((slot) => {
        const plan = planned.find((entry) => entry.slot === slot.slot);
        const owedSlot = signOffs.find((entry) => entry.clauseId === row.id && entry.slot === slot.slot);
        return {
          slot: slot.slot, method: slot.method, role: slot.role ?? null, status: slot.status ?? null,
          // What a visual or inspection check is compared with: a document ID, a screen or a file.
          reference: ['visual', 'inspection'].includes(slot.method) ? plan?.witness?.target ?? plan?.witness?.path ?? null : null,
          ...(owedSlot ? (({ command, ...rest }) => ({ files: owedSlot.files ?? [], signOff: command, ...rest }))(filled(owedSlot)) : {})
        };
      }),
      findings: (row.findings ?? []).map((finding) => ({ code: finding.code, message: finding.message }))
    };
  });
  const phase = workflow.phases?.[workflow.currentPhase] ?? null;
  const codePhase = phaseRequiresCodeDelivery(phase) ? { id: workflow.currentPhase, ...phase }
    : (workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})).map(id => workflow.phases[id] && { id, ...workflow.phases[id] })
      .findLast(item => phaseRequiresCodeDelivery(item) && item.generation > 0) ?? null;
  const codeRepair = phaseRequiresCodeDelivery(phase) && phase.status === 'in_progress' && phase.generation > 0;
  const repair = codeRepair
    ? ['phase', 'begin', workflow.currentPhase, '--work-id', workId, '--json']
    : ['recover', workId, ...(phase ? ['--phase', phase.id ?? workflow.currentPhase] : []), '--for-agent', '--json'];
  const review = {
    resultType: 'sflow-outcome-review',
    workId,
    title: workflow.workItem.title ?? null,
    step: phase ? { id: workflow.currentPhase, status: phase.status ?? null, generation: phase.generation ?? null } : null,
    lifecycle: evaluation?.lifecycle?.words ?? null,
    completion: evaluation?.completion?.label ?? null,
    application: application ?? { status: 'unavailable', message: 'The application was not read.' },
    criteria,
    open: {
      signOffs: signOffs.map((entry) => ({ clauseId: entry.clauseId, slot: entry.slot, method: entry.method, status: entry.status,
        files: entry.files ?? [], ...filled(entry) })),
      scopeItems: owed?.status === 'owed' ? owed.scopeItems ?? [] : [],
      more: owed?.status === 'owed' ? owed.more ?? { witnesses: 0, scopeItems: 0 } : { witnesses: 0, scopeItems: 0 },
      blocking: (evaluation?.findings ?? []).filter((finding) => finding.blocking).map(({ code, message }) => ({ code, message }))
    },
    routes: {
      tests: codePhase ? safeCommandGuidance({ argv: ['tests', 'run', '--work-id', workId, '--phase', codePhase.id] }) : null,
      matrix: safeCommandGuidance({ argv: ['evidence', 'matrix', workId] }),
      decisions: safeCommandGuidance({ argv: ['decisions', workId] }),
      repair: safeCommandGuidance({ argv: repair, ...(codeRepair ? { skill: authoringRoute(phase, workflow).effectiveAuthoringSkill } : {}) }),
      continue: safeCommandGuidance({ argv: ['nextsteps', workId, '--for-agent', '--json'] })
    },
    optional: true
  };
  return { ...review, validation: deliveryValidation(review, codePhase, graph) };
}

/** One presentation contract for CLI, Copilot and the editor. Choices grant no acceptance. */
function deliveryValidation(review, delivered, graph) {
  const delivery = (graph?.deliveries ?? []).find(item => item.phaseId === delivered?.id && item.generation === delivered?.generation);
  const runs = (delivery?.executions ?? []).filter(item => item.kind !== 'phase-validation-observation').map(item => ({
    commandId: item.commandId, status: item.record?.status ?? 'unavailable',
    exitCode: item.record?.exitCode ?? null, timedOut: item.record?.timedOut === true,
    retained: Boolean(item.record && item.record.countsForStep !== false), terminal: item.record?.terminal !== false,
    tests: item.record?.tests ?? {}
  }));
  const tests = {
    status: !delivered ? 'not-applicable' : !runs.length ? 'not-recorded'
      : runs.some(run => run.status === 'failed' || run.timedOut || run.exitCode !== null && run.exitCode !== 0) ? 'failed'
      : runs.every(run => run.retained && run.terminal && run.status === 'passed' && run.exitCode === 0 && !run.tests.failed && !run.tests.skipped) ? 'passed' : 'incomplete',
    phase: delivered?.id ?? null, generation: delivered?.generation ?? null, runs,
    diagnosticRuns: (delivery?.preflight ?? []).map(item => ({ commandId: item.commandId, status: item.record?.status ?? 'unavailable', tests: item.record?.tests ?? {} }))
  };
  const app = review.application;
  const checks = review.criteria.flatMap(criterion => criterion.checks.filter(check => check.method !== 'test')
    .map(check => ({ criterion: criterion.id, slot: check.slot, method: check.method, status: check.status })));
  const choices = review.routes.tests ? [{ id: 'tests', label: 'Run tests', description: `Run this Story’s configured tests from ${delivered.id}.`, route: review.routes.tests }] : [];
  if (app.status === 'declared') {
    for (const entry of app.entries ?? []) {
      if (entry.started && entry.ready) choices.push({ id: `open:${entry.id}`, label: `Open ${entry.name}`, description: entry.url, entryId: entry.id });
      else if (!entry.started && !entry.portTaken && entry.start) choices.push({ id: `start:${entry.id}`, label: `Start ${entry.name}`,
        description: 'Use this checkout’s declared launch configuration.', entryId: entry.id, route: entry.start });
    }
  }
  if (['declared', 'none-declared'].includes(app.status)) choices.push({ id: 'configure', label: 'Set up or change local run configuration',
    description: 'Review launch commands, dependencies and environment files in Run & Test. Save launch settings for this checkout.',
    route: app.setup ?? safeCommandGuidance({ argv: ['app', 'suggest', ...(app.capability ? ['--capability', app.capability] : [])] }) });
  choices.push({ id: 'review', label: checks.length ? 'Review acceptance evidence' : 'Check acceptance criteria',
    description: checks.length ? 'Inspect screenshots or files and record any required human sign-off.' : 'Exercise the approved behavior; API and CLI deliveries need no web screen.', route: review.routes.matrix });
  choices.push({ id: 'repair', label: 'Request a repair', description: 'Keep this Story and use its current repair admission.', route: review.routes.repair },
    { id: 'continue', label: 'Continue workflow', description: 'Show the next workflow action. Outstanding checks remain owed.', route: review.routes.continue });
  return { schemaVersion: 1, binding: { workId: review.workId, phase: review.step?.id ?? null, generation: review.step?.generation ?? null },
    question: `What would you like to validate for ${review.workId}?`, tests,
    steps: [
      { id: 'tests', label: 'Automated tests', status: tests.status, detail: tests.status === 'not-applicable'
        ? 'This Story has no code delivery to test yet. Follow its current workflow step.' : tests.status === 'not-recorded'
        ? 'No retained test execution is recorded for this delivery. Diagnostic passes do not replace publication checks.'
        : `${runs.length} recorded test command(s). ${runs.slice(0, 8).map(run => `${run.commandId}: ${run.status}; ${run.tests.passed ?? 'unknown'} passed, ${run.tests.failed ?? 'unknown'} failed, ${run.tests.skipped ?? 'unknown'} skipped.`).join(' ')} Passing counts alone do not establish clause acceptance.` },
      { id: 'application', label: 'Try the application or API', status: app.status === 'none-declared' ? 'setup-available'
        : app.status === 'unavailable' ? 'unavailable' : app.entries?.some(entry => entry.started && entry.ready) ? 'ready'
          : app.entries?.some(entry => entry.started) ? 'starting' : 'not-running',
        detail: app.message ?? (app.status === 'none-declared' ? 'No launch configuration is declared. Set one up locally, or validate through tests and API/CLI evidence.'
          : app.entries?.some(entry => entry.portTaken) ? 'An address is occupied by another process. Review the local configuration before starting.'
          : 'Use this Story’s checkout and environment. Starting or configuring requires your choice.') },
      { id: 'evidence', label: 'Acceptance evidence and human review', status: checks.some(check => check.status !== 'met') ? 'pending' : checks.length ? 'met' : 'criteria-review',
        detail: checks.length ? 'Capture or attach genuine evidence, then use the human review checklist. A screenshot alone is not a sign-off.'
          : 'Check the acceptance criteria against tests, API responses or CLI output.' }
    ], choices, recordsAcceptance: false,
    instruction: 'Ask this question now with these choices. Prefer the native sflowDeliveryValidation tool; otherwise use the host question tool. Execute only the selected returned route when this surface permits it; otherwise hand off to that exact skill. Cancellation records nothing. Continue does not waive checks, submit or approve.' };
}

/**
 * The capability's declared application in this checkout: each start entry, whether it runs, and
 * whether another process already holds its address (the reason a start would be refused).
 */
async function applicationOutcome(root, capabilityId) {
  try {
    const { resolveCapabilityApplication } = await import('./capability-application-context.mjs');
    const context = await resolveCapabilityApplication(root, { capabilityId, subjectPath: '' });
    if (!context.application?.start?.length) {
      return { status: 'none-declared', capability: context.capabilityId ?? null,
        setup: safeCommandGuidance({ argv: ['app', 'suggest', ...(context.capabilityId ? ['--capability', context.capabilityId] : [])] }) };
    }
    const [{ applicationStatus }, { debugPortAccepts }, { loopbackApplicationUrl }] = await Promise.all([
      import('./application-run.mjs'), import('./application-debug.mjs'), import('./capabilities.mjs')
    ]);
    const status = await applicationStatus(root, context);
    const entries = [];
    for (const entry of status.entries) {
      let portTaken = false;
      if (!entry.started) {
        try {
          const url = loopbackApplicationUrl(entry.url);
          portTaken = await debugPortAccepts(Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
            { host: url.hostname.replace(/^\[|\]$/gu, ''), timeoutMs: PORT_PROBE_MS });
        } catch { portTaken = false; }
      }
      const argv = (action) => ['app', action, entry.id, '--capability', status.capability];
      entries.push({
        id: entry.id, name: entry.name ?? entry.id, url: entry.url, started: entry.started, ready: entry.ready, pid: entry.pid ?? null,
        ...(portTaken ? { portTaken: true } : {}),
        start: entry.started ? null : safeCommandGuidance({ argv: argv('start') }),
        stop: entry.started ? safeCommandGuidance({ argv: argv('stop') }) : null
      });
    }
    return { status: 'declared', capability: status.capability, entries };
  } catch (error) {
    return { status: 'unavailable', code: error?.code ?? null, message: shortText(error?.message) ?? 'The application could not be read.' };
  }
}
