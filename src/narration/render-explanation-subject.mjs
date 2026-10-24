/**
 * Terminal prose for an `explain --subject` result [XPL2]: the computed statements with their
 * citations in the selected audience's order, an optional narration and snapshot comparison above
 * them. The explain handler loads this module and registers it before it emits; it stays out of
 * every other command's eager load.
 */
import * as style from '../style.mjs';
import { codeExplanationTerminalValue, headline, preservationLine, registerFamilyRenderer } from './render-terminal.mjs';

const XPL2_SECTIONS = [
  ['What changed', ['change-inventory', 'singularity-files-hidden', 'file-type', 'mode-change', 'hunk', 'opaque-unit', 'declaration-overlap']],
  ['Why it is linked', ['clause-declared', 'clause-cites', 'clause-required', 'clause-tag', 'region-association',
    'acceptance-tag', 'test-tag', 'cause-not-recorded']],
  ['What was checked', ['test-result', 'clause-untagged', 'gap-observed', 'no-complete-evaluation']],
  ['Limits and unknowns', ['admission-unavailable', 'feature-state', 'source-state', 'provenance-unavailable', 'generation-recorded']]
];

const DISCARDED_LABELS = [
  ['unknownIds', 'unknown statement ID'], ['duplicates', 'repeated statement'], ['prose', 'field of model prose'],
  ['connectives', 'unknown section'], ['invalidSections', 'malformed section'], ['byLength', 'statement past the word budget'],
  ['commentary', 'unrequested commentary']
];

/**
 * An `--narrate` result in the terminal [XPL2 13.2]: the advisory banner, the model's sections in its
 * order with each statement's own computed text and citations, the attention statements the kernel
 * always appends, what was discarded, and the commentary's state under its own banner.
 */
function narrationLines(narration, { safe, cite }) {
  const lines = [style.heading(safe(narration.banner))];
  if (narration.status !== 'available') {
    lines.push(`  Narration unavailable (${safe(narration.reason)}); the record view below is the whole answer.`);
    return lines;
  }
  lines.push(style.detail(`  A model chose and ordered these recorded statements (${narration.words ?? 0} of ${narration.maximumWords ?? 0} words); `
    + 'every line is the record\'s own text and it adds no facts.'));
  for (const section of narration.sections ?? []) {
    lines.push('', style.heading(safe(section.heading)));
    for (const statement of section.statements ?? []) {
      lines.push(`  ${safe(statement.id)}  ${cite({ text: statement.text, cites: statement.cites ?? [] })}`);
    }
  }
  const discarded = DISCARDED_LABELS.filter(([key]) => narration.discarded?.[key] > 0)
    .map(([key, label]) => `${narration.discarded[key]} ${label}${narration.discarded[key] === 1 ? '' : 's'}`);
  if (discarded.length) lines.push('', style.detail(`  Discarded from the model's answer: ${discarded.join(', ')}.`));
  const commentary = narration.commentary ?? null;
  if (commentary) {
    lines.push('', style.heading(safe(commentary.banner)));
    if (commentary.status === 'shown') {
      lines.push(`  ${safe(commentary.text, 'no text', 4_000)} [${(commentary.citations ?? []).map((id) => safe(id)).join(', ')}]`,
        style.detail('  Citing statement IDs is syntax only; nothing checked that the text means what the statements say.'));
    } else if (commentary.status === 'withheld') {
      lines.push(`  Withheld: ${(commentary.explanation ?? []).map((reason) => safe(reason)).join(' ')}`);
    } else {
      lines.push('  Not returned: the model gave no commentary.');
    }
  }
  return lines;
}

/** `explain --compare`: what moved between a retained snapshot and this view, unit by unit [XPL2 M3, 5.1]. */
function comparisonLines(comparison, { safe, short }) {
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (comparison.status !== 'available') {
    return [style.heading('Comparison'), `  No earlier retained snapshot of this Story on this machine to compare with (${comparison.retained ?? 0} retained). `
      + 'Views are retained as they are built; compare again after the change moves.'];
  }
  const { older, result } = comparison;
  const context = older.context ?? {};
  const lines = [style.heading(`Compared with retained snapshot ${short(older.id)}`),
    `  Retained ${safe(older.retainedAt)}${context.workId ? ` · Story ${safe(context.workId)}` : ''}${context.phase ? ` · phase ${safe(context.phase)}` : ''}`
      + ` · baseline ${short(context.baseline)}${result.sameSet ? ' · the same explanation set as this view' : ''}`];
  const sources = result.sources.changedCount
    ? `${plural(result.sources.changedCount, 'source')} changed (${result.sources.changed.map((id) => safe(id)).join(', ')}${result.sources.changedCount > result.sources.changed.length ? ', …' : ''})`
    : 'no source changed';
  if (!result.units) {
    lines.push(result.unitsUnavailable === 'bounded-view'
      ? `  One of the views holds only part of the change, so its change units cannot be compared unit by unit; ${sources}.`
      : `  That snapshot predates unit content digests, so its change units cannot be compared unit by unit; ${sources}.`);
    return lines;
  }
  const files = (units) => [...new Set(units.map((unit) => safe(unit.path)))].join(', ');
  lines.push(`  Since that snapshot: ${plural(result.units.addedCount, 'change unit')} new, ${result.units.removedCount} gone, ${result.units.kept} unchanged; ${sources}.`);
  // Files, not display IDs: each view numbers its units afresh, so H-001 here may be another change.
  if (result.units.added.length) lines.push(`  New changes in ${files(result.units.added)}${result.units.addedCount > result.units.added.length ? ', …' : ''}.`);
  if (result.units.removed.length) lines.push(`  Changes gone from ${files(result.units.removed)}${result.units.removedCount > result.units.removed.length ? ', …' : ''}.`);
  return lines;
}

