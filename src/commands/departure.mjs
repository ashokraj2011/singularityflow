/**
 * `departure record|list|show`: a code step's departures from the approved documents [CQF:REQ-021].
 *
 * `record` is the model's: a /sf-code turn records what its change departs from without asking anyone,
 * and keeps working; publish goes ahead with the files. `list` and `show` read. A person decides each
 * one on the decisions table (`decisions`), or with `decision departure` in a /sf-decide turn or their
 * own terminal, never here.
 */
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';

export const DEPARTURE_ACTIONS = Object.freeze(['record', 'list', 'show']);
const ALLOWED = Object.freeze({
  record: ['kind', 'path', 'clause', 'reason', 'target', 'file', 'row-op', 'fulfillment', 'test', 'from', 'to', 'finding', 'supersedes'],
  list: ['phase', 'open'],
  show: []
});
const DECIDE_OPTIONS = Object.freeze(['departure', 'as', 'clause', 'reason', 'fetch']);

function refused(message, code = 'DEPARTURE_OPTIONS_INVALID') {
  throw new SingularityFlowError(message, { code });
}

const USAGE = [
  'Usage: singularity-flow departure record --kind path|supporting|plan-row|test|wording|clause --reason TEXT [--work-id WORK-ID] [--json]',
  '         path, supporting: --path FILE [--path FILE] [--clause CLAUSE]',
  '         plan-row: --clause CLAUSE --row-op add-row|set-fulfillment|remove-location|replace-location [--fulfillment KIND] [--path FILE] [--from FILE --to FILE]',
  '         test: --clause CLAUSE --row-op add-test|replace-test [--test FILE] [--from FILE --to FILE]',
  '         wording, clause: --target EARLIER-STEP --file DRAFT-COPY [--clause CLAUSE]',
  '         [--finding ID] [--supersedes DEP-NNN]',
  '       singularity-flow departure list [--phase PHASE] [--open] [--json]',
  '       singularity-flow departure show DEP-NNN [--json]',
  'Records what a code step\'s change departs from in the approved documents, without asking anyone. Publish goes',
  'ahead with the files; the step\'s approval waits until a person decides each departure on the decisions table.'
].join('\n');

function view(reading) {
  const { departure } = reading;
  return { id: departure.id, kind: departure.kind, phase: departure.phase, generation: departure.generation, status: reading.status,
    paths: departure.paths, clauses: departure.clauses, ...(departure.class ? { class: departure.class } : {}), ...(departure.change ? { change: departure.change } : {}),
    target: departure.target, reason: departure.reason, recordedBy: departure.recordedBy, at: departure.at, findings: departure.findings ?? [],
    ...(reading.acceptance ? { acceptedBy: { kind: reading.acceptance.kind, id: reading.acceptance.id } } : {}),
    ...(reading.rejection ? { rejectedBy: { id: reading.rejection.id, actor: reading.rejection.actor, reason: reading.rejection.reason } } : {}),
    ...(reading.changed ? { changedSinceAccepted: reading.changed } : {}) };
}

async function story(options) {
  const [{ repoRoot }, { loadAcceptedStoryExecution }] = await Promise.all([import('../git.mjs'), import('../accepted-story-execution.mjs')]);
  const root = repoRoot();
  const { workflow, definition: config } = await loadAcceptedStoryExecution(root, optionString(options, 'work-id') ?? undefined);
  return { root, config, workflow };
}

