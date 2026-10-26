/**
 * The four record views a host action opens: Investigation, Context receipt, Handoff and Progress.
 * `[INT:IFC-060]` `[INT:IFC-061]` `[INT:CON-131]`
 *
 * Pure: each builder turns records that already exist into one view model, and one renderer draws
 * all four, so they cannot drift apart in how they say "unavailable". Nothing here reads, decides or
 * changes anything. A record that is missing is said to be missing, with the reason it is missing
 * and where else the same read can be made — never filled in.
 *
 * - Investigation: the report a `problem.investigate` read returned to this window. An
 *   investigation stores nothing `[INT:CON-090]`, so only the window that ran it can show it again.
 * - Context receipt: the content-free Evidence Packet record compiling a packet writes
 *   (`singularity-flow tokens report`): sources by digest, bytes, estimated tokens, omissions.
 * - Handoff: the `work.handoff` projection of governed records `[INT:REQ-178]` `[INT:CON-175]`.
 * - Progress: `singularity-flow progress` for a Story. No SFlow operation returns a job ID yet, so a
 *   job's progress has no record to read `[INT:REQ-187]`, and the view says exactly that.
 */
import { commandGuidanceHtml, COMMAND_GUIDANCE_COPY_SCRIPT } from './command-guidance.ts';
import { escape } from './webview.ts';
import { fieldLabel, hostActionSchemaId } from '../../../../src/gateway/argument-schemas.mjs';

export const HOST_RECORD_ACTIONS = Object.freeze({
  'vscode.openInvestigation': Object.freeze({
    viewType: 'singularityFlow.investigation', title: 'Investigation', fields: Object.freeze(['investigationId', 'workId'])
  }),
  'vscode.openContextReceipt': Object.freeze({
    viewType: 'singularityFlow.contextReceipt', title: 'Context receipt', fields: Object.freeze(['receiptId', 'workId'])
  }),
  'vscode.openHandoff': Object.freeze({
    viewType: 'singularityFlow.handoff', title: 'Handoff', fields: Object.freeze(['workId', 'workKind'])
  }),
  'vscode.openProgress': Object.freeze({
    viewType: 'singularityFlow.progress', title: 'Progress', fields: Object.freeze(['jobId', 'workId'])
  })
});

export type HostRecordAction = keyof typeof HOST_RECORD_ACTIONS;
export type HostRecordField = 'investigationId' | 'receiptId' | 'jobId' | 'workId' | 'workKind';
export type HostRecordRequest = Readonly<Partial<Record<HostRecordField, string>>>;

export function isHostRecordAction(value: unknown): value is HostRecordAction {
  return typeof value === 'string' && Object.hasOwn(HOST_RECORD_ACTIONS, value);
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Only the action's own fields, and only values shaped like what its schema accepts.
 *
 * The extension checks a command's argument against the shared schema before it gets here; this is
 * the view refusing to read anything else even if a caller skipped that, so no field a link did not
 * name can reach a read.
 */
export function hostRecordRequest(action: HostRecordAction, raw: unknown): HostRecordRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return Object.freeze({});
  const request: Partial<Record<HostRecordField, string>> = {};
  for (const field of HOST_RECORD_ACTIONS[action].fields as readonly HostRecordField[]) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value !== 'string') continue;
    if (field === 'workKind' ? ['story', 'initiative'].includes(value) : IDENTIFIER.test(value)) request[field] = value;
  }
  return Object.freeze(request);
}

export type HostRecordRoute = Readonly<{
  id: string;
  label: string;
  /** An existing editor command, run with `args`; null for the page's own Refresh. */
  command: string | null;
  args: readonly unknown[];
  /** The same route from a terminal, rendered with its Copilot and model-free equivalents. */
  shell: string | null;
}>;

type Fact = readonly [string, string];
export type HostRecordTable = Readonly<{ columns: readonly string[]; rows: ReadonlyArray<readonly string[]> }>;
export type HostRecordSection = Readonly<{
  heading: string;
  note?: string | null;
  facts?: readonly Fact[];
  table?: HostRecordTable | null;
  items?: readonly string[];
  /** What to say when the section has nothing, so an empty list never reads as a failed load. */
  empty?: string | null;
}>;

export type HostRecordChoice = Readonly<{
  field: HostRecordField;
  label: string;
  options: ReadonlyArray<Readonly<{ value: string; label: string; selected: boolean }>>;
}>;

