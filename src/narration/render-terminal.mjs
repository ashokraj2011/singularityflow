/**
 * The only place terminal prose for a command result is produced.
 *
 * Handlers return data. This turns it into words. Keeping that boundary is what lets the wording
 * improve, or be translated, without touching a handler — and what stops a future handler printing
 * a reassuring sentence that its own effects contradict.
 */
import { MESSAGES, REASONS } from './messages.mjs';
import { preservedEverything } from './command-result.mjs';
import { approvalChainText } from '../approval-chain.mjs';
import { matrixText } from '../evidence/matrix.mjs';
import { contextXrayText } from '../context-xray.mjs';
import { tokenLedgerText } from '../token-ledger.mjs';
import { table } from '../util.mjs';
import { safeCommandGuidance, commandGuidanceLines } from '../safe-command-guidance.mjs';
import * as style from '../style.mjs';
import { nextSuggestionsHeading } from '../personalization.mjs';

/**
 * The reassurance line, derived from declared effects rather than authored.
 *
 * `preserves` in the catalog only marks a message as *allowed* to reassure; what it says is
 * computed here from what the command reports it changed. A message can never promise more than
 * the effects support.
 */
export function preservationLine(result) {
  if (!preservedEverything(result)) return null;
  const message = MESSAGES[result.outcome.messageId];
  if (!message?.preserves) return null;
  return 'No lifecycle state, files, publications or external systems were changed.';
}

export function headline(result) {
  const message = MESSAGES[result.outcome.messageId];
  if (!message) return result.outcome.messageId;
  return message.headline(result.outcome.slots ?? {});
}

function whyLines(result) {
  return result.why
    .map((entry) => {
      const reason = REASONS[entry.code];
      const text = reason ? reason.render(entry.slots ?? {}) : entry.code;
      // The friendly reason carries its provenance. A citation a reviewer cannot resolve is a
      // claim, not evidence, so the immutable reference stays visible beside the readable line.
      const lines = [entry.ref ? `  - ${text}\n      ↳ ${entry.source}:${entry.ref}` : `  - ${text}`];
      // A terminal has no links, so the deep link is the command that would follow it. Explaining
      // *why* something was refused is only half an answer when the reader does not yet know what
      // the thing being refused is called `[DOC:REQ-041]`.
      if (entry.topic) {
        const guidance = safeCommandGuidance(`sflow explain ${entry.topic}`);
        if (guidance) {
          lines.push(`      ↳ Copilot: ${guidance.copilotCommand}`);
          lines.push(`        Shell: ${guidance.command}`);
          lines.push(`        VS Code (model-free): ${guidance.modelFreeCommand ?? 'not available for this action'}`);
        }
      }
      return lines.join('\n');
    });
}

function nextLines(result) {
  const order = { NOW: 0, SOON: 1, LATER: 2 };
  // Within a rank the producer's order stands (the sort is stable): a planner lists publish,
  // submit, then approve, and sorting by id put approve first and "Cancel this Story" before all.
  return [...result.next]
    .sort((a, b) => order[a.rank] - order[b.rank])
    // Every continuation names its supported entry points. Keeping the labels explicit prevents a
    // terminal command from being mistaken for the only supported route, and prevents Copilot from
    // guessing a slash command from prose.
    .map((entry) => {
      const guidance = safeCommandGuidance(entry);
      return guidance
        ? [
          `  ${style.detail(entry.rank.padEnd(5))} ${entry.label}`,
          `        Copilot: ${style.action(guidance.copilotCommand)}`,
          `        Shell: ${style.action(guidance.command)}`,
          `        VS Code (model-free): ${style.action(guidance.modelFreeCommand ?? 'not available for this action')}`
        ].join('\n')
        : [
          `  ${style.detail(entry.rank.padEnd(5))} ${entry.label}`,
          `        ${style.detail('Command guidance unavailable: the supplied route was not safe or did not match.')}`,
          `        Copilot: ${style.detail('no verified equivalent')}`,
          `        Shell: ${style.detail('unavailable — the supplied route was not safe or did not match')}`,
          `        VS Code (model-free): ${style.detail('not available for this action')}`
        ].join('\n');
    });
}

function goalLines(result) {
  if (!result.operation.id.startsWith('goal.')) return [];
  const { goal, goals, links = [], activeGoalId } = result.data ?? {};
  if (Array.isArray(goals)) {
    if (!goals.length) return ['', style.detail('No Goals match this view.')];
    return ['', ...goals.flatMap((item) => [
      `${item.id === activeGoalId ? style.pass('●') : '○'} ${style.heading(item.id)}  ${item.statement}`,
      `  ${style.detail(`${item.status} · ${item.links?.length ?? item.linkedWork ?? 0} linked work item(s) · ${item.successCriteria?.length ?? 'governed'} success criterion/criteria`)}`
    ])];
  }
  if (!goal) return [];
  const lines = [
    '',
    style.heading(goal.statement),
    style.detail(`Goal: ${goal.id} · ${goal.status} · ${goal.authority === 'governed-execution' ? 'repository Goal' : 'personal advisory state'}`),
    '',
    style.heading('Success means:'),
    ...goal.successCriteria.map((criterion) => `  - ${criterion}`)
  ];
  if (goal.links.length) {
    lines.push('', style.heading('Work:'));
    const facts = new Map(links.map((link) => [`${link.repositoryId}:${link.kind}:${link.id}`, link]));
    for (const link of goal.links) {
      const live = facts.get(`${link.repositoryId}:${link.kind}:${link.id}`);
      lines.push(`  - ${link.id} · ${link.repositoryId} · ${live?.status ?? 'not inspected'}${live?.phase ? ` · ${live.phase}` : ''}`);
    }
  }
  return lines;
}

