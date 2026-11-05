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
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { identity, refCommit, repoRoot } from '../git.mjs';
import { extractClauses } from '../specifications.mjs';
import { checkDraft } from '../spec-library/check.mjs';
import {
  decideGap, deferGap, foldChecklist, foldGaps, newDraft, openGap, publicationContinuation, reopenGap, settleArticles, specTemplate
} from '../spec-library/draft-model.mjs';
import { crashPoint, discardDraft, listDrafts, newOperationId, readDraft, requireOperationId, saveDraft } from '../spec-library/draft-store.mjs';
import { generatedSpecId, parseSpecReference, requireSpecId } from '../spec-library/ids.mjs';
import { libraryView, publishRevision, readManifest, REVIEW_STATES, resolveRevision } from '../spec-library/library.mjs';
import {
  acceptProposals, assistedReport, draftAssisted, rejectProposals, settleFindings, stageProposals, stagedProposals, validateProposals
} from '../spec-library/proposals.mjs';
import { addPersonFact, gapImpact, mergeResearch, normalizeArea, removeResearch } from '../spec-library/research.mjs';
import { optionBoolean, optionNumber, optionString, optionStrings, samePlatformPath, SingularityFlowError } from '../util.mjs';

export const SPEC_AUTHOR_ACTIONS = Object.freeze([
  'new', 'edit', 'research', 'gap', 'gaps', 'propose', 'accept', 'reject', 'decide', 'settle', 'check', 'status', 'publish', 'show', 'list', 'discard', 'coverage', 'sync', 'shared', 'resume', 'history', 'source', 'sources', 'derive', 'fork', 'restore-version'
]);
/** `coverage --repair` writes; `coverage` alone reads. */
export const SPEC_AUTHOR_READ_ACTIONS = Object.freeze(['gaps', 'check', 'status', 'show', 'list', 'coverage', 'shared', 'history', 'sources']);
/** The person's own steps: refused for agents, whatever the turn. */
export const SPEC_AUTHOR_PERSON_ACTIONS = Object.freeze(['accept', 'reject', 'decide', 'settle', 'publish', 'discard']);

/** How a person confirms a draft's kind, which making a new revision ready requires (SPEC-SPA section 2.3). */
const setKindCommand = (specId, sequence) => `singularity-flow spec author edit ${specId} --kind <business|technical> --expected-seq ${sequence}`;
const kindUnconfirmed = (report) => report.blocking.some((finding) => finding.code === 'spec.kind-unconfirmed');

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

/** Where this specification's proposal file goes: on this computer, outside every checkout, like an application draft. */
async function proposalFile(root, specId, { env = process.env } = {}) {
  const [{ createHash }, { realpathSync }, { workflowBuildStateRoot }] = await Promise.all([
    import('node:crypto'), import('node:fs'), import('../workflow-build/store.mjs')]);
  let resolved = path.resolve(root);
  try { resolved = realpathSync.native(resolved); } catch { /* the path as given */ }
  const repository = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  return path.join(workflowBuildStateRoot(env), 'spec-proposals', repository, `${specId}.proposal.json`);
}

/**
 * The one proposal file a live /sf-spec-author turn may write for this specification, with its
 * folder made: a host's create tool makes no parent folder, and the turn may not run mkdir. A paused
 * Copilot is issued none. `propose` removes the file once it has staged it.
 */
