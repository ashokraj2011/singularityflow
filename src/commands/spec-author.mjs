/**
 * `singularity-flow spec author <action>`: the specification library (SPEC-SPA v1.3 S1, S4).
 *
 * Drafts live on this clone (src/spec-library/draft-store.mjs); reviewed and draft revisions are
 * published to the state branch (src/spec-library/library.mjs). Nothing here calls a model. Copilot
 * stages proposals and assisted findings (`propose`, src/spec-library/proposals.mjs). Accepting or
 * rejecting a proposal, deciding, deferring or reopening a gap, settling checklist articles and
 * findings, publishing and discarding are the person's own steps: the Copilot guard refuses them in
 * every turn (OWN_TERMINAL_STEPS).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { identity, refCommit, repoRoot } from '../git.mjs';
import { checkDraft } from '../spec-library/check.mjs';
import {
  decideGap, deferGap, foldChecklist, foldGaps, newDraft, openGap, reopenGap, settleArticles, specTemplate
} from '../spec-library/draft-model.mjs';
import { crashPoint, discardDraft, listDrafts, newOperationId, readDraft, requireOperationId, saveDraft } from '../spec-library/draft-store.mjs';
import { parseSpecReference, requireSpecId } from '../spec-library/ids.mjs';
import { libraryView, publishRevision, readManifest, REVIEW_STATES, resolveRevision } from '../spec-library/library.mjs';
import {
  acceptProposals, assistedReport, draftAssisted, rejectProposals, settleFindings, stageProposals, stagedProposals, validateProposals
} from '../spec-library/proposals.mjs';
import { addPersonFact, gapImpact, mergeResearch, normalizeArea, removeResearch } from '../spec-library/research.mjs';
import { optionBoolean, optionNumber, optionString, optionStrings, SingularityFlowError } from '../util.mjs';

export const SPEC_AUTHOR_ACTIONS = Object.freeze([
  'new', 'edit', 'research', 'gap', 'gaps', 'propose', 'accept', 'reject', 'decide', 'settle', 'check', 'status', 'publish', 'show', 'list', 'discard', 'coverage'
]);
/** `coverage --repair` writes; `coverage` alone reads. */
export const SPEC_AUTHOR_READ_ACTIONS = Object.freeze(['gaps', 'check', 'status', 'show', 'list', 'coverage']);
/** The person's own steps: refused for agents, whatever the turn. */
export const SPEC_AUTHOR_PERSON_ACTIONS = Object.freeze(['accept', 'reject', 'decide', 'settle', 'publish', 'discard']);

const USAGE = `Usage: singularity-flow spec author <${SPEC_AUTHOR_ACTIONS.join('|')}> …  (singularity-flow help spec)`;
const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };

function print(options, json, text) {
  if (optionBoolean(options, 'json')) console.log(JSON.stringify({ schemaVersion: 1, resultType: 'sflow-spec-author', ...json }, null, 2)); // schema-transient: command result
  else console.log(text);
}

function actor(root) {
  const found = identity(root, { offline: true });
  return { name: found.name ?? null, email: found.email ?? null };
}

async function libraryConfig(root) {
  const { existsSync } = await import('node:fs');
  if (!existsSync(path.join(root, 'singularity', 'workflow.yml'))) return {};
  const { loadConfig } = await import('../state-stores.mjs');
  return loadConfig(root);
}

/**
 * The one proposal file a live /sf-spec-author turn may write for this specification: on this
 * computer, outside every checkout, like an application draft. A paused Copilot is issued none.
 */
async function proposalPath(root, specId, { env = process.env } = {}) {
  const [{ createHash }, { realpathSync }, { workflowBuildStateRoot }] = await Promise.all([
    import('node:crypto'), import('node:fs'), import('../workflow-build/store.mjs')]);
  let resolved = path.resolve(root);
  try { resolved = realpathSync.native(resolved); } catch { /* the path as given */ }
  const repository = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  const file = path.join(workflowBuildStateRoot(env), 'spec-proposals', repository, `${specId}.proposal.json`);
  await import('../copilot-mutation-guard.mjs').then(({ issueSpecStudioStaging }) => issueSpecStudioStaging(file, { root })).catch(() => 0);
  return file;
}

function operation(options) {
  const supplied = optionString(options, 'operation-id');
  return supplied ? requireOperationId(supplied) : newOperationId();
}

function specArgument(positionals, action) {
  const value = positionals[3];
  if (!value) fail(`spec author ${action} needs a specification ID, for example SPEC-CHK-004.`, 'SPEC_ID_INVALID', { nextAction: 'singularity-flow spec author list' });
  return value;
}