function journalLines(result) {
  if (!result.operation.id.startsWith('journal.')) return [];
  const data = result.data ?? {};
  if (result.operation.id === 'journal.today') {
    const lines = ['', style.detail(data.privacy?.label ?? 'Stored locally · Never pushed')];
    if (!data.summaries?.length && !data.attention?.length) {
      lines.push('No local engineering outcomes were recorded for this day. This is not an activity or productivity judgment.');
    } else {
      for (const item of data.summaries ?? []) lines.push(`${style.pass('✓')} ${item.workId ? `${item.workId} · ` : ''}${item.text}`);
      for (const item of data.attention ?? []) lines.push(`${style.pending('!')} ${item.workId ? `${item.workId} · ` : ''}${item.text}`);
    }
    if (data.malformedLines?.length) lines.push(style.detail(`Warning: ${data.malformedLines.length} malformed local event line(s) were ignored.`));
    return lines;
  }
  if (result.operation.id === 'journal.doctor') {
    return ['', ...(data.findings ?? []).map((finding) => `  - [${finding.state}] ${finding.id}: ${finding.detail}`)];
  }
  if (result.operation.id.startsWith('journal.settings') || ['journal.pause', 'journal.resume'].includes(result.operation.id)) {
    return ['',
      `  Mode: ${data.mode}`,
      `  Paused: ${data.paused ? 'yes' : 'no'}`,
      `  Retention: ${data.retentionDays} days`,
      `  Time zone: ${data.timeZone}`,
      style.detail('Prompt content, source bytes, command output, file saves, and remote sync are disabled.')
    ];
  }
  if (result.operation.id === 'journal.export.preview' && data.preview) return ['', data.preview.trimEnd()];
  if (result.operation.id === 'journal.export' && data.file) {
    return ['', style.detail(`Wrote ${data.file} outside registered worktrees. Nothing was uploaded or staged.`)];
  }
  return [];
}

