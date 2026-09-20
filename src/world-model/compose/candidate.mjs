import { currentSchemaVersion } from '../../schema-migrations.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { canonicalJson, compareText } from '../canonicalize.mjs';

export const FACT_REFERENCE = /\[F:(FACT-[a-f0-9]{16,64}(?:,FACT-[a-f0-9]{16,64})*)\]/g;

export function candidateFactReferences(candidate) {
  const texts = [candidate?.tldrMarkdown, ...(candidate?.sections ?? []).map((section) => section?.markdown)]
    .filter((value) => typeof value === 'string');
  const references = [];
  for (const text of texts) {
    for (const match of text.matchAll(FACT_REFERENCE)) references.push(...match[1].split(','));
  }
  return [...new Set(references)].sort();
}

export function parseCompositionCandidate(value) {
  let candidate = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    try { candidate = JSON.parse(trimmed); }
    catch {
      const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      if (!fenced) {
        throw new SingularityFlowError('World-model composer output is not one JSON object.', {
          code: 'WMB_MODEL_OUTPUT_INVALID'
        });
      }
      try { candidate = JSON.parse(fenced[1]); }
      catch (error) {
        throw new SingularityFlowError(`World-model composer output is invalid JSON: ${error.message}`, {
          code: 'WMB_MODEL_OUTPUT_INVALID'
        });
      }
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new SingularityFlowError('World-model composition candidate must be an object.', {
      code: 'WMB_MODEL_OUTPUT_INVALID'
    });
  }
  return candidate;
}

function factualLine(fact) {
  const reference = `[F:${fact.id}]`;
  if (fact.status === 'unavailable') {
    const detail = fact.reason?.detail ?? 'The requested analysis is unavailable.';
    return `${detail.replace(/[.\s]+$/, '')}. ${reference}`;
  }
  if (fact.status === 'contradicted') {
    return `${String(fact.claim ?? 'Registered observations contradict one another').replace(/[.\s]+$/, '')}. ${reference}`;
  }
  return `${String(fact.claim ?? 'Registered fact').replace(/[.\s]+$/, '')}. ${reference}`;
}

function factualUnit(facts, { list = false } = {}) {
  const sorted = [...facts].sort((left, right) => left.id.localeCompare(right.id));
  const prose = sorted.map((fact) => factualLine(fact).replace(/\s*\[F:[^\]]+\]\s*$/, '')).join(' ');
  const references = `[F:${sorted.map((fact) => fact.id).join(',')}]`;
  return `${list ? '- ' : ''}${prose} ${references}`;
}