async function requireDraft(root, specId) {
  const draft = await readDraft(root, specId);
  if (!draft?.head) fail(`${specId} has no draft on this clone.`, 'SPEC_DRAFT_MISSING', { specId, nextAction: `singularity-flow spec author new ${specId} --title "TITLE"` });
  return draft;
}

function headLine(specId, head) {
  return `${specId} draft at snapshot ${head.sequence}${head.draft.basedOn ? `, based on @${head.draft.basedOn.revision}` : ''}: ${head.draft.title}`;
}

function summarizeCheck(report) {
  const lines = [`D ${report.counts.d.passed}/${report.counts.d.total} rules passed · A ${report.counts.a.status === 'not-run' ? 'not run' : `${report.counts.a.pending} pending`} · H ${report.counts.h.open} open${report.counts.h.deferred ? `, ${report.counts.h.deferred} deferred` : ''}`];
  for (const finding of report.blocking) lines.push(`  ${finding.part} ${finding.code}: ${finding.message}`);
  lines.push(report.reviewReady ? 'Ready to publish as reviewed.' : 'Not ready to publish as reviewed; a draft revision can still be published with --draft.');
  return lines.join('\n');
}

async function knowledgeAtHead(root, { refresh = false } = {}) {
  const { buildKnowledge } = await import('../knowledge/store.mjs');
  const built = await buildKnowledge(root, { refresh, ref: 'HEAD' });
  if (built.status !== 'ok') fail(`The repository knowledge model could not be built (${built.reason ?? built.status}), so code research is unavailable.`, 'SPEC_RESEARCH_UNAVAILABLE', { nextAction: 'singularity-flow wm knowledge status' });
  return built;
}

async function newAction(root, positionals, options) {
  const specId = requireSpecId(specArgument(positionals, 'new'));
  const operationId = operation(options);
  const revise = optionBoolean(options, 'revise');
  const from = optionString(options, 'from');
  const areas = optionStrings(options, 'area').map(normalizeArea);
  const config = await libraryConfig(root);
  let base = null;
  try {
    const view = await libraryView(root, config);
    if (revise) base = resolveRevision(root, view, specId, null, { anyState: true });
    else if (view.specs.has(specId)) {
      fail(`${specId} is already in the specification library (@${view.specs.get(specId).at(-1)}). Start a draft of its next revision with --revise.`,
        'SPEC_LIBRARY_ID_TAKEN', { specId, nextAction: `singularity-flow spec author new ${specId} --revise` });
    }
  } catch (error) {
    // Offline, a new draft can still start: publication refuses a revision someone else took meanwhile.
    if (error?.code !== 'SPEC_LIBRARY_UNAVAILABLE' || revise) throw error;
  }
  const title = optionString(options, 'title') ?? base?.manifest.title;
  if (!title?.trim()) fail(`spec author new ${specId} needs --title TEXT.`, 'SPEC_TITLE_MISSING', { specId });
  const spec = base ? base.spec : from ? await readFile(path.resolve(from), 'utf8') : specTemplate(specId, title.trim());
  const saved = await saveDraft(root, specId, {
    operationId, operation: 'new', create: true, actor: actor(root),
    payload: { title, from: from ? 'file' : base ? `revision ${base.revision}` : 'template', spec, areas },
    change: () => {
      const draft = newDraft({ title, spec, areas });
      if (base) {
        Object.assign(draft, { basedOn: { revision: base.revision, manifestSha256: base.manifestSha256, reviewState: base.manifest.reviewState },
          gaps: base.gaps.events, research: base.research.items, checklist: [] });
      }
      return draft;
    }
  });
  return print(options, { action: 'new', specId, sequence: saved.snapshot.sequence, replayed: saved.replayed, operationId },
    `${saved.replayed ? 'Already saved: ' : 'Started '}${headLine(specId, saved.snapshot)}.\nNext: edit the prose, then singularity-flow spec author check ${specId}`);
}

async function editAction(root, positionals, options) {
  const specId = requireSpecId(specArgument(positionals, 'edit'));
  const file = optionString(options, 'file');
  const expected = optionNumber(options, 'expected-seq');
  if (!file || expected === undefined) fail(`spec author edit ${specId} needs --file FILE and --expected-seq N (the snapshot you edited from).`, 'SPEC_EDIT_INCOMPLETE', { specId, nextAction: `singularity-flow spec author status ${specId}` });
  const spec = await readFile(path.resolve(file), 'utf8');
  const saved = await saveDraft(root, specId, {
    operationId: operation(options), operation: 'edit', expectedSequence: expected, actor: actor(root), payload: { spec },
    change: (draft) => ({ ...draft, spec })
  });
  return print(options, { action: 'edit', specId, sequence: saved.snapshot.sequence, replayed: saved.replayed },
    `${saved.replayed ? 'Already saved: ' : 'Saved '}${headLine(specId, saved.snapshot)}.`);
}

