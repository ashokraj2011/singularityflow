import { currentSchemaVersion } from '../../schema-migrations.mjs';
import { SingularityFlowError } from '../../util.mjs';

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

/** Model-free renderer used when a registered contract declares model mode optional. */
export function renderDeterministicCandidate(contract, viewLedger) {
  const facts = [...viewLedger.facts];
  const required = new Set([
    ...(viewLedger.requiredFactIds ?? []),
    ...(viewLedger.requiredUnavailableFactIds ?? []),
    ...(viewLedger.materialContradictionFactIds ?? [])
  ]);
  const selected = [
    ...facts.filter((fact) => required.has(fact.id)),
    ...facts.filter((fact) => !required.has(fact.id))
  ].slice(0, contract.facts.maximumSelectedFacts);
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
  for (let index = 0; index < selected.length; index += 1) {
    const fact = selected[index];
    const section = fact.status === 'contradicted' && contradictionSection
      ? contradictionSection
      : fact.status === 'unavailable' && unavailableSection
        ? unavailableSection
        : ordinarySections[index % ordinarySections.length] ?? contract.sections[0];
    bySection.get(section.id).push(factualUnit([fact], { list: true }));
  }
  for (const section of contract.sections) {
    if (bySection.get(section.id).length) continue;
    const fallback = selected.find((fact) => fact.status === 'unavailable') ?? selected[0];
    if (fallback) bySection.get(section.id).push(factualUnit([fallback], { list: true }));
  }
  const contradictions = selected.filter((fact) => fact.status === 'contradicted');
  const unavailable = selected.filter((fact) => fact.status === 'unavailable');
  const summaryFacts = [...contradictions, ...unavailable, ...selected]
    .filter((fact, index, values) => values.findIndex((entry) => entry.id === fact.id) === index)
    .slice(0, 3);
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
    usedFactIds: selected.map((fact) => fact.id).sort()
  };
}