export type HostRecordView = Readonly<{
  action: HostRecordAction;
  title: string;
  subtitle: string;
  state: 'loading' | 'ready' | 'unavailable';
  notice: Readonly<{ tone: 'info' | 'error'; text: string }> | null;
  facts: readonly Fact[];
  sections: readonly HostRecordSection[];
  choice: HostRecordChoice | null;
  routes: readonly HostRecordRoute[];
  /** The read this page made, from a terminal. */
  guidance: string | null;
  /** Where every value on the page came from. */
  source: string;
}>;

const REFRESH: HostRecordRoute = Object.freeze({ id: 'refresh', label: 'Refresh', command: null, args: Object.freeze([]), shell: null });

const text = (value: unknown, fallback = 'unknown'): string => {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value).slice(0, 400);
};
const short = (commit: unknown): string => (typeof commit === 'string' && /^[0-9a-f]{12,64}$/iu.test(commit) ? commit.slice(0, 12) : text(commit));
const words = (value: unknown): string => text(value).replaceAll('_', ' ').replaceAll('-', ' ');
const record = (value: unknown): Record<string, any> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {});
const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const count = (value: unknown): string => (Number.isFinite(value) ? Number(value).toLocaleString('en-US') : 'unknown');

function view(action: HostRecordAction, fields: Partial<HostRecordView> & Pick<HostRecordView, 'subtitle' | 'source'>): HostRecordView {
  return Object.freeze({
    action,
    title: HOST_RECORD_ACTIONS[action].title,
    state: 'ready',
    notice: null,
    facts: [],
    sections: [],
    choice: null,
    routes: [REFRESH],
    guidance: null,
    ...fields
  });
}

/** What a page shows while its read is in flight: the request it was opened with, nothing else. */
export function loadingView(action: HostRecordAction, request: HostRecordRequest): HostRecordView {
  const named = Object.entries(request).map(([field, value]) => `${fieldLabel(hostActionSchemaId(action), field)} ${value}`).join(' · ');
  return view(action, { state: 'loading', subtitle: named || 'Reading…', source: 'Reading the record…', routes: [] });
}

/** A read that failed: its message, bounded, and the same read from a terminal. */
export function failedView(action: HostRecordAction, request: HostRecordRequest, error: unknown, guidance: string | null = null): HostRecordView {
  const message = error instanceof Error ? error.message : String(error ?? 'The read failed.');
  return view(action, {
    state: 'unavailable', subtitle: Object.values(request).join(' · ') || 'Not read',
    notice: { tone: 'error', text: `The record could not be read: ${message.slice(0, 400)}` },
    guidance, source: 'Nothing was shown from a record, because the read did not complete. Nothing was changed.'
  });
}

const noStory = (action: HostRecordAction, what: string): HostRecordView => view(action, {
  state: 'unavailable', subtitle: 'No Story selected',
  notice: { tone: 'info', text: `No Story is selected, so there is no ${what} to read. Open this from a result that names one, or attach a Story from Stories and open it again.` },
  routes: [REFRESH, Object.freeze({ id: 'stories', label: 'Open Stories', command: 'singularityFlow.openStories', args: Object.freeze([]), shell: 'singularity-flow status' })],
  guidance: 'singularity-flow status',
  source: 'Nothing was read. Nothing was changed.'
});

// ---------------------------------------------------------------------------------------------
// Investigation

export type KeptInvestigation = Readonly<{ investigationId: string; receivedAt: string; result: any }>;

const INVESTIGATION_GUIDANCE = 'singularity-flow explain investigation';
/** The report's inputs are this schema's fields, so they are named by its labels. */
const INVESTIGATION_SCHEMA = 'problem-investigate-v1';

/** Ask for a symptom and run the read here; handled by the panel, never a command from the page. */
const INVESTIGATE: HostRecordRoute = Object.freeze({
  id: 'investigate', label: 'Investigate a failure…', command: null, args: Object.freeze([]), shell: null
});

function inputValue(value: unknown): string {
  if (value === true) return 'given (its words are not kept in the report)';
  if (value === false || value == null) return 'unknown — not given, and not filled in';
  return text(value);
}