async function researchAction(root, positionals, options) {
  const specId = requireSpecId(specArgument(positionals, 'research'));
  const who = actor(root);
  const at = new Date().toISOString();
  const remove = optionStrings(options, 'remove');
  const note = optionString(options, 'fact');
  const paths = optionStrings(options, 'path').map(normalizeArea);
  const symbols = optionStrings(options, 'symbol');
  let counts = { added: 0, refreshed: 0, removed: remove.length, noted: null };
  let built = null;
  if (!remove.length && !note) {
    const current = await requireDraft(root, specId);
    if (!paths.length && !symbols.length && !current.head.draft.areas.length && !current.head.draft.research.length) {
      fail(`Name what to research: --path PATH or --symbol NAME (or give the draft an --area when it is started).`, 'SPEC_RESEARCH_SCOPE_MISSING',
        { specId, nextAction: `singularity-flow spec author research ${specId} --path src` });
    }
    built = await knowledgeAtHead(root, { refresh: optionBoolean(options, 'refresh') });
  }
  const saved = await saveDraft(root, specId, {
    operationId: operation(options), operation: 'research', actor: who,
    payload: { remove, note, source: optionString(options, 'source') ?? null, paths, symbols, commit: built?.commit ?? null },
    change: (draft) => {
      if (remove.length) return removeResearch(draft, remove);
      if (note) { counts.noted = addPersonFact(draft, { note, source: optionString(options, 'source') }, { actor: who, at }); return draft; }
      counts = { ...counts, ...mergeResearch(draft, built.knowledge, built.commit, { areas: [...draft.areas, ...paths], symbols }, { actor: who, at }) };
      return draft;
    }
  });
  const items = saved.snapshot.draft.research;
  return print(options, { action: 'research', specId, sequence: saved.snapshot.sequence, replayed: saved.replayed, ...counts, items },
    [`${specId} research: ${items.length} item(s)${counts.added ? `, ${counts.added} added` : ''}${counts.refreshed ? `, ${counts.refreshed} refreshed` : ''}${counts.removed ? `, ${counts.removed} removed` : ''}${counts.noted ? `, ${counts.noted} noted` : ''}.`,
      ...items.map((item) => `  ${item.id} [${item.basis}] ${item.summary}${item.citation ? ` (${item.citation.path}:${item.citation.lines[0]})` : item.source ? ` (${item.source})` : ''}`)].join('\n'));
}

async function gapAction(root, positionals, options) {
  const specId = requireSpecId(specArgument(positionals, 'gap'));
  const who = actor(root);
  const optionsFile = optionString(options, 'options');
  let choices = [];
  if (optionsFile) {
    try { choices = JSON.parse(await readFile(path.resolve(optionsFile), 'utf8')); }
    catch (error) { fail(`--options ${optionsFile} is not a JSON list of { wording, changesCode } options: ${error.message}`, 'SPEC_GAP_OPTIONS_INVALID', { file: optionsFile }); }
  }
  const evidence = optionStrings(options, 'research').flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  const clauses = optionStrings(options, 'clause').flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  const request = { kind: optionString(options, 'kind'), question: optionString(options, 'question'), evidence, clauses, options: choices };
  let gap = null;
  const saved = await saveDraft(root, specId, {
    operationId: operation(options), operation: 'gap', actor: who, payload: request,
    change: (draft) => { ({ gap } = openGap(draft, request, { actor: who, at: new Date().toISOString() })); return draft; }
  });
  gap ??= saved.snapshot.draft.gaps.filter((event) => event.event === 'opened').at(-1)?.gap;
  return print(options, { action: 'gap', specId, gap, sequence: saved.snapshot.sequence, replayed: saved.replayed },
    `Opened ${gap} on ${specId}. Show its options and their impact: singularity-flow spec author gaps ${specId} ${gap}`);
}