async function proposalPath(root, specId, { env = process.env } = {}) {
  const file = await proposalFile(root, specId, { env });
  await import('../workflow-build/store.mjs').then(({ preparePrivateStateFile }) => preparePrivateStateFile(file, { env })).catch(() => null);
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

async function requireDraft(root, specId, options) {
  const draft = await readDraft(root, specId, options);
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
  const operationId = operation(options);
  const revise = optionBoolean(options, 'revise');
  if (revise && !positionals[3]) fail('Revising a specification needs its existing ID. Use spec author list to find it.', 'SPEC_ID_INVALID', { nextAction: 'singularity-flow spec author list' });
  const specId = positionals[3] ? requireSpecId(positionals[3]) : generatedSpecId(operationId);
  const from = optionString(options, 'from');
  const intent = optionString(options, 'intent');
  if (intent !== undefined && (from || revise)) fail('--intent starts a new template; it cannot be combined with --from or --revise.', 'SPEC_NEW_INPUT_CONFLICT');
  const areas = optionStrings(options, 'area').map(normalizeArea);
  const config = await libraryConfig(root);
  let base = null;
  try {
    const view = revise || positionals[3] ? await libraryView(root, config, { refresh: !optionBoolean(options, 'local') }) : { specs: new Map() };
    if (revise) base = resolveRevision(root, view, specId, null, { anyState: true });
    else if (view.specs.has(specId)) {
      fail(`${specId} is already in the specification library (@${view.specs.get(specId).at(-1)}). Start a draft of its next revision with --revise.`,
        'SPEC_LIBRARY_ID_TAKEN', { specId, nextAction: `singularity-flow spec author new ${specId} --revise` });
    }
  } catch (error) {
    // Offline, a new draft can still start: publication refuses a revision someone else took meanwhile.
    if (error?.code !== 'SPEC_LIBRARY_UNAVAILABLE' || revise) throw error;
  }
  const title = optionString(options, 'title')?.trim() || base?.manifest.title || intent?.trim().split(/\r?\n/u)[0].slice(0, 120) || 'Untitled specification';
  if (!title?.trim()) fail(`spec author new ${specId} needs --title TEXT.`, 'SPEC_TITLE_MISSING', { specId });
  const spec = base ? base.spec : from ? await (await import('../spec-library/sources.mjs')).readSpecTextFile(from) : specTemplate(specId, title.trim(), intent);
  const saved = await saveDraft(root, specId, {
    operationId, operation: 'new', create: true, actor: actor(root),
    payload: { title, kind: optionString(options, 'kind') ?? null, from: from ? 'file' : base ? `revision ${base.revision}` : 'template', spec, areas },
    change: () => {
      const draft = newDraft({ title, spec, areas, kind: optionString(options, 'kind') ?? base?.manifest.kind ?? null });
      if (base) {
        Object.assign(draft, { basedOn: { revision: base.revision, manifestSha256: base.manifestSha256, reviewState: base.manifest.reviewState },
          gaps: base.gaps.events, research: base.research.items, checklist: [],
          ...(base.manifest.sources ? { sources: base.manifest.sources } : {}), ...(base.manifest.origins ? { origins: base.manifest.origins } : {}) });
        // A child of a split stays derived from the parent revision it was split from (§7).
        if (base.manifest.derivedFrom) draft.derivedFrom = base.manifest.derivedFrom;
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
  const hasMetadata = optionString(options, 'title') !== undefined || optionString(options, 'kind') !== undefined;
  if ((!file && !hasMetadata) || expected === undefined) fail(`spec author edit ${specId} needs --expected-seq N (the snapshot you edited from) with --file FILE, --title TEXT or --kind business|technical.`, 'SPEC_EDIT_INCOMPLETE', { specId, nextAction: `singularity-flow spec author status ${specId}` });
  const wording = file ? { spec: await (await import('../spec-library/sources.mjs')).readSpecTextFile(file) } : {};
  const metadata = {};
  if (optionString(options, 'title') !== undefined) { metadata.title = optionString(options, 'title').trim() || 'Untitled specification'; if (metadata.title.length > 240) fail('Use a title of 1 to 240 characters.', 'SPEC_TITLE_INVALID'); }
  if (optionString(options, 'kind') !== undefined) metadata.kind = (await import('../spec-library/draft-model.mjs')).normalizeSpecKind(optionString(options, 'kind'));
  const saved = await saveDraft(root, specId, {
    operationId: operation(options), operation: 'edit', expectedSequence: expected, wordingBasis: true, actor: actor(root), payload: { ...wording, ...metadata },
    change: (draft) => ({ ...draft, ...wording, ...metadata })
  });
  return print(options, { action: 'edit', specId, sequence: saved.snapshot.sequence, replayed: saved.replayed, operationId: saved.snapshot.operationId },
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
  // The issued proposal file is used up once staged, so the next turn creates it afresh instead of
  // finding the last turn's proposals still there; a person's own file is left alone.
  const issued = samePlatformPath(file, await proposalFile(root, specId));
  const contents = await readFile(path.resolve(file), 'utf8').catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
    return fail(`${file} does not exist${issued ? ': propose removes the proposal file once it has staged it, so write the next proposals to it afresh' : ''}. What is staged already shows in singularity-flow spec author status ${specId}.`,
      'SPEC_PROPOSAL_INVALID', { specId, file, nextAction: `singularity-flow spec author status ${specId} --json` });
  });
  let payload;
  try { payload = JSON.parse(contents); } catch (error) { fail(`${file} is not JSON: ${error.message}. Nothing was staged; the file is kept for the repair.`, 'SPEC_PROPOSAL_INVALID', { specId, file }); }
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
        fail(`Nothing was staged; the proposals need fixing: ${checked.findings.map((finding) => `${finding.field}: ${finding.message}`).join('; ')}. The file is kept for the repair.`,
          'SPEC_PROPOSAL_INVALID', { specId, findings: checked.findings, nextAction: `singularity-flow spec author status ${specId} --json` });
      }
      notes = checked.entries.flatMap((entry) => entry.notes);
      ({ staged } = stageProposals(draft, checked, { actor: who, at: new Date().toISOString(), sequence: head.sequence }));
      return draft;
    }
  });
  const accept = staged.filter((id) => id.startsWith('P-'));
  if (issued) await rm(path.resolve(file), { force: true });
  const removed = issued ? 'The proposal file was removed now that it is staged; write any further proposals to it afresh.' : null;
  return print(options, { action: 'propose', specId, staged, notes, replayed: saved.replayed, sequence: saved.snapshot.sequence, proposalFile: issued ? 'removed' : 'kept' },
    saved.replayed ? [`Already proposed: this file was staged in snapshot ${saved.snapshot.sequence}.`, removed].filter(Boolean).join(' ')
      : [`Staged ${staged.join(', ')} on ${specId}. Nothing is in the draft until a person accepts it.`, ...notes.map((note) => `  ${note}`),
        accept.length ? `The person accepts in the Spec Studio, or: singularity-flow spec author accept ${specId} ${accept.join(' ')}` : null, removed].filter(Boolean).join('\n'));
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
  const draft = await requireDraft(root, specId, { headOnly: true });
  const report = await reportFor(root, specId, draft);
  return print(options, { action: 'check', specId, sequence: draft.head.sequence, report }, `${headLine(specId, draft.head)}\n${summarizeCheck(report)}`);
}