export function investigationView({ request = {}, record: kept = null, kept: all = [] }: {
  request?: HostRecordRequest; record?: KeptInvestigation | null; kept?: readonly KeptInvestigation[];
} = {}): HostRecordView {
  const action = 'vscode.openInvestigation';
  const choice: HostRecordChoice | null = all.length > 1 || (all.length && !kept) ? {
    field: 'investigationId', label: 'Investigation this window ran',
    options: all.map((entry) => ({
      value: entry.investigationId,
      label: `${entry.investigationId} · ${text(entry.result?.operation?.id)} · ${text(entry.receivedAt)}`,
      selected: entry.investigationId === kept?.investigationId
    }))
  } : null;
  if (!kept) {
    const notice = request.investigationId
      ? `Investigation ${request.investigationId} is not held by this window. An investigation is a read and stores nothing, so its report stays only with the window that ran it, until that window reloads or changes repository. Investigate the failure again to see a current report here.`
      : all.length
        ? 'Choose one of the investigations this window ran.'
        : 'This window has not run an investigation. Investigations are reads and store nothing, so there is nothing to reopen. Investigate a failure here, or describe it to @sflow in Copilot Chat.';
    return view(action, {
      state: 'unavailable', subtitle: request.investigationId ?? 'No investigation selected',
      notice: { tone: 'info', text: notice }, choice, routes: [INVESTIGATE, REFRESH], guidance: INVESTIGATION_GUIDANCE,
      source: 'Nothing was read or rerun. Nothing was changed.'
    });
  }
  const result = record(kept.result);
  const data = record(result.data);
  const report = record(data.report);
  const repository = record(data.repository);
  const observations = record(data.observations);
  const regression = record(observations.regression);
  const steps = list(report.steps);
  const records = list(report.records);
  const candidates = list(report.changeCandidates);
  const builds = list(report.buildMappings);
  const revisions = record(report.revisions);
  const bisectOffered = list(result.next).some((entry) => entry?.id === 'investigation:bisect');
  const assisted = record(data.assisted);
  return view(action, {
    subtitle: `${kept.investigationId} · ${text(repository.id, 'this repository')}`,
    choice,
    facts: [
      ['Investigation', kept.investigationId],
      ['Operation', text(result.operation?.id)],
      ['Repository', text(repository.id, 'this repository')],
      ['HEAD', short(repository.head)],
      ['Branch', text(repository.branch, 'detached HEAD')],
      // The evidence scope's start is the `sinceRef` input, not the "failing since" one below.
      [fieldLabel(INVESTIGATION_SCHEMA, 'sinceRef'), text(record(report.evidenceScope).since, 'not given')],
      ...(report.subject?.workId ? [['Work', text(report.subject.workId)] as Fact] : []),
      ['Received', text(kept.receivedAt)]
    ],
    sections: [
      {
        heading: 'What was asked',
        note: 'Inputs not given stay unknown; nothing is assumed in their place.',
        facts: [
          ['Symptom', data.symptomProvided ? 'given (its words are not kept in the report)' : 'not given'],
          ...Object.entries(record(report.inputs)).map(([field, value]) => [fieldLabel(INVESTIGATION_SCHEMA, field), inputValue(value)] as Fact)
        ]
      },
      {
        heading: 'Evidence sequence',
        note: 'In the order the investigation reads evidence. A step that could not run says so; one that failed stops the rest.',
        table: { columns: ['Step', 'Status', 'Why'], rows: steps.map((step) => [words(step?.id), words(step?.status), text(step?.reason, '')]) },
        empty: 'No evidence step was recorded.'
      },
      {
        heading: 'Observations and correlations',
        note: 'Each kind stays separate: an observation is not a cause, and a correlation is not a reproduction.',
        table: { columns: ['Kind', 'Confidence', 'Source', 'Statement'], rows: records.map((entry) => [words(entry?.type), words(entry?.confidence), words(entry?.source), text(entry?.statement)]) },
        facts: [
          ['Text matches', `${count(list(observations.textMatches).length)} (bounded at ${count(record(data.bounds).maximumTextMatches)})`],
          ['Uncommitted paths', observations.changedPaths == null ? 'unavailable' : count(list(observations.changedPaths).length)],
          ['Recent commits read', count(list(observations.recentCommits).length)]
        ],
        empty: 'No observation was recorded.'
      },
      {
        heading: 'Change range and bisection',
        note: bisectOffered
          ? 'A bisection was offered for this range with the repository\'s configured test. It runs only after you confirm its plan, in disposable worktrees, from a host that carries it out (Copilot CLI through SFlow\'s gateway); this window does not run test commands.'
          : 'No bisection was offered: it needs a known-good revision and a configured test command.',
        facts: [
          ['Range', revisions.since ? `${short(revisions.since)}..${short(revisions.head)}` : 'no known-good revision was given'],
          ['Regression read', words(regression.status ?? 'not-requested')],
          ['Bisection', bisectOffered ? 'offered, not run' : 'not offered']
        ],
        table: { columns: ['Commit', 'Subject', 'Confidence'], rows: candidates.map((entry) => [short(entry?.commit), text(entry?.subject, ''), words(entry?.confidence)]) },
        empty: 'No change candidates: no range was read.'
      },
      {
        heading: 'Builds',
        note: 'A build is related to the range only through exact provenance; anything else is "observed near" or "mapping unavailable".',
        table: { columns: ['Build', 'Pipeline', 'Result', 'Relation', 'Commit'], rows: builds.map((build) => [text(build?.buildId), text(build?.pipeline, ''), words(build?.result), text(build?.language ?? build?.relation), short(build?.sourceCommit)]) },
        empty: 'No build mapping was read.'
      },
      { heading: 'Owners', items: list(report.owners).map((owner) => text(typeof owner === 'string' ? owner : owner?.owner ?? JSON.stringify(owner))), empty: 'No owners were read.' },
      {
        heading: 'Missing, unknown and contradicting evidence',
        items: [
          ...list(report.missingEvidence).map((entry) => `Missing: ${words(entry)}`),
          ...list(report.unknown).map((entry) => `Unknown: ${fieldLabel(INVESTIGATION_SCHEMA, String(entry))}`),
          ...list(report.contradictions).map((entry) => `Contradiction: ${text(typeof entry === 'string' ? entry : entry?.statement ?? JSON.stringify(entry))}`)
        ],
        empty: 'Nothing was reported missing, unknown or contradicting.'
      },
      {
        heading: 'Assisted hypotheses',
        note: assisted.requested ? 'Only interpretations that cite this report\'s facts are kept, and none is a conclusion.' : 'Assistance was not requested.',
        table: { columns: ['Hypothesis', 'Cites'], rows: list(report.hypotheses).map((entry) => [text(entry?.statement), text(entry?.reference, '')]) },
        empty: 'No hypothesis.'
      },
      {
        heading: 'Conclusion',
        note: text(data.caveat, 'Only a reproducer or equivalent evidence can establish a cause.'),
        items: [data.conclusion ? text(data.conclusion) : 'None recorded — a person concludes; this report never does.']
      }
    ],
    routes: [REFRESH, INVESTIGATE],
    guidance: INVESTIGATION_GUIDANCE,
    source: `Kept from the ${text(result.operation?.id)} result this window received at ${text(kept.receivedAt)}. Nothing was rerun, and nothing was changed.`
  });
}