async function gapsAction(root, positionals, options) {
  const specId = requireSpecId(specArgument(positionals, 'gaps'));
  const wanted = positionals[4] ?? null;
  const { head } = await requireDraft(root, specId);
  const gaps = foldGaps(head.draft.gaps).filter((gap) => !wanted || gap.id === wanted);
  if (wanted && !gaps.length) fail(`${wanted} is not a gap of ${specId}.`, 'SPEC_GAP_UNKNOWN', { gap: wanted, nextAction: `singularity-flow spec author gaps ${specId}` });
  const needsImpact = gaps.some((gap) => gap.evidence.some((id) => head.draft.research.some((item) => item.id === id && item.basis === 'code')));
  const knowledge = needsImpact ? (await knowledgeAtHead(root)).knowledge : null;
  const shown = [];
  for (const gap of gaps) shown.push({ ...gap, impact: knowledge ? await gapImpact(knowledge, head.draft, gap) : { evidence: [], records: [], options: [] } });
  const lines = [];
  for (const gap of shown) {
    lines.push(`${gap.id} [${gap.kind}] ${gap.status}: ${gap.question}`);
    for (const option of gap.options) {
      const impact = gap.impact.options.find((entry) => entry.id === option.id);
      lines.push(`  ${option.id} ${option.wording}`);
      lines.push(`     impact: ${option.changesCode ? (impact?.records.length ? impact.records.map((record) => record.text).join('; ') : 'no cited code') : 'none (keeps the code as it is)'}`);
    }
    if (gap.decision) lines.push(`  decided: ${gap.decision.choice} (${gap.decision.by?.name ?? 'someone'}: ${gap.decision.reason})`);
    if (gap.deferral) lines.push(`  deferred to ${gap.deferral.owner}: ${gap.deferral.reason}`);
  }
  return print(options, { action: 'gaps', specId, sequence: head.sequence, gaps: shown }, lines.join('\n') || `${specId} has no gaps.`);
}

async function decideAction(root, positionals, options) {
  const specId = requireSpecId(specArgument(positionals, 'decide'));
  const gapId = positionals[4];
  const who = actor(root);
  const request = { gap: gapId ?? null, option: optionString(options, 'option') ?? null, choice: optionString(options, 'choice') ?? null,
    defer: optionBoolean(options, 'defer'), reopen: optionBoolean(options, 'reopen'), owner: optionString(options, 'owner') ?? null,
    reason: optionString(options, 'reason') ?? null };
  const saved = await saveDraft(root, specId, {
    operationId: operation(options), operation: 'decide', actor: who, payload: request,
    change: (draft) => {
      const context = { actor: who, at: new Date().toISOString() };
      if (request.reopen) return reopenGap(draft, gapId, request, context);
      if (request.defer) return deferGap(draft, gapId, request, context);
      return decideGap(draft, gapId, request, context);
    }
  });
  const gap = foldGaps(saved.snapshot.draft.gaps).find((entry) => entry.id === gapId);
  return print(options, { action: 'decide', specId, gap: gapId, status: gap?.status ?? null, sequence: saved.snapshot.sequence, replayed: saved.replayed },
    `${gapId} is ${gap?.status}. State its outcome under "Decisions and open questions" in the specification before publishing.`);
}

function articleDecisions(options) {
  const decisions = {};
  const all = optionString(options, 'all-articles');
  if (all) for (const { article } of foldChecklist([])) decisions[article] = all;
  for (const entry of optionStrings(options, 'article').flatMap((value) => value.split(','))) {
    const [article, decision] = entry.split('=').map((value) => value?.trim());
    if (!article || !decision) fail(`--article ${entry} must be ARTICLE=DECISION, for example completeness=satisfied.`, 'SPEC_ARTICLE_DECISION_INVALID', { entry });
    decisions[article] = decision;
  }
  return decisions;
}

/** `--finding A-001=gap|fixed|dismissed`: how each assisted finding is settled. */
function findingOutcomes(options) {
  const outcomes = {};
  for (const entry of optionStrings(options, 'finding').flatMap((value) => value.split(','))) {
    const [finding, outcome] = entry.split('=').map((value) => value?.trim());
    if (!finding || !outcome) fail(`--finding ${entry} must be FINDING=OUTCOME, for example A-001=dismissed.`, 'SPEC_FINDING_OUTCOME_INVALID', { entry });
    outcomes[finding] = outcome;
  }
  return outcomes;
}

async function settleAction(root, positionals, options) {
  const specId = requireSpecId(specArgument(positionals, 'settle'));
  const who = actor(root);
  const decisions = articleDecisions(options);
  const outcomes = findingOutcomes(options);
  const reason = optionString(options, 'reason') ?? null;
  let opened = {};
  const saved = await saveDraft(root, specId, {
    operationId: operation(options), operation: 'settle', actor: who, payload: { decisions, outcomes, reason },
    change: (draft) => {
      const context = { actor: who, at: new Date().toISOString() };
      if (Object.keys(outcomes).length) ({ opened } = settleFindings(draft, outcomes, { reason }, context));
      return Object.keys(decisions).length || !Object.keys(outcomes).length ? settleArticles(draft, decisions, { reason }, context) : draft;
    }
  });
  const articles = foldChecklist(saved.snapshot.draft.checklist);
  const findings = draftAssisted(saved.snapshot.draft).findings.filter((finding) => finding.id in outcomes);
  return print(options, { action: 'settle', specId, sequence: saved.snapshot.sequence, replayed: saved.replayed,
    articles: articles.map(({ article, decision }) => ({ article, decision: decision?.decision ?? null })),
    findings: findings.map(({ id, status, gap }) => ({ id, status, gap: gap ?? null })), opened },
  [...articles.map(({ article, decision }) => `  ${article}: ${decision?.decision ?? 'no decision'}`),
    ...findings.map((finding) => `  ${finding.id}: ${finding.status}${finding.gap ? `, opened as ${finding.gap}` : ''}`)].join('\n'));
}