function comprehensionText(result) {
  const {
    context = {}, manifest = null, coverage = null, graph = null, explanation = null,
    replay = null, expansion = null
  } = result.data ?? {};
  const common = [
    style.heading(headline(result)),
    `Repository: ${context.repository ?? 'unavailable'}`,
    `Repository change-set subject: ${manifest?.compatibilityCandidateSha256 ?? coverage?.candidateSha256 ?? graph?.candidateSha256 ?? result.data?.candidateSha256 ?? 'unavailable'}`,
    `Baseline: ${context.base ?? 'unavailable'} (${context.source ?? 'unknown'})`
  ];
  if (result.operation.id === 'comprehension.source' && expansion) {
    const bytes = Buffer.from(expansion.content ?? '', 'base64');
    const decoded = bytes.toString('utf8');
    const text = !bytes.includes(0) && Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : null;
    return [
      ...common,
      `Region: ${expansion.regionId} · ${expansion.side} · ${expansion.path}`,
      `Exact content: ${expansion.contentSha256} · ${expansion.totalBytes} byte(s)`,
      `Page: ${expansion.offset}-${expansion.offset + expansion.bytes} · ${expansion.pageSha256}`,
      text == null ? 'Binary page: use --json to read its base64 content.' : '',
      text == null ? null : '',
      text,
      expansion.nextOffset == null
        ? null
        : `Next page: repeat with --offset ${expansion.nextOffset}`,
      '', style.detail('Observe only: exact source expansion neither authorizes nor blocks publication.'),
      style.detail(preservationLine(result))
    ].filter((value) => value !== null && value !== '').join('\n');
  }
  if (result.operation.id === 'comprehension.replay' && replay) {
    const rows = replay.events.map((event) => ({
      at: event.at,
      kind: event.kind,
      phase: event.phase ?? '—',
      provenance: event.provenance
    }));
    return [
      style.heading(headline(result)),
      `Repository: ${context.repository ?? 'unavailable'}`,
      `Story: ${replay.workId}`,
      `Replay: ${replay.replaySha256}`,
      `Focus: ${replay.focus.type}${replay.focus.value ? ` ${replay.focus.value}` : ''}`,
      ...(rows.length ? ['', table(rows, [
        { key: 'at', label: 'AT' },
        { key: 'kind', label: 'KIND' },
        { key: 'phase', label: 'PHASE' },
        { key: 'provenance', label: 'PROVENANCE' }
      ])] : ['', 'No matching replay events.']),
      replay.truncated ? style.detail('Replay truncated at the 1,000-event read ceiling.') : null,
      '', style.detail('Observe only: this Story projection is not SGOS Process replay and changes no state.'),
      style.detail(preservationLine(result))
    ].filter(Boolean).join('\n');
  }
  if (result.operation.id === 'comprehension.record-preview' && result.data?.preview) {
    const preview = result.data.preview;
    const migration = result.data.migration ?? null;
    return [
      style.heading(headline(result)),
      `Repository: ${context.repository ?? 'unavailable'}`,
      `Preview: ${preview.previewSha256}`,
      `Schema: ${preview.schemaVersion}${migration
        ? ` (stored ${migration.storedSchemaVersion}; ${migration.applied.length} migration step(s))`
        : ''}`,
      `Assessment: ${preview.summary.verdict}; unresolved: ${preview.summary.counts.unresolved}/${preview.summary.counts.materialRegions}`,
      'Authority: unverified observation · lifecycle gate: no · publication effect: none',
      '', style.detail('Experimental preview only: no record, approval, cache, or repository state was written.'),
      style.detail(preservationLine(result))
    ].filter(Boolean).join('\n');
  }
  if (result.operation.id === 'comprehension.regions' && manifest) {
    const rows = manifest.regions.map((region) => ({
      region: region.regionId,
      operation: region.operation,
      path: region.location.pathAfter ?? region.location.pathBefore ?? '(unknown)',
      assurance: region.classification.assurance
    }));
    return [
      ...common,
      `Granularity: ${manifest.granularity}; structural assurance: ${manifest.structuralAssurance}`,
      'Every region is conservatively material and in scope; ownership has not been inferred.',
      ...(rows.length ? ['', table(rows, [
        { key: 'region', label: 'REGION' },
        { key: 'operation', label: 'OPERATION' },
        { key: 'path', label: 'PATH' },
        { key: 'assurance', label: 'ASSURANCE' }
      ])] : []),
      '', style.detail('Observe only and non-authoritative: this result neither authorizes nor blocks publication.'),
      style.detail(preservationLine(result))
    ].filter(Boolean).join('\n');
  }
  if (result.operation.id === 'comprehension.brownfield' && result.data?.assessment) {
    const assessment = result.data.assessment;
    const rows = assessment.regions.map((region) => ({
      region: region.regionId,
      path: region.pathAfter ?? region.pathBefore ?? '(unknown)',
      classification: region.touchClass,
      requirement: region.requirement
    }));
    return [
      ...common,
      `Policy: ${assessment.policy.profile}; full repository backfill required: no`,
      ...(rows.length ? ['', table(rows, [
        { key: 'region', label: 'REGION' },
        { key: 'path', label: 'PATH' },
        { key: 'classification', label: 'CLASSIFICATION' },
        { key: 'requirement', label: 'REQUIREMENT' }
      ])] : []),
      '', style.detail('Observe only: unchanged legacy code is not scanned, and no historical cause is invented.'),
      style.detail(preservationLine(result))
    ].filter(Boolean).join('\n');
  }
  if (result.operation.id === 'comprehension.backfill.validate' && result.data?.validation) {
    const validation = result.data.validation;
    return [
      style.heading(headline(result)),
      `Repository: ${context.repository ?? 'unavailable'}`,
      `Source revision: ${validation.sourceRevision ?? 'unavailable'}`,
      `Scope: ${validation.scope?.kind ?? 'invalid'}${validation.scope?.path ? ` (${validation.scope.path})` : ''}`,
      `Validation: ${validation.valid ? 'valid proposal shape' : 'invalid'}; authority: none`,
      ...validation.failures.map((failure) => `- ${failure.code}: ${failure.message}`),
      '', style.detail('Validation never confirms historical truth or changes lifecycle state.'),
      style.detail(preservationLine(result))
    ].filter(Boolean).join('\n');
  }
  if (result.operation.id === 'comprehension.check' && coverage) {
    const rows = coverage.unresolved.map((entry) => ({
      region: entry.regionId,
      path: entry.path ?? '(unknown)',
      reason: entry.reason
    }));
    return [
      ...common,
      `Assessment: ${coverage.verdict}; unresolved: ${coverage.counts.unresolved}/${coverage.counts.materialRegions}`,
      ...(rows.length ? ['', table(rows, [
        { key: 'region', label: 'REGION' },
        { key: 'path', label: 'PATH' },
        { key: 'reason', label: 'REASON' }
      ])] : []),
      '', style.detail('Observe only and non-authoritative: this assessment neither authorizes nor blocks publication.'),
      style.detail(preservationLine(result))
    ].filter(Boolean).join('\n');
  }
  if (result.operation.id === 'comprehension.graph' && graph) {
    return [
      ...common,
      `Graph: ${graph.graphSha256}`,
      `Nodes: ${graph.counts.nodes} · causes: ${graph.counts.causes} · regions: ${graph.counts.regions} · edges: ${graph.counts.edges}`,
      `Structure: ${graph.availability.structure} (${graph.availability.structureReason})`,
      '', style.detail('Observe only and non-authoritative: only validated diagnostic bindings become graph edges.'),
      style.detail(preservationLine(result))
    ].filter(Boolean).join('\n');
  }
  if (result.operation.id === 'comprehension.explain' && explanation) {
    const rows = explanation.nodes.map((node) => ({
      type: node.type,
      subject: node.type === 'cause' ? `${node.causeKind}:${node.causeId}` : node.regionId,
      detail: node.type === 'cause' ? node.statement : node.pathAfter ?? node.pathBefore ?? '(unknown)'
    }));
    return [
      ...common,
      `Status: ${explanation.status}${explanation.reasonCode ? ` (${explanation.reasonCode})` : ''}`,
      `Graph: ${explanation.graphSha256}`,
      ...(rows.length ? ['', table(rows, [
        { key: 'type', label: 'TYPE' },
        { key: 'subject', label: 'SUBJECT' },
        { key: 'detail', label: 'DETAIL' }
      ])] : []),
      explanation.truncated ? style.detail('Result truncated at the bounded query ceiling.') : null,
      '', style.detail('Observe only and non-authoritative: this explanation neither authorizes nor blocks publication.'),
      style.detail(preservationLine(result))
    ].filter(Boolean).join('\n');
  }
  return [style.heading(headline(result)), preservationLine(result)].filter(Boolean).join('\n\n');
}

export function codeExplanationTerminalValue(value, fallback = 'unavailable', maximum = 2_000) {
  const normalized = String(value ?? fallback)
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const selected = normalized || fallback;
  return selected.length > maximum ? `${selected.slice(0, maximum - 1)}…` : selected;
}

// An explain --subject view's prose is registered by its own lazily loaded handler
// (render-explanation-subject.mjs), so commands that never explain a subject do not load it.
const FAMILY_RENDERERS = new Map();

/** Register the terminal prose of a command family whose handler loads it; unregistered, a result shows its headline. */
export function registerFamilyRenderer(prefix, render) {
  FAMILY_RENDERERS.set(prefix, render);
}