// ---------------------------------------------------------------------------------------------
// Context receipt

/** `tokens report --json`'s envelope, or its ledger, or nothing. */
export function contextLedgerOf(value: unknown): Record<string, any> | null {
  const outer = record(value);
  const ledger = outer.data?.ledger ?? outer.ledger ?? null;
  return ledger && typeof ledger === 'object' ? ledger : null;
}

function metric(value: unknown, unit = ''): string {
  const entry = record(value);
  if (!Number.isFinite(entry.value)) return 'unavailable';
  return `${count(entry.value)}${unit} (${words(entry.status)}, ${words(entry.assurance)})`;
}

export function receiptGuidance(workId: string, packet: Record<string, any> | null): string {
  const phase = packet?.phase && IDENTIFIER.test(String(packet.phase)) ? String(packet.phase) : null;
  const id = packet?.packetId && IDENTIFIER.test(String(packet.packetId)) ? String(packet.packetId) : null;
  if (phase && id) return `singularity-flow context xray --work-id ${workId} --phase ${phase} --packet ${id}`;
  return `singularity-flow tokens report --work-id ${workId}${id ? ` --packet ${id}` : ''}`;
}

export function contextReceiptView({ request = {}, workId = null, ledger = null }: {
  request?: HostRecordRequest; workId?: string | null; ledger?: Record<string, any> | null;
} = {}): HostRecordView {
  const action = 'vscode.openContextReceipt';
  if (!workId) return noStory(action, 'context receipt');
  const packets = list(ledger?.packets).filter((entry) => typeof entry?.packetId === 'string');
  const selected = request.receiptId
    ? packets.find((entry) => entry.packetId === request.receiptId) ?? null
    : packets.at(-1) ?? null;
  const choice: HostRecordChoice | null = packets.length > 1 || (packets.length && !selected) ? {
    field: 'receiptId', label: 'Receipt',
    options: packets.map((entry) => ({
      value: entry.packetId,
      label: `${entry.packetId} · ${text(entry.phase, 'no phase')}${entry.generation == null ? '' : ` · generation ${entry.generation}`}`,
      selected: entry.packetId === selected?.packetId
    }))
  } : null;
  const source = `Read from this computer's content-free Evidence Packet records for ${workId} (singularity-flow tokens report). No context was expanded, no model was called, and nothing was changed.`;
  if (!selected) {
    return view(action, {
      state: 'unavailable', subtitle: `${workId}${request.receiptId ? ` · ${request.receiptId}` : ''}`,
      notice: {
        tone: 'info',
        text: request.receiptId
          ? `Receipt ${request.receiptId} is not recorded for ${workId} on this computer. Receipts are written beside this repository's Git data when SFlow compiles an Evidence Packet, so one compiled on another computer, or removed with its clone, is not here.`
          : `No context receipt is recorded for ${workId} on this computer. One is written when SFlow compiles an Evidence Packet for this Story here.`
      },
      choice, guidance: receiptGuidance(workId, null), source
    });
  }
  const correlation = record(selected.correlation);
  const provider = record(selected.provider);
  const economy = record(selected.tokenEconomy);
  const items = list(selected.itemUsage);
  const classes = Object.entries(record(selected.omissionClasses));
  const expansions = list(selected.expansions);
  return view(action, {
    subtitle: `${selected.packetId} · ${workId}`,
    choice,
    facts: [
      ['Receipt', selected.packetId],
      ['Story', workId],
      ['Phase', `${text(selected.phase, 'none')}${selected.generation == null ? '' : ` · generation ${selected.generation}`}`],
      ['Operation', text(correlation.operationId, 'not recorded')],
      ...(selected.flightPlanId ? [['Flight Plan', text(selected.flightPlanId)] as Fact] : []),
      ['Token economy', `${text(economy.mode, 'not recorded')}${economy.profile ? ` · ${economy.profile}` : ''}`]
    ],
    sections: [
      {
        heading: 'What it included',
        note: `Sources are named by digest only; the receipt keeps no content. Tokens are an estimate (${text(selected.estimationMethod)}), not provider billing.`,
        facts: [
          ['Content', metric(selected.includedBytes, ' bytes')],
          ['Estimated input', metric(selected.estimatedTokens, ' tokens')],
          ['Sources', `${count(items.length)} (${count(items.filter((item) => item?.mandatory).length)} required)`]
        ],
        table: { columns: ['Source digest', 'Bytes', 'Estimated tokens', 'Required', 'Cache class'],
          rows: items.map((item) => [short(item?.itemDigest), count(item?.bytes), count(item?.estimatedTokens), item?.mandatory ? 'required' : 'optional', words(item?.cacheClass)]) },
        empty: 'No source was included.'
      },
      {
        heading: 'What it left out',
        facts: [
          ['Omitted items', count(selected.omittedItems)],
          ['Unavailable items', count(selected.unavailableItems)]
        ],
        table: { columns: ['Omitted because', 'Items'], rows: classes.map(([name, value]) => [words(name), count(value)]) },
        items: list(selected.unavailableCodes).map((code) => `Unavailable: ${text(code)}`),
        empty: 'Nothing was left out.'
      },
      {
        heading: 'Expansions',
        note: 'Deeper material a reader asked for after the packet was compiled.',
        facts: [['Requests', count(selected.expansionRequests)], ['Expanded', metric(selected.expandedBytes, ' bytes')]],
        table: { columns: ['Kind', 'Bytes', 'Estimated tokens', 'When'], rows: expansions.map((entry) => [words(entry?.handleKind), count(entry?.includedBytes), count(entry?.estimatedTokens), text(entry?.expandedAt)]) },
        empty: 'Nothing was expanded.'
      },
      {
        heading: 'Digests',
        facts: [
          ['Cache key', text(selected.cacheKey, 'not recorded')],
          ['Context manifest', text(selected.contextManifestSha256, 'not recorded')],
          ['Cache manifest', text(selected.cacheManifestId, 'not recorded')],
          ['Token economy configuration', text(economy.configurationDigest, 'not recorded')]
        ]
      },
      {
        heading: 'Model route',
        note: 'Unavailable means the host did not report it; it is never guessed.',
        facts: [
          ['Provider', text(provider.id, 'unavailable')],
          ['Requested model', text(provider.requestedModel, 'unavailable')],
          ['Resolved model', provider.resolvedModel
            ? `${text(provider.resolvedModel)}${provider.resolutionAssurance ? ` (${words(provider.resolutionAssurance)})` : ''}` : 'unavailable'],
          ['Capture coverage', words(provider.captureCoverage ?? 'estimated')]
        ]
      }
    ],
    guidance: receiptGuidance(workId, selected),
    source
  });
}