async function reportFor(root, specId, draft) {
  return checkDraft(root, specId, draft.head.draft, { ref: 'HEAD', commit: refCommit(root, 'HEAD'), sequence: draft.head.sequence, assisted: assistedReport(draft.head.draft) });
}

const idList = (values) => values.flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean);

async function proposeAction(root, positionals, options) {
  const specId = requireSpecId(specArgument(positionals, 'propose'));
  const file = optionString(options, 'file');
  if (!file) fail(`spec author propose ${specId} needs --file FILE: { "proposals": [ … ] } (singularity-flow help spec).`, 'SPEC_PROPOSAL_INVALID', { specId, nextAction: `singularity-flow spec author status ${specId} --json` });
  const contents = await readFile(path.resolve(file), 'utf8');
  let payload;
  try { payload = JSON.parse(contents); } catch (error) { fail(`${file} is not JSON: ${error.message}`, 'SPEC_PROPOSAL_INVALID', { specId, file }); }
  const { head } = await requireDraft(root, specId);
  const commit = refCommit(root, 'HEAD');
  const who = actor(root);
  let staged = [];
  let notes = [];
  // The same file proposed again is the same operation: it returns the snapshot it staged before.
  const operationId = optionString(options, 'operation-id') ? requireOperationId(optionString(options, 'operation-id'))
    : `spp-${(await import('node:crypto')).createHash('sha256').update(contents).digest('hex').slice(0, 16)}`;
  const saved = await saveDraft(root, specId, {
    operationId, operation: 'propose', actor: who, payload, expectedSequence: head.sequence,
    change: (draft) => {
      const checked = validateProposals(root, draft, payload, { ref: 'HEAD', commit });
      if (checked.findings.length) {
        fail(`Nothing was staged; the proposals need fixing: ${checked.findings.map((finding) => `${finding.field}: ${finding.message}`).join('; ')}.`,
          'SPEC_PROPOSAL_INVALID', { specId, findings: checked.findings, nextAction: `singularity-flow spec author status ${specId} --json` });
      }
      notes = checked.entries.flatMap((entry) => entry.notes);
      ({ staged } = stageProposals(draft, checked, { actor: who, at: new Date().toISOString(), sequence: head.sequence }));
      return draft;
    }
  });
  const accept = staged.filter((id) => id.startsWith('P-'));
  return print(options, { action: 'propose', specId, staged, notes, replayed: saved.replayed, sequence: saved.snapshot.sequence },
    saved.replayed ? `Already proposed: this file was staged in snapshot ${saved.snapshot.sequence}.`
      : [`Staged ${staged.join(', ')} on ${specId}. Nothing is in the draft until a person accepts it.`, ...notes.map((note) => `  ${note}`),
        accept.length ? `The person accepts in the Spec Studio, or: singularity-flow spec author accept ${specId} ${accept.join(' ')}` : null].filter(Boolean).join('\n'));
}

async function acceptAction(root, positionals, options) {
  const specId = requireSpecId(specArgument(positionals, 'accept'));
  const ids = idList(positionals.slice(4));
  const editFile = optionString(options, 'edit');
  const edited = editFile ? await readFile(path.resolve(editFile), 'utf8') : null;
  const who = actor(root);
  const commit = refCommit(root, 'HEAD');
  let results = {};
  const saved = await saveDraft(root, specId, {
    operationId: operation(options), operation: 'accept', actor: who, payload: { ids, edited },
    change: (draft) => { ({ results } = acceptProposals(root, draft, ids, { edited }, { actor: who, at: new Date().toISOString(), ref: 'HEAD', commit })); return draft; }
  });
  return print(options, { action: 'accept', specId, accepted: ids, results, sequence: saved.snapshot.sequence, replayed: saved.replayed },
    `${saved.replayed ? 'Already accepted' : 'Accepted'} ${ids.map((id) => (results[id] ? `${id} (${results[id]})` : id)).join(', ')} into ${headLine(specId, saved.snapshot)}.`);
}

