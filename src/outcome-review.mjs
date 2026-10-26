/**
 * What a person checks once a Story's code and tests are in (docs/topics/outcome-review.md): the
 * application to try, each acceptance criterion with the tests that prove it and how they last ran,
 * the screens and files a person signs off, and what the Story's end still waits for.
 *
 * Optional, and a read. It records nothing and gates nothing, no lifecycle result routes to it, and
 * every route it shows is a command that already exists. The decisions it lists stay the person's:
 * a sign-off after inspecting the file, a scope disposition, an approval.
 */
import { loadAcceptedStoryExecution } from './accepted-story-execution.mjs';
import { owedDecisions } from './owed-decisions.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';

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
  return buildOutcomeReview({ workflow, graph, evaluation, owed, application,
    contracts: mergedVerificationContracts(graph.records?.planned ?? []),
    workItemRoot: workflow.resolution?.workItemRoot ?? definition?.workItemRoot ?? 'singularity/work-items' });
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
  return {
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
      tests: safeCommandGuidance({ argv: ['tests', 'run', '--work-id', workId] }),
      matrix: safeCommandGuidance({ argv: ['evidence', 'matrix', workId] }),
      decisions: safeCommandGuidance({ argv: ['decisions', workId] })
    },
    optional: true
  };
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