/** Computed XPL2 subject view: typed statements with citations, in the selected audience's order. */
export function explanationSubjectText(result) {
  const explanation = result.data?.explanation;
  if (!explanation) return [headline(result), preservationLine(result)].filter(Boolean).join('\n');
  const safe = codeExplanationTerminalValue;
  const short = (value) => safe(value).replace(/^sha256:/u, '').slice(0, 12);
  const snapshot = explanation.snapshot ?? {};
  const subject = explanation.subject ?? {};
  const audience = explanation.presentation?.audience ?? 'reviewer';
  const plan = explanation.presentation?.audiences?.[audience] ?? { order: [], folded: [] };
  const folded = new Set(plan.folded ?? []);
  const byId = new Map((explanation.statements ?? []).map((entry) => [entry.id, entry]));
  const ordered = (plan.order ?? []).map((id) => byId.get(id)).filter(Boolean);
  const cite = (entry) => `${safe(entry.text)} [${entry.cites.map((id) => safe(id)).join(', ')}]`;
  const lines = [
    style.heading(headline(result)),
    `Subject: ${safe(subject.kind)} · ${safe(subject.status)}${subject.reason ? ` (${safe(subject.reason)})` : ''} · audience ${safe(audience)}`,
    `Source: ${safe(snapshot.truth)} · baseline ${short(snapshot.baseline?.revision)} → capture ${short(snapshot.compatibilityCandidateSha256)}`
      + `${snapshot.workId ? ` · Story ${safe(snapshot.workId)}` : ''}${snapshot.phase ? ` · phase ${safe(snapshot.phase)}` : ''}`,
    'Authority: none — this view grants no approval, test result or merge verdict.'
  ];
  if ((subject.choices ?? []).length) {
    lines.push('', style.heading('Exact choices'));
    for (const choice of subject.choices) lines.push(`  ${safe(choice.kind)}: ${safe(choice.label)}`);
  }
  if (result.data?.comparison) lines.push('', ...comparisonLines(result.data.comparison, { safe, short }));
  const narration = result.data?.narration ?? null;
  if (narration) {
    lines.push('', ...narrationLines(narration, { safe, cite }));
    lines.push('', style.heading('Record view'),
      style.detail('The computed statements, in the record\'s own order; the narration above changed none of them.'));
  }
  if ((explanation.derived ?? []).length) {
    lines.push('', style.heading('Answer'));
    for (const entry of explanation.derived) lines.push(`  ${safe(entry.id)}  ${cite(entry)}`);
  }
  if ((explanation.attention ?? []).length && ['change', 'gap'].includes(subject.kind)) {
    lines.push('', style.heading('Needs attention'));
    for (const entry of explanation.attention) {
      const statement = byId.get(entry.statement);
      if (statement) lines.push(`  ${safe(entry.id)} [${safe(entry.category)}] ${cite(statement)}`);
    }
  }
  for (const [title, kinds] of XPL2_SECTIONS) {
    const members = ordered.filter((entry) => kinds.includes(entry.kind));
    const shown = members.filter((entry) => !folded.has(entry.id));
    if (!members.length) continue;
    lines.push('', style.heading(title));
    for (const entry of shown) lines.push(`  ${safe(entry.id)}  ${cite(entry)}`);
    if (shown.length < members.length) {
      lines.push(`  ${members.length - shown.length} more folded for the ${safe(audience)} audience; --for auditor lists everything.`);
    }
  }
  const counts = explanation.inventory?.counts;
  if (counts) {
    lines.push('', `Counts: ${counts.files} file(s) · ${counts.textHunks} text hunk(s) · ${counts.opaqueUnits} opaque · `
      + `${counts.causeBoundUnits} hunk-bound cause link(s) · ${counts.unexplainedUnits} without an exact cause · ${counts.clauses} clause(s)`
      + `${counts.clauseTags || counts.acceptanceTags ? ` · ${counts.clauseTags ?? 0} @clause tag(s) · ${counts.acceptanceTags ?? 0} @ac tag(s)` : ''}`
      + `${counts.clauseCitations ? ` · ${counts.clauseCitations} clause citation(s)` : ''}`);
  }
  if (explanation.delivery?.complete === false) {
    lines.push(`Delivery bounded: ${explanation.delivery.returnedUnits} of ${explanation.delivery.totalUnits} unit(s) shown; narrow with --subject line or clause, or raise --max-bytes.`);
  }
  lines.push('', style.heading('Sources'));
  for (const source of explanation.sources ?? []) {
    const properties = source.properties ?? {};
    lines.push(`  ${safe(source.id)}  ${safe(source.label ?? source.family)} · integrity ${safe(properties.integrity)} · `
      + `${safe(properties.origin)} · ${safe(properties.applicability)} · ${safe(properties.availability)}`
      + `${source.digest ? ` · ${short(source.digest)}` : ''}`);
  }
  for (const observation of explanation.observations ?? []) {
    lines.push(`  ${safe(observation.id)}  read observation · ${safe(observation.reason)} · ${safe(observation.scope)}`);
  }
  const retained = result.data?.snapshot;
  lines.push('', `Explanation set ${short(explanation.explanationSetSha256)} · view ${short(explanation.explanationSha256)}`
    + (retained?.retained ? ' · retained on this machine for --compare' : retained ? ` · not retained (${safe(retained.reason)})` : ''));
  lines.push(style.detail(preservationLine(result)));
  return lines.filter((line) => line != null).join('\n');
}

registerFamilyRenderer('explain.subject', explanationSubjectText);