async function rejectAction(root, positionals, options) {
  const specId = requireSpecId(specArgument(positionals, 'reject'));
  const ids = idList(positionals.slice(4));
  const who = actor(root);
  const reason = optionString(options, 'reason') ?? null;
  const saved = await saveDraft(root, specId, {
    operationId: operation(options), operation: 'reject', actor: who, payload: { ids, reason },
    change: (draft) => rejectProposals(draft, ids, { reason }, { actor: who, at: new Date().toISOString() })
  });
  return print(options, { action: 'reject', specId, rejected: ids, sequence: saved.snapshot.sequence, replayed: saved.replayed },
    `${saved.replayed ? 'Already rejected' : 'Rejected'} ${ids.join(', ')}; the draft is unchanged.`);
}


async function checkAction(root, positionals, options) {
  const specId = requireSpecId(specArgument(positionals, 'check'));
  const draft = await requireDraft(root, specId);
  const report = await reportFor(root, specId, draft);
  return print(options, { action: 'check', specId, sequence: draft.head.sequence, report }, `${headLine(specId, draft.head)}\n${summarizeCheck(report)}`);
}

async function statusAction(root, positionals, options) {
  const specId = requireSpecId(specArgument(positionals, 'status'));
  const draft = await requireDraft(root, specId);
  const report = await reportFor(root, specId, draft);
  const gaps = foldGaps(draft.head.draft.gaps);
  const next = report.reviewReady ? `singularity-flow spec author publish ${specId} --reviewed`
    : report.human.gaps.open.length ? `singularity-flow spec author gaps ${specId} ${report.human.gaps.open[0]}`
      : `singularity-flow spec author check ${specId}`;
  const standing = new Map(report.research.map((entry) => [entry.id, entry]));
  const { spec, areas, research } = draft.head.draft;
  return print(options, {
    action: 'status', specId, sequence: draft.head.sequence, title: draft.head.draft.title, basedOn: draft.head.draft.basedOn,
    gaps: gaps.map(({ id, kind, status, question, evidence, clauses, options: choices, decision, deferral }) => ({ id, kind, status, question, evidence, clauses,
      options: choices, decision: decision && { option: decision.option, choice: decision.choice, reason: decision.reason, by: decision.by, at: decision.at },
      deferral: deferral && { owner: deferral.owner, reason: deferral.reason, by: deferral.by, at: deferral.at } })),
    research: research.length, damagedSnapshots: draft.damaged, counts: report.counts,
    blocking: report.blocking, reviewReady: report.reviewReady, next,
    // The Spec Studio's one read (SPEC-SPA v1.3 §3): the prose, each cited fact with its standing, the rules and the checklist.
    spec, areas, researchItems: research.map((item) => ({ ...item, standing: standing.get(item.id)?.status ?? null, staleReason: standing.get(item.id)?.reason ?? null })),
    rules: report.deterministic.rules, articles: report.human.articles, clauseIds: report.analyzer?.clauseIds ?? [],
    // What Copilot staged (S4): open proposals and every assisted finding, and the one file a
    // /sf-spec-author turn writes its next proposals to.
    proposals: stagedProposals(draft.head.draft), findings: draftAssisted(draft.head.draft).findings,
    proposalPath: optionBoolean(options, 'json') ? await proposalPath(root, specId) : null
  }, `${headLine(specId, draft.head)}\n${summarizeCheck(report)}${stagedProposals(draft.head.draft).length ? `\nProposals waiting for you: ${stagedProposals(draft.head.draft).map((entry) => `${entry.id} (${entry.kind})`).join(', ')}` : ''}\nNext: ${next}`);
}