// ---------------------------------------------------------------------------------------------
// Handoff

const HANDOFF_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  'work.not-in-this-repository': 'is not a Story this repository tracks',
  'work.revision-unavailable': 'cannot be handed off here: the exact repository revision could not be read, and a packet is always bound to one'
});

function sectionState(value: unknown, read: string): string {
  const state = record(value).state;
  if (state === 'not-read') return `Not read by this packet${record(value).reason ? ` (${words(record(value).reason)})` : ''}.`;
  if (state === 'unavailable') return `Unavailable${record(value).reason ? ` (${words(record(value).reason)})` : ''}.`;
  return read;
}

export function handoffView({ request = {}, workId = null, result = null }: {
  request?: HostRecordRequest; workId?: string | null; result?: unknown;
} = {}): HostRecordView {
  const action = 'vscode.openHandoff';
  if (!workId) return noStory(action, 'handoff packet');
  const guidance = `singularity-flow status --work-id ${workId}`;
  const answer = record(result);
  const source = 'A view of the Story\'s records, rebuilt now through SFlow\'s kernel (work.handoff). It is never lifecycle authority, no conversation was used, and nothing was changed.';
  const packet = record(answer.data?.packet);
  if (answer.kind !== 'read' || packet.kind !== 'handoff-packet') {
    const code = String(answer.why?.[0]?.code ?? answer.kind ?? 'no answer');
    return view(action, {
      state: 'unavailable', subtitle: workId,
      notice: { tone: 'info', text: `${workId} ${HANDOFF_REFUSALS[code] ?? `has no handoff packet here (${code})`}.` },
      guidance, source: 'No packet was produced, so nothing is shown from one. Nothing was changed.'
    });
  }
  const work = record(record(packet.approvedIntent).work);
  const phase = record(packet.currentPhase);
  const next = record(packet.legalNextAction);
  const revisions = record(packet.revisions);
  const local = record(packet.localChanges);
  const evidence = record(packet.evidence);
  const event = record(evidence.lastMaterialEvent);
  const kind = request.workKind ?? (work.kind === 'initiative' ? 'initiative' : 'story');
  return view(action, {
    subtitle: `${workId}${work.title ? ` · ${text(work.title)}` : ''}`,
    facts: [
      ['Work', `${workId} · ${text(work.kind, kind)}`],
      ['Phase', `${text(phase.label ?? phase.id, 'none')} · ${words(phase.status)} · generation ${text(phase.generation, '0')}`],
      ['Legal next action', next.operation ? `${text(next.operation)} (${words(next.reasonCode)})` : 'none is legal now'],
      ['Source commit', text(revisions.sourceCommit)],
      ['Lifecycle hash', text(revisions.lifecycleHash, 'not recorded')],
      ...(revisions.worktreeHash ? [['Worktree hash', `${text(revisions.worktreeHash)} (${text(revisions.worktreeAlgorithm)})`] as Fact] : []),
      ['Authority', 'projection only — never lifecycle authority']
    ],
    sections: [
      {
        heading: 'Approved intent',
        items: [record(packet.approvedIntent).approvedContentRead
          ? 'Read from the approved documents.'
          : 'Referenced, not read: the work record names the approved documents, and this packet does not open them.']
      },
      { heading: 'Completed', items: list(packet.completedWork).map((entry) => `${text(entry?.label ?? entry?.id)} · ${words(entry?.status ?? entry?.state)}`), empty: 'No phase is complete yet.' },
      { heading: 'Remaining', items: list(packet.remainingWork).map((entry) => `${text(entry?.label ?? entry?.id)} · ${words(entry?.state)}${entry?.status ? ` · ${words(entry.status)}` : ''}`), empty: 'Nothing remains.' },
      {
        heading: 'Local changes',
        items: [sectionState(local, local.dirty
          ? `${count(local.files)} uncommitted file(s), preserved and disclosed.` : 'The working tree was read and is clean.')]
      },
      { heading: 'Tests', items: [sectionState(packet.tests, 'Read.')] },
      {
        heading: 'Evidence',
        items: [evidence.state === 'recorded' && event.event
          ? `Last material event: ${words(event.event)}${event.phase ? ` in ${text(event.phase)}` : ''}${event.at ? ` at ${text(event.at)}` : ''}.`
          : 'No material event is recorded.',
        ...(evidence.recovery ? [`Recovery: ${words(record(evidence.recovery).status)}.`] : [])]
      },
      { heading: 'Open questions', items: [sectionState(packet.openQuestions, 'Read.')] },
      { heading: 'Risks', items: list(record(packet.risks).blockers).map((blocker) => `Blocked: ${words(blocker)}`), empty: 'No blocker is recorded.' },
      {
        heading: 'Reconstruction',
        items: [`From ${words(record(packet.reconstruction).source ?? 'governed-records')}; ${record(packet.reconstruction).conversationUsed ? 'a conversation was used' : 'no conversation was used'}. Anyone can rebuild this packet from the same commit and records.`]
      }
    ],
    routes: [REFRESH, ...(kind === 'story' ? [Object.freeze({
      id: 'progress', label: 'Open progress', command: 'singularityFlow.openProgress',
      args: Object.freeze([Object.freeze({ workId })]), shell: `singularity-flow progress ${workId}`
    })] : [])],
    guidance,
    source
  });
}