function wordCount(value) {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function typeBalancedFacts(facts) {
  const queues = new Map();
  for (const fact of [...facts].sort((left, right) => (
    compareText(left.factType, right.factType) || compareText(left.id, right.id)
  ))) {
    if (!queues.has(fact.factType)) queues.set(fact.factType, []);
    queues.get(fact.factType).push(fact);
  }
  const ordered = [];
  const types = [...queues.keys()].sort(compareText);
  let offset = 0;
  while (true) {
    let added = false;
    for (const type of types) {
      const fact = queues.get(type)[offset];
      if (!fact) continue;
      ordered.push(fact);
      added = true;
    }
    if (!added) return ordered;
    offset += 1;
  }
}

function buildDeterministicCandidate(contract, admittedFacts) {
  const selected = [...admittedFacts].sort((left, right) => compareText(left.id, right.id));
  const bySection = new Map(contract.sections.map((section) => [section.id, []]));
  const contradictionSection = contract.sections.find(
    (section) => section.sectionKind === 'contradiction'
  );
  const unavailableSection = contract.sections.find(
    (section) => section.sectionKind === 'unavailable'
  );
  const ordinarySections = contract.sections.filter(
    (section) => !['contradiction', 'unavailable'].includes(section.sectionKind)
  );
  let ordinaryIndex = 0;
  for (const fact of selected) {
    let section;
    if (fact.status === 'contradicted' && contradictionSection) section = contradictionSection;
    else if (fact.status === 'unavailable' && unavailableSection) section = unavailableSection;
    else {
      section = ordinarySections[ordinaryIndex % ordinarySections.length] ?? contract.sections[0];
      ordinaryIndex += 1;
    }
    bySection.get(section.id).push(factualUnit([fact], { list: true }));
  }
  for (const section of contract.sections) {
    if (bySection.get(section.id).length) continue;
    const fallback = selected.find((fact) => fact.status === 'unavailable') ?? selected[0];
    if (fallback) bySection.get(section.id).push(factualUnit([fallback], { list: true }));
  }
  const contradictions = selected.filter((fact) => fact.status === 'contradicted');
  const summaryFacts = [...contradictions];
  for (const fact of [
    ...selected.filter((entry) => entry.status === 'unavailable'),
    ...selected
  ]) {
    if (summaryFacts.some((entry) => entry.id === fact.id)) continue;
    if (summaryFacts.length >= Math.max(3, contradictions.length)) break;
    summaryFacts.push(fact);
  }
  return {
    schemaVersion: currentSchemaVersion('world-model-composition-candidate'),
    kind: 'world-model-composition-candidate',
    view: contract.id,
    viewVersion: contract.version,
    title: contract.title,
    tldrMarkdown: factualUnit(summaryFacts),
    sections: contract.sections.map((section) => ({
      sectionId: section.id,
      markdown: bySection.get(section.id).join('\n')
    })),
    usedFactIds: selected.map((fact) => fact.id)
  };
}

function candidateFitsBudgets(candidate, contract, outputBudget) {
  if (wordCount(candidate.tldrMarkdown) > contract.narrative.tldrMaximumWords) return false;
  if (candidate.sections.some(
    (section) => wordCount(section.markdown) > contract.narrative.sectionMaximumWords
  )) return false;
  const narrative = [
    candidate.tldrMarkdown, ...candidate.sections.map((section) => section.markdown)
  ].join('\n');
  if (wordCount(narrative) > contract.narrative.totalMaximumWords) return false;
  const maximumOutputTokens = outputBudget?.viewBudgets?.[contract.id]?.maximumOutputTokens
    ?? contract.budgets.maximumOutputTokens;
  return Math.ceil(Buffer.byteLength(canonicalJson(candidate), 'utf8') / 4) <= maximumOutputTokens;
}

/** Model-free renderer used when a registered contract declares model mode optional. */
export function renderDeterministicCandidate(contract, viewLedger, { outputBudget = null } = {}) {
  const facts = [...viewLedger.facts];
  const required = new Set([
    ...(viewLedger.requiredFactIds ?? []),
    ...(viewLedger.requiredUnavailableFactIds ?? []),
    ...(viewLedger.materialContradictionFactIds ?? [])
  ]);
  const admitted = facts.filter((fact) => required.has(fact.id));
  let candidate = buildDeterministicCandidate(contract, admitted);
  if (!candidateFitsBudgets(candidate, contract, outputBudget)) {
    throw new SingularityFlowError(
      `View '${contract.id}@${contract.version}' minimum required narrative exceeds its registered output budget.`,
      {
        code: 'WMB_OUTPUT_BUDGET_EXCEEDED',
        details: {
          viewId: contract.id,
          mandatoryFacts: admitted.length,
          maximumOutputTokens: outputBudget?.viewBudgets?.[contract.id]?.maximumOutputTokens
            ?? contract.budgets.maximumOutputTokens
        }
      }
    );
  }
  const optional = typeBalancedFacts(facts.filter((fact) => !required.has(fact.id)));
  for (const fact of optional) {
    if (admitted.length >= contract.facts.maximumSelectedFacts) break;
    const attempted = buildDeterministicCandidate(contract, [...admitted, fact]);
    if (!candidateFitsBudgets(attempted, contract, outputBudget)) continue;
    admitted.push(fact);
    candidate = attempted;
  }
  return candidate;
}