async function publishAction(root, positionals, options) {
  const specId = requireSpecId(specArgument(positionals, 'publish'));
  const states = REVIEW_STATES.filter((state) => optionBoolean(options, state));
  if (states.length !== 1) fail(`spec author publish ${specId} needs exactly one of --reviewed or --draft.`, 'SPEC_PUBLISH_STATE_MISSING', { specId, nextAction: `singularity-flow spec author status ${specId}` });
  const [reviewState] = states;
  const draft = await requireDraft(root, specId);
  const basedOn = draft.head.draft.basedOn;
  // Nothing changed since this draft's last publication in the same state: that revision is the answer.
  if (draft.head.operation === 'published' && basedOn?.reviewState === reviewState) {
    return print(options, { action: 'publish', specId, revision: basedOn.revision, reviewState, replayed: true, manifestSha256: basedOn.manifestSha256, unchanged: true },
      `Nothing changed since ${specId}@${basedOn.revision} (${reviewState}); no new revision was published.`);
  }
  const report = await reportFor(root, specId, draft);
  if (reviewState === 'reviewed' && !report.reviewReady) {
    fail(`${specId} cannot be published as reviewed: ${report.blocking.map((finding) => `${finding.part} ${finding.message}`).join('; ')}. Nothing was published; --draft publishes it as a draft revision.`,
      'SPEC_LIBRARY_REVIEW_INCOMPLETE', { specId, blocking: report.blocking, nextAction: `singularity-flow spec author status ${specId}` });
  }
  // The same draft head published in the same state is the same operation, so a retry after a lost
  // acknowledgement returns the revision it already published.
  const operationId = optionString(options, 'operation-id')
    ? requireOperationId(optionString(options, 'operation-id'))
    : `spp-${draft.head.snapshotSha256.slice('sha256:'.length, 'sha256:'.length + 16)}-${reviewState}`;
  const command = `singularity-flow spec author publish ${specId} --${reviewState} --operation-id ${operationId}`;
  const who = actor(root);
  const published = await publishRevision(root, await libraryConfig(root), { specId, draft, report, reviewState, operationId, actor: who, command });
  crashPoint('spec-library-published');
  // The draft continues from what it just published; a lost save here is healed at the next publish.
  await saveDraft(root, specId, {
    operationId: `${operationId}-recorded`, operation: 'published', actor: who,
    payload: { revision: published.revision, manifestSha256: published.manifestSha256, reviewState },
    change: (current) => ({ ...current, basedOn: { revision: published.revision, manifestSha256: published.manifestSha256, reviewState } })
  });
  return print(options, { action: 'publish', specId, revision: published.revision, reviewState, replayed: published.replayed,
    manifestSha256: published.manifestSha256, commit: published.commit, operationId },
  `${published.replayed ? 'Already published' : 'Published'} ${specId}@${published.revision} (${reviewState}) to the state branch${published.commit ? ` at ${published.commit.slice(0, 12)}` : ''}.`);
}

async function showAction(root, positionals, options) {
  const { specId, revision } = parseSpecReference(specArgument(positionals, 'show'));
  const view = await libraryView(root, await libraryConfig(root));
  const read = resolveRevision(root, view, specId, revision, { anyState: revision !== null || optionBoolean(options, 'any') });
  if (optionBoolean(options, 'json')) {
    return print(options, { action: 'show', specId, revision: read.revision, commit: read.commit, manifest: read.manifest,
      manifestSha256: read.manifestSha256, spec: read.spec, gaps: read.gaps.events, research: read.research.items, quality: read.quality }, '');
  }
  const header = `${specId}@${read.revision} (${read.manifest.reviewState}) ${read.manifest.title} — published ${read.manifest.recordedAt} by ${read.manifest.publishedBy?.name ?? 'unknown'}; state ${read.commit.slice(0, 12)}`;
  return console.log(`${header}\n\n${read.spec}`);
}