// ---------------------------------------------------------------------------------------------
// Progress

export function progressView({ request = {}, workId = null, progress = null }: {
  request?: HostRecordRequest; workId?: string | null; progress?: unknown;
} = {}): HostRecordView {
  const action = 'vscode.openProgress';
  const job = request.jobId
    ? `Job ${request.jobId} has no record here. This build keeps no job records: no SFlow operation returns a job ID yet, so there is no job progress to read${workId ? `; the Story's recorded progress is shown instead` : ''}.`
    : null;
  if (!workId) {
    if (!job) return noStory(action, 'progress');
    return view(action, { state: 'unavailable', subtitle: request.jobId ?? 'No job', notice: { tone: 'info', text: job }, guidance: 'singularity-flow status', source: 'Nothing was read. Nothing was changed.' });
  }
  const guidance = `singularity-flow progress ${workId}`;
  const snapshot = record(progress);
  if (snapshot.workId !== workId || !Array.isArray(snapshot.phases)) {
    return view(action, {
      state: 'unavailable', subtitle: workId,
      notice: { tone: 'info', text: `${job ? `${job} ` : ''}The progress read did not return ${workId}.` },
      guidance, source: 'Nothing was shown from a record. Nothing was changed.'
    });
  }
  const phases = list(snapshot.phases);
  const current = phases.find((entry) => entry?.id === snapshot.currentPhase) ?? null;
  const pending = snapshot.pendingDecision ? record(snapshot.pendingDecision) : null;
  return view(action, {
    subtitle: `${workId}${snapshot.workType ? ` · ${text(snapshot.workType)}` : ''}`,
    notice: job ? { tone: 'info', text: job } : null,
    facts: [
      ['Story', workId],
      ['Status', words(snapshot.status)],
      ['Current phase', current ? `${text(current.label ?? current.id)} (${count(snapshot.currentPosition)} of ${count(snapshot.totalPhases)})` : 'none'],
      ['Approved', `${count(snapshot.approvedPhases)} of ${count(snapshot.totalPhases)} phases${snapshot.skippedPhases ? `, ${count(snapshot.skippedPhases)} skipped` : ''} (${count(snapshot.percentage)}%)`],
      ['Documents', count(snapshot.documents)],
      ['Tokens', Number(record(snapshot.tokens).totalTokens) > 0 ? count(record(snapshot.tokens).totalTokens) : 'unavailable'],
      ...(pending ? [['Waiting for a decision', `${text(pending.label)}${pending.after ? ` after ${text(pending.after)}` : ''}`] as Fact] : [])
    ],
    sections: [{
      heading: 'Phases',
      note: 'Recorded progress, not evidence that a phase may run or be approved.',
      table: {
        columns: ['#', 'Phase', 'Status', 'Generation', 'Approvals', 'Tokens'],
        rows: phases.map((entry) => [
          `${count(entry?.index)}${entry?.id === snapshot.currentPhase ? ' (current)' : ''}`, text(entry?.label ?? entry?.id), words(entry?.status),
          text(entry?.generation, '0'), `${count(entry?.approvals)} of ${count(entry?.approvalsRequired)}`,
          Number(entry?.tokens) > 0 ? `${count(entry.tokens)} (${words(entry?.tokenStatus)})` : words(entry?.tokenStatus ?? 'none')
        ])
      },
      empty: 'This Story has no phases.'
    }],
    routes: [
      REFRESH,
      Object.freeze({ id: 'journey', label: 'Open the journey', command: 'singularityFlow.openJourney', args: Object.freeze([]), shell: `singularity-flow status --work-id ${workId}` }),
      Object.freeze({ id: 'handoff', label: 'Open the handoff packet', command: 'singularityFlow.openHandoff', args: Object.freeze([Object.freeze({ workId })]), shell: `singularity-flow status --work-id ${workId}` })
    ],
    guidance,
    source: `Read from ${workId}'s records (singularity-flow progress). Nothing was changed.`
  });
}