async function statusAction(root, positionals, options) {
  const specId = requireSpecId(specArgument(positionals, 'status'));
  const draft = await requireDraft(root, specId, { headOnly: optionBoolean(options, 'quick') });
  const gaps = foldGaps(draft.head.draft.gaps);
  const articles = foldChecklist(draft.head.draft.checklist).map(({ article, decision }) => ({ article, decision: decision?.decision ?? null, reason: decision?.reason ?? null }));
  const assisted = assistedReport(draft.head.draft);
  let fastClauseIds = [], clauseReadError = null;
  if (optionBoolean(options, 'quick')) {
    try { fastClauseIds = extractClauses(draft.head.draft.spec, { namespace: specId }).map(clause => clause.id); }
    catch (error) { clauseReadError = { code: error.code ?? 'SPEC_CLAUSES_INCOMPLETE', message: error.message }; }
  }
  const report = optionBoolean(options, 'quick') ? {
    research: [], counts: { d: { passed: 0, total: 0 }, a: { status: assisted.status, pending: assisted.pending.length },
      h: { open: gaps.filter(gap => gap.status === 'open').length + articles.filter(article => !article.decision).length, deferred: gaps.filter(gap => gap.status === 'deferred').length } },
    blocking: [], reviewReady: false, deterministic: { rules: [] },
    human: { articles, gaps: { open: gaps.filter(gap => gap.status === 'open').map(gap => gap.id) } },
    analyzer: { clauseIds: fastClauseIds }
  } : await reportFor(root, specId, draft);
  const next = report.reviewReady ? `singularity-flow spec author publish ${specId} --reviewed`
    : report.human.gaps.open.length ? `singularity-flow spec author gaps ${specId} ${report.human.gaps.open[0]}`
      : kindUnconfirmed(report) ? setKindCommand(specId, draft.head.sequence) : `singularity-flow spec author check ${specId}`;
  const standing = new Map(report.research.map((entry) => [entry.id, entry]));
  const { spec, areas, research } = draft.head.draft;
  const sharedDraft = await (await import('../spec-library/shared-basis.mjs')).sharedBasis(root, specId) ?? draft.head.draft.sharedDraftBase ?? null;
  return print(options, {
    action: 'status', specId, sequence: draft.head.sequence, title: draft.head.draft.title, kind: draft.head.draft.kind ?? null, origins: draft.head.draft.origins ?? [], sources: draft.head.draft.sources ?? [], basedOn: draft.head.draft.basedOn,
    qualityChecked: !optionBoolean(options, 'quick'), ...(clauseReadError ? { clauseReadError } : {}), sharedDraft,
    gaps: gaps.map(({ id, kind, status, question, evidence, clauses, options: choices, decision, deferral }) => ({ id, kind, status, question, evidence, clauses,
      options: choices, decision: decision && { option: decision.option, choice: decision.choice, reason: decision.reason, by: decision.by, at: decision.at },
      deferral: deferral && { owner: deferral.owner, reason: deferral.reason, by: deferral.by, at: deferral.at } })),
    research: research.length, damagedSnapshots: draft.damaged, historyChecked: draft.historyChecked !== false, counts: report.counts,
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
  const draft = await requireDraft(root, specId, { headOnly: true });
  const expectedSequence = optionNumber(options, 'expected-seq');
  if (expectedSequence !== undefined && expectedSequence !== draft.sequence) fail('The specification changed during review. Your writing is saved; review the current version before making it ready.', 'SPEC_DRAFT_STALE', { specId, expected: expectedSequence, current: draft.sequence, nextAction: 'singularity-flow spec author status ' + specId });
  const basedOn = draft.head.draft.basedOn;
  // Nothing changed since this draft's last publication in the same state: that revision is the answer.
  if (draft.head.operation === 'published' && basedOn?.reviewState === reviewState && basedOn.pendingChanges !== true) {
    return print(options, { action: 'publish', specId, revision: basedOn.revision, reviewState, replayed: true, manifestSha256: basedOn.manifestSha256, unchanged: true },
      `Nothing changed since ${specId}@${basedOn.revision} (${reviewState}); no new revision was published.`);
  }
  // A revision is immutable on the state branch, so what cannot be shared cannot be published either.
  (await import('../spec-library/share-check.mjs')).assertDraftShareable(specId, draft.head.draft, { verb: 'published', code: 'SPEC_PUBLISH_SECRET' });
  const report = await reportFor(root, specId, draft);
  if (reviewState === 'reviewed' && !report.reviewReady) {
    const setKind = kindUnconfirmed(report) ? setKindCommand(specId, draft.sequence) : null;
    fail(`${specId} cannot be published as reviewed: ${report.blocking.map((finding) => finding.message.replace(/\.$/u, '')).join('; ')}.${setKind ? ` Confirm the kind with ${setKind}.` : ''} Nothing was published; --draft publishes it as a draft revision.`,
      'SPEC_LIBRARY_REVIEW_INCOMPLETE', { specId, blocking: report.blocking, nextAction: setKind ?? `singularity-flow spec author status ${specId}` });
  }
  // The same draft head published in the same state is the same operation, so a retry after a lost
  // acknowledgement returns the revision it already published.
  const operationId = optionString(options, 'operation-id')
    ? requireOperationId(optionString(options, 'operation-id'))
    : `spp-${draft.head.snapshotSha256.slice('sha256:'.length, 'sha256:'.length + 16)}-${reviewState}`;
  const command = `singularity-flow spec author publish ${specId} --${reviewState} --operation-id ${operationId}`;
  const who = actor(root);
  const published = await publishRevision(root, await libraryConfig(root), { specId, draft, report, reviewState, operationId, actor: who, command,
    seal: (fields) => repositoryStepSeal(root, 'publish', specId, fields) });
  crashPoint('spec-library-published');
  // The draft continues from what it just published; a lost save here is healed at the next publish.
  await saveDraft(root, specId, {
    operationId: `${operationId}-recorded`, operation: 'published', actor: who,
    payload: { revision: published.revision, manifestSha256: published.manifestSha256, reviewState },
    change: (current) => publicationContinuation(current, draft.head.draft, { revision: published.revision, manifestSha256: published.manifestSha256, reviewState })
  });
  return print(options, { action: 'publish', specId, revision: published.revision, reviewState, replayed: published.replayed,
    manifestSha256: published.manifestSha256, commit: published.commit, operationId },
  `${published.replayed ? 'Already published' : 'Published'} ${specId}@${published.revision} (${reviewState}) to the state branch${published.commit ? ` at ${published.commit.slice(0, 12)}` : ''}.`);
}

async function showAction(root, positionals, options) {
  const { specId, revision } = parseSpecReference(specArgument(positionals, 'show'));
  const view = await libraryView(root, await libraryConfig(root));
  const read = resolveRevision(root, view, specId, revision, { anyState: revision !== null || optionBoolean(options, 'any') });
  const standing = (await (await import('../spec-library/presence.mjs')).libraryPresence(root)).revision(view, read);
  if (optionBoolean(options, 'json')) {
    return print(options, { action: 'show', specId, revision: read.revision, commit: read.commit, manifest: read.manifest,
      manifestSha256: read.manifestSha256, spec: read.spec, gaps: read.gaps.events, research: read.research.items, quality: read.quality,
      presence: { counts: standing.counts, state: standing.state, label: standing.label } }, '');
  }
  const header = `${specId}@${read.revision} (${read.manifest.reviewState}) ${read.manifest.title} — published ${read.manifest.recordedAt} by ${read.manifest.publishedBy?.name ?? 'unknown'}; state ${read.commit.slice(0, 12)}${standing.label ? `\nSF Guard: ${standing.label}` : ''}`;
  return console.log(`${header}\n\n${read.spec}`);
}

async function listAction(root, options) {
  const view = await libraryView(root, await libraryConfig(root), { refresh: !optionBoolean(options, 'local') });
  const presence = await (await import('../spec-library/presence.mjs')).libraryPresence(root);
  // One record this build cannot read (damaged, or from a newer schema) is that entry's problem; the
  // rest of the library, and every local draft, still lists (SPEC-SPA AC-031).
  const unreadable = [];
  const specs = [];
  for (const [specId, revisions] of [...view.specs.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    try {
      const latest = readManifest(root, view, specId, revisions.at(-1));
      const standing = presence.revision(view, latest);
      specs.push({ specId, revisions, latest: { revision: latest.revision, reviewState: latest.manifest.reviewState, title: latest.manifest.title,
        ...(standing.state === 'not-required' ? {} : { presence: { counts: standing.counts, state: standing.state, label: standing.label } }) } });
    } catch (error) { unreadable.push({ specId, record: 'revision', code: error.code ?? null, message: error.message }); }
  }
  const { sharedDrafts } = await import('../spec-library/shared-drafts.mjs');
  const library = await sharedDrafts(root, null, { view });
  unreadable.push(...library.unreadable.map((entry) => ({ ...entry, record: 'shared draft' })));
  const shared = library.drafts.map(item => ({ specId: item.head.specId, title: item.checkpoint.draft.title, kind: item.checkpoint.draft.kind ?? null, savedAt: item.checkpoint.savedAt, checkpointSha256: item.head.checkpointSha256 }));
  const drafts = (await listDrafts(root, { headOnly: true, unreadable })).map((draft) => ({ specId: draft.specId, sequence: draft.sequence, title: draft.head?.draft.title ?? null, basedOn: draft.head?.draft.basedOn ?? null }));
  return print(options, { action: 'list', state: { status: view.status, commit: view.commit }, specs, drafts, shared, unreadable }, [
    view.status === 'not-fetched' ? 'Shared specifications have not been fetched on this clone. Run singularity-flow spec author list to refresh; local drafts remain available.'
      : view.status === 'absent' ? 'The specification library is empty: nothing has been published to the state branch yet.' : `Specification library at ${view.commit.slice(0, 12)}:`,
    ...specs.map((entry) => `  ${entry.specId}@${entry.latest.revision} (${entry.latest.reviewState}) ${entry.latest.title}${entry.latest.presence?.counts === false ? ` — SF Guard: ${entry.latest.presence.label}` : ''}`),
    ...(drafts.length ? ['Drafts on this clone:', ...drafts.map((entry) => `  ${entry.specId} snapshot ${entry.sequence}${entry.basedOn ? ` (based on @${entry.basedOn.revision})` : ''} ${entry.title ?? ''}`)] : []),
    ...(unreadable.length ? ['Could not be read, so not listed:', ...unreadable.map((entry) => `  ${entry.specId} (${entry.record}): ${entry.message}`)] : [])
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
  const { allocatedCoverage, readSplits, splitCoverage } = await import('../spec-library/split.mjs');
  const { records, unreadable } = usage.readUsage(root, view, specId, revision);
  const splits = readSplits(root, view, specId);
  // SF Guard (SPEC-PSS-v1 §10.9): a split recorded while SF Guard was on allocates only with its seal.
  const presence = await (await import('../spec-library/presence.mjs')).libraryPresence(root);
  const uncountedSplits = splits.splits.filter((entry) => !presence.split(view, entry).counts).map((entry) => entry.split);
  splits.splits = splits.splits.filter((entry) => !uncountedSplits.includes(entry.split));
  const { split, allocation, leftOut, children } = splitCoverage({ ...read, specId }, splits.splits);
  const clauses = allocatedCoverage(usage.coverageOf({ ...read, specId }, records), { allocation, leftOut });
  const counts = Object.fromEntries(['delivered', 'claimed', 'allocated', 'left-out', 'uncovered'].map((status) => [status, clauses.filter((entry) => entry.status === status).length]));
  const lines = [`${specId}@${revision} at state ${String(view.commit).slice(0, 8)}: ${clauses.length} clause(s): ${counts.delivered} delivered, ${counts.claimed} claimed, ${counts.allocated} allocated${counts['left-out'] ? `, ${counts['left-out']} left out` : ''}, ${counts.uncovered} uncovered.`];
  if (repaired) lines.unshift(`Repair for ${repaired.workId}: ${repaired.written.length} record(s) written, ${repaired.present.length} already there${repaired.differing.length ? `, ${repaired.differing.length} different and left as they are` : ''}.`);
  const allocated = (entry) => entry.allocatedTo.map((to) => (to.kind === 'child' ? `child ${to.specId}` : `slice ${to.key}`)).join(', ');
  for (const entry of clauses) {
    lines.push(`  [${entry.clause}] ${entry.status}${entry.deliveredBy.length ? ` by ${entry.deliveredBy.join(', ')}` : ''}${entry.claimedBy.length ? `${entry.deliveredBy.length ? '; ' : ' '}claimed by ${entry.claimedBy.join(', ')}` : ''}${entry.allocatedTo.length ? `; allocated to ${allocated(entry)}` : ''}${entry.leftOut ? `: ${entry.leftOut}` : ''}`);
  }
  for (const child of children) {
    lines.push(`  child ${child.specId} (split ${child.split} of @${child.fromRevision}): ${child.status === 'parent-moved' ? `parent moved; ${child.changed.join(', ')} changed since @${child.fromRevision}` : child.status}`);
  }
  if (unreadable.length || splits.unreadable.length) lines.push(`Unreadable records, not counted: ${[...unreadable, ...splits.unreadable].join(', ')}`);
  if (uncountedSplits.length) lines.push(`Not counted under SF Guard (no valid presence seal): split ${uncountedSplits.join(', ')}; a person publishes the split again (singularity-flow spec split ${specId}@${revision} --publish), where it takes their Touch ID.`);
  return print(options, { action: 'coverage', specId, revision, stateCommit: view.commit, clauses, counts, split, children,
    unreadable: [...unreadable, ...splits.unreadable], ...(uncountedSplits.length ? { uncountedSplits } : {}), ...(repaired ? { repaired } : {}) }, lines.join('\n'));
}

// How many positionals each action reads (`spec author <action> SPEC-ID` is four). A value past them
// was dropped without a word: `settle --finding A-001=fixed A-002=fixed` settled A-001 alone.
const POSITIONAL_LIMITS = Object.freeze({ list: 3, gaps: 5, decide: 5, accept: Infinity, reject: Infinity });

/** Refuse values an action would not read, before anything is written. */
export function refuseStrayValues(command, positionals, limit) {
  const stray = positionals.slice(limit);
  if (!stray.length) return;
  fail(`${command} does not take ${stray.map((value) => `'${value}'`).join(', ')}; nothing was changed. A flag takes one value: repeat it once per value, for example --finding A-001=fixed --finding A-002=fixed.`,
    'SPEC_AUTHOR_ARGUMENT_UNEXPECTED', { values: stray, nextAction: 'singularity-flow help spec' });
}

/**
 * SF Guard (SPEC-PSS-v1 §10.6): while the repository's signed policy has SF Guard on, a person's Spec
 * Studio step, and a split's publication, takes their presence signature before it writes anything.
 */
async function personStepPresence(root, step, specId) {
  await (await import('../presence/repository-steps.mjs')).signRepositoryStep(root, {
    action: `spec.${step}`, title: `spec ${step}${specId ? ` ${specId}` : ''}`,
    lines: [`Specification: ${specId ?? '(named on the command)'}`, `Step: ${step}, a person's own Spec Studio step`]
  });
}

/**
 * A publication's SF Guard seal (SPEC-PSS-v1 §10.9): the person's one touch over the exact record the
 * state branch receives, kept beside it as `presence.json`, or null while SF Guard is off here.
 */
export async function repositoryStepSeal(root, step, specId, { revision = null, split = null, manifestSha256 = null, splitSha256 = null, reviewState = null }) {
  const [{ signRepositoryStep }, { repositorySeal, sealBytes, sealedRecord }] = await Promise.all([
    import('../presence/repository-steps.mjs'), import('../presence/repository-seals.mjs')]);
  const record = split == null ? sealedRecord('spec-revision', `${specId}@${revision}`, { manifestSha256 })
    : sealedRecord('spec-split', `${specId}#${split}`, { splitSha256 });
  const presence = await signRepositoryStep(root, { action: `spec.${step}`, title: `spec ${step} ${split == null ? `${specId}@${revision}` : `${specId} split ${split}`}`,
    lines: [`Specification: ${specId}`, split == null ? `Revision: @${revision} (${reviewState})` : `Split: ${split}`,
      `Step: ${step}, a person's own Spec Studio step`], record: { ...record } });
  return presence ? sealBytes(repositorySeal(presence, record)) : null;
}

export async function specAuthorCommand(positionals, options) {
  // `spec split` (SPEC-SPA v1.3 §7) shares this module's library reads and output.
  if (positionals[1] === 'split') {
    return (await import('./spec-split.mjs')).specSplitCommand(positionals, options, { libraryConfig, actor, print, refuseStrayValues, repositoryStepSeal });
  }
  const action = positionals[2];
  if (!SPEC_AUTHOR_ACTIONS.includes(action)) fail(`${action ? `'${action}' is not a spec author action. ` : ''}${USAGE}`, 'SPEC_AUTHOR_ACTION_UNKNOWN', { action: action ?? null, nextAction: 'singularity-flow help spec' });
  refuseStrayValues(`spec author ${action}`, positionals, POSITIONAL_LIMITS[action] ?? 4);
  const root = repoRoot();
  // A publication takes its touch over the exact record it writes (publishRevision's seal), not here.
  if (SPEC_AUTHOR_PERSON_ACTIONS.includes(action) && action !== 'publish' && options['dry-run'] !== true) await personStepPresence(root, action, positionals[3] ?? null);
  if (['sync', 'shared', 'resume', 'history', 'source', 'sources', 'derive', 'fork', 'restore-version'].includes(action)) return (await import('./spec-studio.mjs')).specStudioCommand(root, positionals, options, { config: await libraryConfig(root), actor: actor(root), operationId: operation(options) });
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