async function listAction(root, options) {
  const view = await libraryView(root, await libraryConfig(root));
  const specs = [];
  for (const [specId, revisions] of [...view.specs.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const latest = readManifest(root, view, specId, revisions.at(-1));
    specs.push({ specId, revisions, latest: { revision: latest.revision, reviewState: latest.manifest.reviewState, title: latest.manifest.title } });
  }
  const drafts = (await listDrafts(root)).map((draft) => ({ specId: draft.specId, sequence: draft.sequence, title: draft.head?.draft.title ?? null, basedOn: draft.head?.draft.basedOn ?? null }));
  return print(options, { action: 'list', state: { status: view.status, commit: view.commit }, specs, drafts }, [
    view.status === 'absent' ? 'The specification library is empty: nothing has been published to the state branch yet.' : `Specification library at ${view.commit.slice(0, 12)}:`,
    ...specs.map((entry) => `  ${entry.specId}@${entry.latest.revision} (${entry.latest.reviewState}) ${entry.latest.title}`),
    ...(drafts.length ? ['Drafts on this clone:', ...drafts.map((entry) => `  ${entry.specId} snapshot ${entry.sequence}${entry.basedOn ? ` (based on @${entry.basedOn.revision})` : ''} ${entry.title ?? ''}`)] : [])
  ].join('\n'));
}

async function discardAction(root, positionals, options) {
  const specId = requireSpecId(specArgument(positionals, 'discard'));
  const discarded = await discardDraft(root, specId);
  return print(options, { action: 'discard', specId, snapshots: discarded.snapshots },
    `Discarded ${specId}'s draft on this clone (${discarded.snapshots} snapshot(s)). Published revisions are unchanged.`);
}

/**
 * Per clause of one revision: delivered, claimed or uncovered, from one pinned state commit (§6.4).
 * `--repair --story WORK-ID` first writes the usage records that Story's committed approval and
 * closure prove and the state branch is missing.
 */
async function coverageAction(root, positionals, options) {
  const { specId, revision } = parseSpecReference(specArgument(positionals, 'coverage'));
  if (revision === null) fail(`spec author coverage needs the revision: ${specId}@N.`, 'SPEC_REFERENCE_INVALID', { specId, nextAction: `singularity-flow spec author show ${specId}` });
  const config = await libraryConfig(root);
  const usage = await import('../spec-library/usage.mjs');
  let repaired = null;
  if (optionBoolean(options, 'repair')) {
    const workId = optionString(options, 'story');
    if (!workId) fail(`Repair names the Story whose records to write: --story WORK-ID.`, 'SPEC_USAGE_STORY_MISSING', { specId, nextAction: `singularity-flow spec author coverage ${specId}@${revision}` });
    const { committedFileText } = await import('../git.mjs');
    const directory = `${config.workItemRoot ?? 'singularity/work-items'}/${workId}`;
    const read = (name) => committedFileText(root, 'HEAD', `${directory}/${name}`);
    const [workflowText, sourceText] = [read('workflow.json'), read('source.json')];
    if (!workflowText || !sourceText) fail(`${workId}'s committed record is not on this checkout (${directory}); run the repair from a checkout of its branch.`, 'SPEC_USAGE_STORY_MISSING', { workId, nextAction: `singularity-flow session open ${workId}` });
    const source = JSON.parse(sourceText);
    const records = usage.usageRecords(JSON.parse(workflowText), source).filter((entry) => entry.record.specId === specId);
    if (!(source.specification ?? []).some((slice) => String(slice.revision).startsWith(`${specId}@`))) {
      fail(`${workId} has no slice of ${specId} attached.`, 'SPEC_USAGE_STORY_MISSING', { workId, specId, nextAction: `singularity-flow spec author coverage ${specId}@${revision}` });
    }
    const result = await usage.publishUsage(root, config, records);
    repaired = { workId, records: records.length, written: result.written, present: result.present, differing: result.differing };
  }
  const view = await libraryView(root, config);
  const read = resolveRevision(root, view, specId, revision, { anyState: true });
  const { records, unreadable } = usage.readUsage(root, view, specId, revision);
  const clauses = usage.coverageOf({ ...read, specId }, records);
  const counts = Object.fromEntries(['delivered', 'claimed', 'uncovered'].map((status) => [status, clauses.filter((entry) => entry.status === status).length]));
  const lines = [`${specId}@${revision} at state ${String(view.commit).slice(0, 8)}: ${clauses.length} clause(s): ${counts.delivered} delivered, ${counts.claimed} claimed, ${counts.uncovered} uncovered.`];
  if (repaired) lines.unshift(`Repair for ${repaired.workId}: ${repaired.written.length} record(s) written, ${repaired.present.length} already there${repaired.differing.length ? `, ${repaired.differing.length} different and left as they are` : ''}.`);
  for (const entry of clauses) {
    lines.push(`  [${entry.clause}] ${entry.status}${entry.deliveredBy.length ? ` by ${entry.deliveredBy.join(', ')}` : ''}${entry.claimedBy.length ? `${entry.deliveredBy.length ? '; ' : ' '}claimed by ${entry.claimedBy.join(', ')}` : ''}`);
  }
  if (unreadable.length) lines.push(`Unreadable usage records, not counted: ${unreadable.join(', ')}`);
  return print(options, { action: 'coverage', specId, revision, stateCommit: view.commit, clauses, counts, unreadable, ...(repaired ? { repaired } : {}) }, lines.join('\n'));
}

export async function specAuthorCommand(positionals, options) {
  const action = positionals[2];
  if (!SPEC_AUTHOR_ACTIONS.includes(action)) fail(`${action ? `'${action}' is not a spec author action. ` : ''}${USAGE}`, 'SPEC_AUTHOR_ACTION_UNKNOWN', { action: action ?? null, nextAction: 'singularity-flow help spec' });
  const root = repoRoot();
  if (action === 'new') return newAction(root, positionals, options);
  if (action === 'edit') return editAction(root, positionals, options);
  if (action === 'research') return researchAction(root, positionals, options);
  if (action === 'gap') return gapAction(root, positionals, options);
  if (action === 'gaps') return gapsAction(root, positionals, options);
  if (action === 'propose') return proposeAction(root, positionals, options);
  if (action === 'accept') return acceptAction(root, positionals, options);
  if (action === 'reject') return rejectAction(root, positionals, options);
  if (action === 'decide') return decideAction(root, positionals, options);
  if (action === 'settle') return settleAction(root, positionals, options);
  if (action === 'check') return checkAction(root, positionals, options);
  if (action === 'status') return statusAction(root, positionals, options);
  if (action === 'publish') return publishAction(root, positionals, options);
  if (action === 'show') return showAction(root, positionals, options);
  if (action === 'list') return listAction(root, options);
  if (action === 'coverage') return coverageAction(root, positionals, options);
  return discardAction(root, positionals, options);
}