// ---------------------------------------------------------------------------------------------
// Rendering

function factsHtml(facts: readonly Fact[] | undefined): string {
  if (!facts?.length) return '';
  return `<dl class="hr-facts">${facts.map(([label, value]) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join('')}</dl>`;
}

function tableHtml(table: HostRecordTable | null | undefined): string {
  if (!table?.rows.length) return '';
  return `<div class="hr-table"><table><thead><tr>${table.columns.map((column) => `<th scope="col">${escape(column)}</th>`).join('')}</tr></thead>
    <tbody>${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function sectionHtml(section: HostRecordSection): string {
  const facts = factsHtml(section.facts);
  const table = tableHtml(section.table);
  const items = section.items?.length ? `<ul>${section.items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>` : '';
  const empty = !table && !items && section.empty && !section.table?.rows.length ? `<p class="muted">${escape(section.empty)}</p>` : '';
  return `<section class="hr-section"><h2>${escape(section.heading)}</h2>
    ${section.note ? `<p class="muted">${escape(section.note)}</p>` : ''}${facts}${table}${items}${empty}</section>`;
}

function choiceHtml(choice: HostRecordChoice | null): string {
  if (!choice) return '';
  return `<label class="field hr-choice"><span>${escape(choice.label)}</span>
    <select data-choice="${escape(choice.field)}">${choice.options.some((option) => option.selected) ? '' : '<option value="" selected>Choose…</option>'}
    ${choice.options.map((option) => `<option value="${escape(option.value)}"${option.selected ? ' selected' : ''}>${escape(option.label)}</option>`).join('')}
    </select></label>`;
}

function routesHtml(view: HostRecordView): string {
  if (view.state === 'loading') return '';
  const buttons = view.routes.map((route, index) =>
    `<button type="button" class="${index === 0 ? '' : 'secondary'}" data-route="${escape(route.id)}">${escape(route.label)}</button>`).join('');
  const elsewhere = view.routes.filter((route) => route.shell).map((route) =>
    `<details class="hr-elsewhere"><summary>${escape(route.label)} from Copilot or a terminal</summary>${commandGuidanceHtml(route.shell)}</details>`).join('');
  return `<section class="hr-section hr-routes"><h2>Continue</h2>${buttons ? `<div class="hr-actions">${buttons}</div>` : ''}
    ${view.guidance ? `<h3>Read the same record from Copilot or a terminal</h3>${commandGuidanceHtml(view.guidance)}` : ''}${elsewhere}</section>`;
}

/** One page for all four views. `renderId` rides on every message, so a stale page cannot act. */
export function hostRecordHtml(model: HostRecordView, renderId: string): string {
  return `<main class="host-record" data-render-id="${escape(renderId)}" data-record-state="${escape(model.state)}">
  <header><h1>${escape(model.title)}</h1><p class="muted">${escape(model.subtitle)}</p></header>
  ${model.state === 'loading' ? '<p class="muted" role="status">Reading the record…</p>' : ''}
  ${model.notice ? `<div class="notice${model.notice.tone === 'error' ? ' error' : ''}" role="status"><p>${escape(model.notice.text)}</p></div>` : ''}
  ${choiceHtml(model.choice)}
  ${factsHtml(model.facts)}
  ${model.sections.map(sectionHtml).join('')}
  ${routesHtml(model)}
  <p class="muted hr-source">${escape(model.source)}</p>
</main>`;
}

export const HOST_RECORD_STYLE = `.host-record header h1{margin-bottom:.2rem}
 .hr-facts{display:grid;grid-template-columns:minmax(120px,max-content) minmax(0,1fr);gap:.25rem 1rem;margin:.8rem 0}
 .hr-facts dt{color:var(--vscode-descriptionForeground)}.hr-facts dd{margin:0;overflow-wrap:anywhere}
 .hr-section{margin-top:1.4rem}.hr-section h2{font-size:1.05rem;margin-bottom:.3rem}
 .hr-table{overflow-x:auto}.hr-table td{vertical-align:top;overflow-wrap:anywhere}
 .hr-actions{display:flex;flex-wrap:wrap;gap:8px;margin:.6rem 0}.hr-choice{display:block;margin:.8rem 0}
 .hr-elsewhere{margin:.5rem 0}.hr-source{margin-top:1.6rem}
 @media(max-width:560px){.hr-facts{grid-template-columns:1fr}}`;

export const HOST_RECORD_SCRIPT = `
  const renderId = document.querySelector('[data-render-id]')?.dataset.renderId || '';
  document.addEventListener('click', (event) => {
    ${COMMAND_GUIDANCE_COPY_SCRIPT}
    const route = event.target.closest('[data-route]');
    if (route) window.__sfVscode.postMessage({ type: 'record.route', id: route.dataset.route, renderId });
  });
  document.addEventListener('change', (event) => {
    const choice = event.target.closest('select[data-choice]');
    if (choice && choice.value) window.__sfVscode.postMessage({ type: 'record.choose', field: choice.dataset.choice, value: choice.value, renderId });
  });
`;