function sizeText(bytes) {
  if (!Number.isFinite(bytes)) return 'size not measured';
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Whole-repository explanation: folders, then code with its declarations and tags, then clauses. */
function repositoryExplanationText(result) {
  const explanation = result.data.repository;
  const safe = codeExplanationTerminalValue;
  const budget = explanation.budget;
  const scope = explanation.scope.path ? safe(explanation.scope.path) : 'whole repository';
  const lines = [
    style.heading(headline(result)),
    `${safe(explanation.repository.name)} · HEAD ${safe(explanation.repository.head ?? 'none').slice(0, 12)} · scope: ${scope} · authority: none`,
    budget.status === 'over-budget'
      ? `Budget: ${budget.files == null ? 'more application files than a bounded listing holds' : `${budget.files} application files`}`
        + ` exceed the AST budget of ${budget.maxFiles} files and ${sizeText(budget.maxBytes)} (${safe(budget.reason)}).`
      : `Budget: ${budget.files} application file(s), ${sizeText(budget.bytes)}, within the AST budget of ${budget.maxFiles} files and ${sizeText(budget.maxBytes)}.`
  ];
  const index = explanation.index;
  if (index?.status === 'not-indexed') lines.push('Index: not built; ask about one folder or file to explain it.');
  else if (index?.status === 'disabled') lines.push('Index: structural intelligence (AST) is off, so declarations are not listed.');
  else if (index?.counts) {
    lines.push(`Index: ${index.counts.symbols} declaration(s) from ${index.counts.indexedFiles} indexed file(s)`
      + `${index.counts.workingTreeFiles ? ` and ${index.counts.workingTreeFiles} file(s) read from the working tree because they differ from HEAD` : ''}`
      + `${index.counts.notIndexedFiles ? `; ${index.counts.notIndexedFiles} file(s) not indexed${index.reason ? ` (${safe(index.reason)})` : ''}` : ''}`
      + `${index.built ? '; the index was filled now for this scope' : index.warm?.status === 'complete' && index.warm.mode === 'background' ? '; indexed in the background when the workspace was set up' : ''}.`);
  }
  if (explanation.hiddenSingularityFiles) lines.push(`Not shown: ${explanation.hiddenSingularityFiles} Singularity Flow file(s), which are not code.`);
  if (explanation.entries.length) {
    lines.push('', style.heading('FOLDERS AND FILES'));
    for (const entry of explanation.entries.slice(0, 40)) {
      const languages = entry.languages.map((item) => `${safe(item.language)} ${item.files}`).join(' · ');
      lines.push(`  ${safe(entry.path)}${entry.kind === 'folder' ? '/' : ''}  ${entry.kind === 'folder' ? `${entry.files} file(s) · ` : ''}`
        + `${languages}${entry.tests ? ` · ${entry.tests} test file(s)` : ''}`);
    }
    const omitted = explanation.entriesTotal - Math.min(40, explanation.entries.length);
    if (omitted > 0) lines.push(`  ${omitted} more entr${omitted === 1 ? 'y' : 'ies'}; --json lists ${explanation.entries.length}.`);
  }
  const described = explanation.files.filter((file) => file.symbols.length || file.tags.length);
  if (described.length) {
    lines.push('', style.heading('CODE'));
    for (const file of described.slice(0, 60)) {
      lines.push(`  ${safe(file.path)}  ${safe(file.language)} · ${sizeText(file.bytes)}${file.test ? ' · test' : ''}`);
      if (file.symbols.length) {
        lines.push(`     ${file.symbols.slice(0, 8).map((symbol) => `${safe(symbol.kind)} ${safe(symbol.name)} L${symbol.line}`).join(' · ')}`
          + `${file.symbolCount > 8 ? ` · ${file.symbolCount - 8} more` : ''}`);
      }
      for (const tag of file.tags.slice(0, 4)) {
        lines.push(`     @${safe(tag.tag)} ${safe(tag.clauseId)} at L${tag.line}${tag.note ? `: “${safe(tag.note)}”` : ''}`);
      }
    }
    if (described.length > 60) lines.push(`  ${described.length - 60} more file(s) with declarations or tags; --json lists them.`);
  }
  if (explanation.clauses.length) {
    lines.push('', style.heading('CLAUSES TAGGED IN CODE AND TESTS'));
    for (const clause of explanation.clauses.slice(0, 30)) {
      const code = clause.code.map((entry) => `${safe(entry.path)}:${entry.line}`).join(', ') || 'no code';
      const tests = clause.tests.map((entry) => `${safe(entry.path)}:${entry.line}`).join(', ') || 'no test';
      lines.push(`  ${safe(clause.clauseId)}  code: ${code} · tests: ${tests}`);
    }
  }
  lines.push('', style.detail('A declaration is what the AST index records and a tag is the author\'s declaration; neither shows behavior or coverage.'));
  if (result.next.length) lines.push('', style.heading(nextSuggestionsHeading(result.data?.personalization)), ...nextLines(result));
  lines.push(style.detail(preservationLine(result)));
  return lines.filter((line) => line != null).join('\n');
}

function codeExplanationText(result) {
  const { context = {}, explanation, narrative = null } = result.data ?? {};
  if (!explanation) return [headline(result), preservationLine(result)].filter(Boolean).join('\n');
  const safe = codeExplanationTerminalValue;
  const short = (value) => safe(value).replace(/^sha256:/u, '').slice(0, 12);
  const unitLines = explanation.whyEachChange.length ? explanation.whyEachChange.flatMap((unit) => {
    const file = safe(unit.location?.pathAfter ?? unit.location?.pathBefore, 'unknown path');
    const range = unit.hunk
      ? `+${unit.hunk.after.start}${unit.hunk.after.lines ? `,${unit.hunk.after.lines}` : ''}`
      : safe(unit.opacity?.reason, 'opaque change');
    const symbols = unit.declarations?.length
      ? unit.declarations.map((entry) => `${safe(entry.qualifiedName ?? entry.name)}:${entry.line} (${safe(entry.assurance)}; navigation only)`).join(', ')
      : `declaration unavailable: ${safe(unit.structure?.reason, 'no exact structural boundary')}`;
    const causeReferences = unit.cause?.references?.length
      ? unit.cause.references.map((entry) => `${safe(entry.causeKind)}:${safe(entry.causeId)} (region reference; not hunk-bound)`).join(', ')
      : 'no recorded cause reference';
    return [
      `  ${safe(unit.unitId)}  ${safe(unit.explanationStatus, 'unexplained').toUpperCase()} · ${safe(unit.cause?.reason, 'no validated cause binding')}`,
      `     ${file} · ${safe(unit.operation)} · ${range}`,
      `     ${symbols}`,
      `     ${causeReferences}`
    ];
  }) : [explanation.counts?.explanationUnits
    ? `  No exact change units matched ${safe(explanation.query?.type)}=${safe(explanation.query?.value)}; ${explanation.counts.explanationUnits} unit(s) remain outside this drill-down.`
    : '  No observable change units exist in the selected interval.'];
  const symbolRows = explanation.whyEachChange.flatMap((unit) => unit.declarations ?? []);
  const impactLines = explanation.availability?.impact?.status === 'available'
    ? ['  Exact impact records are available in the JSON result.']
    : [
      `  Impact unavailable: ${safe(explanation.availability?.impact?.reason, 'repository impact was not projected')}.`,
      ...(symbolRows.length
        ? [`  ${symbolRows.length} cached declaration overlap(s) are navigation hints, not caller or ownership proof.`]
        : ['  No cached declaration overlap is available.'])
    ];
  const proofLines = explanation.availability?.proof?.status === 'available'
    ? ['  Recorded proof references are available in the JSON result.']
    : [`  Proof unavailable: ${safe(explanation.availability?.proof?.reason, 'candidate-bound proof was not projected')}.`];
  const narrativeLines = narrative ? [
    '', style.heading(safe(narrative.banner, 'Narrative — advisory, not a record')),
    narrative.status === 'available'
      ? safe(narrative.text, 'No citation-valid narrative sentence was returned.')
      : `Unavailable: ${safe(narrative.reason, 'model narration unavailable')}.`,
    narrative.status === 'available'
      ? style.detail(`${narrative.removedUncited ?? 0} uncited · ${narrative.removedInvalid ?? 0} invalid removed · ${narrative.rewrittenToRecords ?? 0} selection(s) rendered from records · ${narrative.rewrittenOverclaims ?? 0} overclaim(s) neutralized`)
      : null
  ] : [];
  return [
    style.heading(safe(headline(result), 'Code explanation')),
    `${safe(context.workId, 'Repository')} · ${safe(context.phase, 'no active phase')} · compatibility subject ${short(explanation.candidate?.sha256)} · baseline ${short(context.base)}`,
    `${explanation.counts.regions} changed region(s) · ${explanation.counts.diffHunks} text hunk(s) · ${explanation.counts.opaqueUnits} opaque unit(s) · authority: none`,
    '', style.heading('WHY EACH CHANGE IS THERE'), ...unitLines,
    '', style.heading('WHAT IT TOUCHES'), ...impactLines,
    '', style.heading('WHAT IS PROVEN, WHAT IS NOT'), ...proofLines,
    ...narrativeLines,
    ...(result.next.length ? ['', style.heading(nextSuggestionsHeading(result.data?.personalization)), ...nextLines(result)] : []),
    '', style.detail('Observe only: this projection cannot approve, publish, gate, or change lifecycle state.'),
    style.detail(preservationLine(result))
  ].filter((value) => value !== null && value !== '').join('\n');
}

function shadowPassportText(result) {
  const passport = result.data ?? {};
  return [
    style.heading(headline(result)),
    'Authority: none (read-only diagnostic)',
    `Candidate: ${passport.candidate?.candidateSha256 ?? 'unavailable'}`,
    `Proof Subject: ${passport.records?.proofSubject?.proofSubjectSha256 ?? 'unavailable'}`,
    `Change Passport: ${passport.records?.passport?.passportSha256 ?? 'unavailable'}`,
    `Legacy comparison: ${passport.comparison?.category ?? 'unavailable'}`,
    `World Model: ${passport.worldModel?.status ?? 'unavailable'} (never blocking in this view)`,
    '', style.heading('Known gaps:'),
    ...(passport.gaps ?? []).map((gap) => `  - ${gap.code} · ${gap.status}: ${gap.message}`),
    '', style.detail('This shadow record is not consumed by a gate, approval, publisher, or lifecycle decision.'),
    style.detail(preservationLine(result))
  ].filter(Boolean).join('\n');
}

function proofObservationText(result) {
  const proof = result.data ?? {};
  const summary = proof.summary ?? null;
  const predicateResults = proof.results ?? (proof.result ? [proof.result] : []);
  const resultRows = predicateResults.map((entry) => ({
    predicate: entry.predicate?.id ?? 'unknown',
    verdict: entry.verdict ?? 'unavailable',
    reason: entry.reasonCode ?? 'PFC_REQUIRED_INPUT_UNAVAILABLE'
  }));
  return [
    style.heading(headline(result)),
    'Mode: observe · Authority: none',
    summary ? `Proof Summary: ${summary.summarySha256} · ${summary.verdict}` : null,
    ...(resultRows.length ? ['', table(resultRows, [
      { key: 'predicate', label: 'PREDICATE' },
      { key: 'verdict', label: 'VERDICT' },
      { key: 'reason', label: 'REASON' }
    ])] : []),
    ...(Array.isArray(proof.gaps) && proof.gaps.length
      ? ['', style.heading('Known gaps:'), ...proof.gaps.map((gap) => `  - ${gap.gapId}: ${gap.proposition}`)]
      : []),
    ...(Array.isArray(proof.signals) && proof.signals.length
      ? ['', style.heading('Signals (non-authoritative):'), ...proof.signals.map((signal) => `  - ${signal.signalId}: ${String(signal.value)} ${signal.unit}`)]
      : []),
    ...(proof.explanation ? ['', style.heading('Explanation:'), `  ${proof.explanation}`] : []),
    '', style.detail('Observe only: this output cannot approve, gate, publish, or change Story lifecycle state.'),
    style.detail(preservationLine(result))
  ].filter(Boolean).join('\n');
}

const REST_STATE_LINES = Object.freeze({
  complete: 'This work is finished. There is nothing further to do.',
  cancelled: 'This work is cancelled and archived.',
  'awaiting-others': 'Nothing to do here — this is waiting on someone else.',
  informational: null
});

function governanceRebuildPreview(result) {
  const plan = result.data.plan;
  const short = (value) => (value ? String(value).slice(0, 12) : 'absent');
  const failing = plan.workflowFindings ?? [];
  return [
    style.heading(headline(result)),
    `Plan: ${plan.plan}`,
    `Configuration: ${plan.configuration.mode === 'authority' ? `authority ${plan.configuration.ref}` : 'committed checkout'} at ${short(plan.configuration.commit)} · package ${plan.product.version ?? 'unknown'}`,
    '', style.heading(`Framework files replaced (${plan.replaced.length}):`),
    ...(plan.replaced.length ? plan.replaced.map((entry) => `  ${entry.path}  ${short(entry.before)} → ${short(entry.after)}`) : ['  none: every framework file is current']),
    ...(plan.removed.length ? ['', style.heading(`Framework files removed (${plan.removed.length}):`), ...plan.removed.map((entry) => `  ${entry}`)] : []),
    ...(plan.kept.length ? ['', style.heading(`Repository settings kept as they are (${plan.kept.length}):`), ...plan.kept.map((entry) => `  ${entry}`)] : []),
    '', style.heading(`Workflows (${plan.workflows.length}): ${plan.workflows.length - failing.length} compile under the current rules.`),
    ...failing.flatMap((entry) => [
      `  ${entry.owner === 'framework' ? style.failure('✖') : style.pending('!')} ${entry.id} (${entry.owner}): ${entry.findings[0]?.message ?? 'does not compile'}`,
      ...(entry.findings[0]?.resolvingAction ? [`    Fix: ${entry.findings[0].resolvingAction}`] : [])
    ]),
    '', style.heading(`Stories to archive (${plan.storyDetails.length}):`),
    ...(plan.storyDetails.length ? plan.storyDetails.map((story) => `  ${story.id} (${story.statuses.join('/')}): ${story.locations.map((location) => `${location.ref}@${short(location.commit)}`).join(', ')}`) : ['  none']),
    ...(plan.blockers.length ? ['', style.heading('Resolve before activation:'), ...plan.blockers.map((blocker) => `  - ${blocker.code}: ${blocker.message}`)] : []),
    '', plan.blockers.length
      ? 'Nothing changed. This plan cannot be confirmed; resolve the issues above and preview again.'
      : 'Nothing changed. Application code, tests, documents and repository-owned definitions keep their bytes.',
    ...(result.next.length ? ['', style.heading(nextSuggestionsHeading(result.data?.personalization)), ...nextLines(result)] : []),
    style.detail(preservationLine(result))
  ].filter((line) => line !== null && line !== undefined).join('\n');
}

/** The outcome review: try it, each criterion's proof, then what the Story's end waits for. */
function outcomeReviewText(result) {
  const review = result.data.outcome;
  const app = review.application ?? {};
  const word = (status) => ({ met: 'done', missing: 'not done yet', pending: 'pending' })[status] ?? status ?? 'unknown';
  const appLines = app.status === 'declared' ? app.entries.flatMap((entry) => [
    `  ${entry.name} at ${entry.url}: ${entry.started ? `running (pid ${entry.pid})${entry.ready ? '' : ', not answering yet'}` : 'not running'}`,
    ...(entry.portTaken ? ['    Another process already listens at that address; stop it before starting this one.'] : []),
    ...(entry.start?.command ? [`    Start: ${entry.start.command}`] : []), ...(entry.stop?.command ? [`    Stop: ${entry.stop.command}`] : [])
  ]) : [`  ${app.status === 'none-declared' ? `No application is declared${app.setup?.command ? `; suggest one with ${app.setup.command}` : ''}.` : `Unavailable: ${app.message ?? 'unknown reason'}`}`];
  const criterionLines = review.criteria.flatMap((criterion) => [
    `  ${criterion.id} (${criterion.result ?? 'unknown'}${criterion.methods ? `; ${criterion.methods.join(', ')}` : ''})${criterion.text ? `: ${criterion.text}` : ''}`,
    ...criterion.tests.map((test) => `    test ${test.outcome ?? 'not run'}: ${test.test ?? test.file}`),
    ...criterion.checks.filter((check) => check.method !== 'test').flatMap((check) => [
      `    ${check.method} check ${check.slot}: ${word(check.status)}${check.reference ? `, compared with ${check.reference}` : ''}`,
      ...(check.suggestedFile ? [`      Save the screenshot as ${check.suggestedFile}`] : []),
      ...(check.signOff ? [`      Sign off after looking at it: ${check.signOff}`] : [])
    ])
  ]);
  const open = review.open;
  const openLines = [
    ...open.scopeItems.flatMap((item) => [`  ${item.id}: ${item.text}`, `    ${item.command}`, ...(item.otherCommand ? [`    ${item.otherCommand}`] : [])]),
    ...open.blocking.filter((finding) => !['EVIDENCE_VISUAL_MISSING', 'EVIDENCE_INSPECTION_MISSING', 'SCOPE_ITEMS_UNRESOLVED'].includes(finding.code))
      .map((finding) => `  ${finding.message}`)
  ];
  return [
    style.heading(headline(result)),
    `${review.lifecycle ?? 'Lifecycle unknown'} · ${review.completion ?? 'completion unknown'}`,
    ...(review.validation ? ['', style.heading(review.validation.question),
      ...review.validation.steps.map(step => `  ${step.label}: ${step.status}. ${step.detail}`),
      ...review.validation.choices.flatMap(choice => [`  ${choice.label}: ${choice.description}`,
        ...commandGuidanceLines(choice.route, choice.label)])] : []),
    '', style.heading('Try it:'), ...appLines,
    '', style.heading('Acceptance criteria:'), ...(criterionLines.length ? criterionLines : ['  None recorded yet.']),
    ...(openLines.length ? ['', style.heading("Still open for the Story's end:"), ...openLines] : []),
    ...(review.routes.tests ? ['', `Run the tests again: ${review.routes.tests.command}`] : []),
    ...commandGuidanceLines(review.applicationReview, 'Application review'),
    ...commandGuidanceLines(review.routes.repair, 'Request repair / inspect the legal owner route'),
    ...commandGuidanceLines(review.routes.continue, 'Continue with the current workflow actions'),
    'Opening this review records no acceptance or approval. Existing sign-off and application-review requirements still apply.'
  ].join('\n');
}

export function renderCommandResult(result) {
  if (result.operation.id === 'governance.rebuild.preview' && result.data?.plan) return governanceRebuildPreview(result);
  if (result.operation.id === 'outcome.review' && result.data?.outcome) return outcomeReviewText(result);
  if (result.operation.id === 'evidence.scope' && result.data?.scope) {
    const scope = result.data.scope;
    const order = ['unresolved', 'included', 'existing', 'excluded', 'deferred', 'informative', 'duplicate', 'superseded'];
    return [
      style.heading(headline(result)),
      `Structurally complete: ${scope.structurallyComplete ? 'yes, every identified statement has a disposition' : 'no'} (inventory ${scope.inventorySha256.slice(7, 19)})`,
      `Completeness reviewed: ${result.data.completenessReview ? `yes, by ${result.data.completenessReview.actor} through ${result.data.completenessReview.authorityGroup} on ${result.data.completenessReview.at.slice(0, 10)}` : 'no'}`,
      'Correctness: never claimed; a review says a person assessed the interpretation.',
      ...(result.data.preview ? ['Preview: the open specification step\'s clauses link statements here; they become evidence once it is approved.'] : []),
      '', style.heading('Sources:'),
      ...scope.sources.map((source) => `  ${source.id} (${source.kind}): ${source.readable ? `${source.statements} statement(s)` : `unreadable: ${source.reason}`}`),
      ...order.flatMap((disposition) => {
        const items = scope.items.filter((item) => item.disposition === disposition);
        if (!items.length) return [];
        return ['', style.heading(`${disposition[0].toUpperCase()}${disposition.slice(1)} (${items.length}):`),
          ...items.map((item) => `  ${item.id} [${item.sourceId}${item.line ? `:${item.line}` : ''}] ${item.text}${item.clauseIds?.length ? ` → ${item.clauseIds.join(', ')}` : ''}${item.duplicateOf ? ` (duplicate of ${item.duplicateOf})` : ''}`)];
      }),
      ...(scope.summary.unresolved ? ['', 'Record each unresolved statement: singularity-flow decision scope --item <ID> --as <disposition> [--clause <CLAUSE-ID> when included or existing; comma-separate several] --reason "<why>"'] : []),
      ...(result.next.length ? ['', style.heading(nextSuggestionsHeading(result.data?.personalization)), ...nextLines(result)] : []),
      style.detail(preservationLine(result))
    ].join('\n');
  }
  if (result.operation.id === 'governance.restore.preview' && result.data?.restore) {
    const restore = result.data.restore;
    return [
      style.heading(headline(result)),
      `Rebuild commit: ${restore.commit.slice(0, 12)} (restores the bytes of ${restore.parent.slice(0, 12)})`,
      ...restore.restores.map((entry) => `  ${entry.action === 'remove' ? 'remove ' : 'restore'} ${entry.path}`),
      ...(restore.dirty.length ? [style.heading('Commit or discard these changes first:'), ...restore.dirty.map((entry) => `  ${entry}`)] : []),
      ...(result.next.length ? [style.heading(nextSuggestionsHeading(result.data?.personalization)), ...nextLines(result)] : []),
      style.detail(preservationLine(result))
    ].join('\n');
  }
  if (result.operation.id === 'precheck.run.plan' && result.data?.plan) {
    const plan = result.data.plan;
    const rows = plan.commands.map((command) => ({
      purpose: command.purpose,
      cwd: command.workingDirectory,
      command: command.argv.map((argument) => JSON.stringify(argument)).join(' '),
      timeout: `${command.timeoutMs} ms`
    }));
    return [
      style.heading(headline(result)),
      `Plan: ${plan.planId}`,
      `Source: ${plan.sourceCommit} · ${plan.platform}/${plan.arch} · scope ${plan.scope ?? 'full'}`,
      `Structured tests: ${plan.structuredTestContract.status}`,
      ...(plan.blockers?.length
        ? ['', style.heading('Resolve before execution:'),
          ...plan.blockers.map((blocker) => `  - ${blocker.code}: ${blocker.subject}`)] : []),
      ...(rows.length ? ['', table(rows, [
        { key: 'purpose', label: 'PURPOSE' },
        { key: 'cwd', label: 'WORKING DIRECTORY' },
        { key: 'command', label: 'EXACT ARGV' },
        { key: 'timeout', label: 'TIMEOUT' }
      ])] : ['', style.pending('No repository command was detected.')]),
      '', plan.blockers?.length
        ? 'Nothing ran. This plan cannot be confirmed; repair the setup and request a new plan.'
        : 'Nothing ran. Review the exact argv above before confirming.',
      ...(result.next.length ? ['', style.heading(nextSuggestionsHeading(result.data?.personalization)), ...nextLines(result)] : []),
      style.detail(preservationLine(result))
    ].filter(Boolean).join('\n');
  }
  if (result.operation.id === 'precheck.run.execute' && result.data?.receipt) {
    const receipt = result.data.receipt;
    return [
      style.heading(headline(result)),
      ...receipt.commandResults.map((entry) => `${entry.status === 'pass' ? style.pass('✓') : style.failure('✖')} ${entry.purpose}: ${entry.id} (${entry.durationMs} ms)`),
      `Receipt: ${receipt.receiptSha256}`,
      `Exact base: ${receipt.sourceCommit} · ${receipt.platform}/${receipt.arch}`,
      `Stored Git-private: ${result.data.file}`,
      'The receipt contains hashes and outcomes, not command output or secrets.'
    ].filter(Boolean).join('\n');
  }
  if (result.operation.id === 'precheck.quick' && result.data?.precheck) {
    const precheck = result.data.precheck;
    return [
      style.heading(headline(result)),
      ...precheck.checks.map((check) => `${check.status === 'pass' ? style.pass('✓') : check.status === 'fail' ? style.failure('✖') : style.pending('~')} ${check.id}: ${check.subject}${check.reason ? ` (${check.reason})` : ''}`),
      `Proof readiness: ${precheck.proofReadiness}. No project command was run.`,
      style.detail(preservationLine(result))
    ].filter(Boolean).join('\n');
  }
  if (result.operation.id.startsWith('comprehension.')) return comprehensionText(result);
  if (result.operation.id.startsWith('explain.subject')) {
    return FAMILY_RENDERERS.get('explain.subject')?.(result) ?? [headline(result), preservationLine(result)].filter(Boolean).join('\n');
  }
  if (result.operation.id.startsWith('explain.code') && result.data?.repository?.kind === 'repository-explanation') {
    return repositoryExplanationText(result);
  }
  if (result.operation.id.startsWith('explain.code')) return codeExplanationText(result);
  if (result.operation.id === 'change.show.shadow') return shadowPassportText(result);
  if (result.operation.id.startsWith('proof.')) return proofObservationText(result);
  if (result.operation.id.startsWith('auto.') && result.data?.card) return result.data.card;
  if (result.operation.id === 'evidence.matrix' && result.data?.matrix) {
    return [style.heading(headline(result)), matrixText({ evaluation: result.data.matrix.evaluation, page: result.data.matrix.page })].join('\n');
  }
  if (result.operation.id === 'approvals' && result.data?.approvalChain) {
    return approvalChainText(result.data.approvalChain).trimEnd();
  }
  if (result.operation.id === 'context' && result.data?.xray) {
    return [contextXrayText(result.data.xray), preservationLine(result)].filter(Boolean).join('\n\n');
  }
  if (result.operation.id === 'context.compile' && result.data?.packet) {
    return JSON.stringify(result.data.packet, null, 2);
  }
  if (result.operation.id === 'context.expand' && result.data?.expansion) {
    const expansion = result.data.expansion;
    return [
      `CONTEXT EXPANSION · ${expansion.packetId} · ${expansion.representation}`,
      '', expansion.content, '',
      `${expansion.accounting.includedContentBytes.toLocaleString('en-US')} bytes · ${expansion.accounting.estimatedInputTokens.toLocaleString('en-US')} estimated tokens`
    ].join('\n');
  }
  if (result.operation.id === 'context.doctor' && result.data?.diagnostic) {
    const { status, policy, profile, configurationDigest } = result.data.diagnostic;
    return [
      `TOKEN ECONOMY · ${status} · ${policy.mode} · profile ${profile.id}`,
      `Estimated prompt ${profile.maximumEstimatedPromptTokens.toLocaleString('en-US')} · reserved output ${profile.reservedOutputTokens.toLocaleString('en-US')} · expansion ${profile.maxExpansionTokens.toLocaleString('en-US')} tokens`,
      `Observation firewall ${policy.observationFirewall ? 'on' : 'off'} · progressive retrieval ${policy.progressiveRetrieval ? 'on' : 'off'} · provider telemetry ${policy.providerTelemetry}`,
      `Configuration ${configurationDigest}`
    ].join('\n');
  }
  if (result.operation.id === 'tokens' && result.data?.ledger) {
    return [tokenLedgerText(result.data.ledger), preservationLine(result)].filter(Boolean).join('\n\n');
  }
  // A refusal is the one outcome the reader must not skim past, so it is the one that gets weight.
  const emphasise = ['refused', 'failed'].includes(result.outcome.status) ? style.failure : style.heading;
  const lines = [emphasise(headline(result))];

  lines.push(...goalLines(result));
  lines.push(...journalLines(result));

  const preservation = preservationLine(result);
  if (preservation) lines.push(style.detail(preservation));

  const why = whyLines(result);
  if (why.length) lines.push('', style.heading('Why:'), ...why);

  const next = nextLines(result);
  if (next.length) lines.push('', style.heading(nextSuggestionsHeading(result.data?.personalization)), ...next);
  else if (result.restState) {
    const rest = REST_STATE_LINES[result.restState];
    if (rest) lines.push('', rest);
  }

  return lines.join('\n');
}