async function record(options) {
  const { root, config, workflow } = await story(options);
  if (workflow.status !== 'in_progress') refused(`Story ${workflow.workItem.id} is ${workflow.status}; departures are recorded while it is in progress.`, 'DEPARTURE_LIFECYCLE');
  const [{ actionActor }, { loadSession }, { recordDepartureRequest }, { departureWords }] = await Promise.all([
    import('../git.mjs'), import('../session.mjs'), import('../departure-records.mjs'), import('../departures.mjs')]);
  const session = await loadSession(root, { required: false });
  const agent = session?.workId === workflow.workItem.id ? session.agent ?? null : null;
  const recorded = await recordDepartureRequest(root, config, workflow, {
    kind: optionString(options, 'kind'), paths: optionStrings(options, 'path'), clauses: optionStrings(options, 'clause'), reason: optionString(options, 'reason'),
    target: optionString(options, 'target'), file: optionString(options, 'file'), 'row-op': optionString(options, 'row-op'), fulfillment: optionString(options, 'fulfillment'),
    test: optionString(options, 'test'), from: optionString(options, 'from'), to: optionString(options, 'to'), findings: optionStrings(options, 'finding'),
    supersedes: optionString(options, 'supersedes')
  }, { actor: actionActor(root), agent });
  if (!optionBoolean(options, 'json')) {
    console.log(`Recorded ${recorded.id}: ${departureWords(recorded)}.${recorded.proposal ? ` The draft is kept with the record at ${recorded.proposal.path}.` : ''} Keep working: publish goes ahead with it, and a person decides it on the decisions table before ${workflow.phases[recorded.phase]?.label ?? recorded.phase} is approved.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'departure.record', classification: 'mutation' }, subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('departure.record.succeeded', { departure: recorded.id, kind: recorded.kind }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }), data: { departure: recorded }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}

async function list(options) {
  const { root, workflow } = await story(options);
  const { departureReadings } = await import('../departure-records.mjs');
  const { departureHolds, departureWords } = await import('../departures.mjs');
  const readings = (await departureReadings(root, workflow, optionString(options, 'phase') ?? null))
    .filter((entry) => !optionBoolean(options, 'open') || departureHolds(entry.status));
  if (!optionBoolean(options, 'json')) {
    if (!readings.length) console.log(`${workflow.workItem.id} has no departures${optionBoolean(options, 'open') ? ' waiting for a decision' : ''}.`);
    for (const entry of readings) console.log(`${entry.departure.id}  ${entry.status.padEnd(10)} ${entry.departure.kind.padEnd(10)} ${departureWords(entry.departure)}`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'departure.list', classification: 'read' }, subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('departure.list.succeeded', { count: String(readings.length) }), effects: noEffects(),
    data: { departures: readings.map(view), decide: `singularity-flow decisions ${workflow.workItem.id}` }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}

async function show(id, options) {
  if (!/^DEP-\d{3,}$/u.test(String(id ?? ''))) refused('Name the departure: singularity-flow departure show DEP-NNN.');
  const { root, workflow } = await story(options);
  const { departureReadings, acceptanceCommand } = await import('../departure-records.mjs');
  const { departureWords } = await import('../departures.mjs');
  const reading = (await departureReadings(root, workflow)).find((entry) => entry.departure.id === id);
  if (!reading) refused(`${id} is not a departure of ${workflow.workItem.id}.`, 'DEPARTURE_NOT_FOUND');
  // An earlier step amended from this departure: its new generation names it, and the approval before it reads as amended by it [CQF:REQ-027].
  const amended = Object.values(workflow.phases ?? {}).flatMap((phase) => (phase.generationPublications ?? [])
    .filter((entry) => entry.origin?.departure === id).map((entry) => ({ phase: phase.id, generation: entry.generation, amendedGeneration: entry.generation - 1, amendment: entry.origin.id })));
  const data = { departure: view(reading), diff: reading.departure.diff ?? null, ...(amended.length ? { amended } : {}),
    ...(['plan-row', 'test', 'clause'].includes(reading.departure.kind) ? { acceptance: acceptanceCommand(workflow, reading.departure) } : {}) };
  if (!optionBoolean(options, 'json')) {
    console.log(`${id} (${reading.departure.kind}, ${reading.status}): ${departureWords(reading.departure)}.`);
    console.log(`Why: ${reading.departure.reason}`);
    for (const entry of amended) console.log(`${entry.phase} generation ${entry.amendedGeneration}'s approval is amended by ${id} (${entry.amendment}, generation ${entry.generation}).`);
    if (reading.departure.diff) console.log(reading.departure.diff);
  }
  emitCommandResult(commandResult({
    operation: { id: 'departure.show', classification: 'read' }, subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('departure.show.succeeded', { departure: id, status: reading.status }), effects: noEffects(), data
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}

export async function run(argv, { positionals = argv, options = {} } = {}) {
  const action = positionals[1] ?? 'list';
  if (options.help === true) return console.log(USAGE);
  if (!DEPARTURE_ACTIONS.includes(action)) refused(`Unknown departure action '${action}'. Use ${DEPARTURE_ACTIONS.join(', ')}.`);
  const allowed = new Set(['json', 'help', 'no-model', 'work-id', 'for-agent', ...ALLOWED[action]]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) refused(`Unsupported departure ${action} option --${key}.`);
  if (positionals.length > (action === 'show' ? 3 : 2)) refused('Unexpected departure arguments. Use --work-id for the Story.');
  if (action === 'record') return record(options);
  if (action === 'show') return show(positionals[2], options);
  return list(options);
}

/**
 * `decision departure [WORK-ID] --departure DEP-NNN [--departure ...] --as accepted|rejected --reason TEXT [--clause C]`:
 * a person's decision on departures, the same write the decisions table makes. Accepting a file writes one
 * plan amendment naming them; wording, one forward amendment; rejecting, one rejection the model reverts.
 */
export async function decisionDepartureCommand(positionals, options) {
  for (const key of Object.keys(options)) if (![...DECIDE_OPTIONS, 'json', 'help', 'no-model', 'work-id'].includes(key)) refused(`Unsupported decision departure option --${key}.`);
  const [{ repoRoot, actionActor }, { loadConfig }, { checkoutStoryBranch }, { loadAcceptedStoryExecution }, { loadSession }, { commitDepartureDecision }] = await Promise.all([
    import('../git.mjs'), import('../state-stores.mjs'), import('../story-branch-name.mjs'), import('../accepted-story-execution.mjs'), import('../session.mjs'), import('../departure-records.mjs')]);
  const root = repoRoot();
  const requestedId = positionals[2] ?? optionString(options, 'work-id') ?? null;
  if (requestedId) await checkoutStoryBranch(root, await loadConfig(root), requestedId, { fetch: optionBoolean(options, 'fetch') });
  const { workflow, definition: config } = await loadAcceptedStoryExecution(root, requestedId ?? undefined);
  if (workflow.status !== 'in_progress') refused(`Story ${workflow.workItem.id} is ${workflow.status}; departures are decided while it is in progress.`, 'DEPARTURE_LIFECYCLE');
  const as = optionString(options, 'as');
  if (!['accepted', 'rejected'].includes(as)) refused('Decide with --as accepted or --as rejected.');
  const session = await loadSession(root, { required: false });
  const agent = session?.workId === workflow.workItem.id ? session.agent ?? null : null;
  const result = await commitDepartureDecision(root, config, workflow, { departures: optionStrings(options, 'departure'), decision: as === 'accepted' ? 'accept' : 'reject',
    reason: optionString(options, 'reason') ?? '', clause: optionString(options, 'clause') ?? null }, { actor: actionActor(root), agent });
  if (!optionBoolean(options, 'json')) {
    console.log(`${result.departures.join(', ')} ${result.decision}${result.record?.id ? ` (${result.record.id})` : ''}.${result.decision === 'rejected' ? ' The model restores each file in the open generation; prepublish checks it is back.' : ''}`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.departure', classification: 'mutation' }, subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('decision.departure.succeeded', { departures: result.departures.join(', '), decision: result.decision }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }), data: result
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
