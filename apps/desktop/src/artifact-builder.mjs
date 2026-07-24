const normalize = (value) => String(value ?? '').replace(/\r\n?/g, '\n');
const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';

export const ARTIFACT_SECTION_LIBRARY = [
  {
    group: 'Business content',
    type: 'summary',
    label: 'Executive summary',
    description: 'Outcome, audience, and decision required.',
    title: 'Executive summary',
    body: 'Summarize the business outcome, intended audience, and decision this artifact supports.'
  },
  {
    group: 'Business content',
    type: 'scope',
    label: 'Scope & boundaries',
    description: 'In scope, out of scope, and assumptions.',
    title: 'Scope and boundaries',
    body: '### In scope\n\n- Describe included capabilities.\n\n### Out of scope\n\n- Describe explicit exclusions.\n\n### Assumptions\n\n- Record assumptions that require validation.'
  },
  {
    group: 'Business content',
    type: 'stakeholders',
    label: 'Stakeholders',
    description: 'Owners, reviewers, and affected teams.',
    title: 'Stakeholders',
    body: '| Role | Name / team | Responsibility |\n| --- | --- | --- |\n| Owner |  |  |\n| Reviewer |  |  |'
  },
  {
    group: 'Traceability',
    type: 'requirements',
    label: 'Requirements & AC',
    description: 'Stable requirement and acceptance identifiers.',
    title: 'Requirements and acceptance criteria',
    body: '| Requirement | Description | Source | Acceptance criteria |\n| --- | --- | --- | --- |\n| REQ-001 |  | SRC-001 | AC-001 |'
  },
  {
    group: 'Traceability',
    type: 'inputs',
    label: 'Approved inputs',
    description: 'Inject approved upstream artifacts.',
    title: 'Approved inputs',
    body: '{{inputs}}'
  },
  {
    group: 'Traceability',
    type: 'dependencies',
    label: 'Dependencies',
    description: 'Teams, systems, contracts, and milestones.',
    title: 'Dependencies',
    body: '| Dependency | Owner | Required by | Status |\n| --- | --- | --- | --- |\n|  |  |  |  |'
  },
  {
    group: 'Solution',
    type: 'design',
    label: 'Solution outline',
    description: 'Components, interfaces, and important choices.',
    title: 'Solution outline',
    body: 'Describe the proposed solution, affected components, interfaces, data flow, and constraints.'
  },
  {
    group: 'Solution',
    type: 'decisions',
    label: 'Decision log',
    description: 'Alternatives and accepted decisions.',
    title: 'Decision log',
    body: '| Decision | Options considered | Choice | Rationale |\n| --- | --- | --- | --- |\n| DEC-001 |  |  |  |'
  },
  {
    group: 'Assurance',
    type: 'risks',
    label: 'Risks & controls',
    description: 'Risk, impact, mitigation, and ownership.',
    title: 'Risks and controls',
    body: '| Risk | Impact | Mitigation / control | Owner |\n| --- | --- | --- | --- |\n|  |  |  |  |'
  },
  {
    group: 'Assurance',
    type: 'evidence',
    label: 'Evidence',
    description: 'Tests, links, hashes, and review evidence.',
    title: 'Evidence',
    body: '| Evidence | Location | SHA / version | Result |\n| --- | --- | --- | --- |\n|  |  |  |  |'
  },
  {
    group: 'Assurance',
    type: 'approvals',
    label: 'Approvals',
    description: 'Required reviewers and decision notes.',
    title: 'Approval record',
    body: '| Reviewer / authority | Decision | Date | Notes |\n| --- | --- | --- | --- |\n|  | Pending |  |  |'
  },
  {
    group: 'Flexible',
    type: 'custom',
    label: 'Custom section',
    description: 'A blank section for organization-specific content.',
    title: 'New section',
    body: 'Add guidance or placeholders for this section.'
  }
];

function inferType(title) {
  const normalized = slug(title);
  return ARTIFACT_SECTION_LIBRARY.find((item) => slug(item.title) === normalized)?.type ?? 'custom';
}

export function parseArtifactTemplate(content) {
  const source = normalize(content);
  const headings = [];
  const lines = source.split('\n');
  let offset = 0;
  let fence = null;
  for (const line of lines) {
    const fenceMatch = line.match(/^[ \t]*(```+|~~~+)/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fence === fenceMatch[1][0]) fence = null;
    } else if (!fence) {
      const heading = line.match(/^##[ \t]+(.+?)[ \t]*$/);
      if (heading) headings.push({ index: offset, length: line.length, title: heading[1].trim() });
    }
    offset += line.length + 1;
  }
  if (!headings.length) return { preamble: source.trimEnd(), sections: [] };
  const sections = headings.map((heading, index) => {
    const bodyStart = heading.index + heading.length;
    const bodyEnd = headings[index + 1]?.index ?? source.length;
    const title = heading.title;
    return {
      id: `section-${index + 1}-${slug(title)}`,
      type: inferType(title),
      title,
      body: source.slice(bodyStart, bodyEnd).replace(/^\n+/, '').trimEnd()
    };
  });
  return {
    preamble: source.slice(0, headings[0].index).trimEnd(),
    sections
  };
}

export function serializeArtifactTemplate(document) {
  const chunks = [];
  const preamble = normalize(document?.preamble).trim();
  if (preamble) chunks.push(preamble);
  for (const section of document?.sections ?? []) {
    const title = String(section.title ?? '').trim() || 'Untitled section';
    const body = normalize(section.body).trim();
    chunks.push(`## ${title}${body ? `\n\n${body}` : ''}`);
  }
  return chunks.length ? `${chunks.join('\n\n')}\n` : '';
}

export function addArtifactSection(document, type, targetIndex = document.sections.length) {
  const definition = ARTIFACT_SECTION_LIBRARY.find((item) => item.type === type);
  if (!definition) throw new Error(`Unknown artifact section type '${type}'.`);
  const existing = new Set(document.sections.map((section) => section.id));
  let suffix = 1;
  let id = `${type}-${suffix}`;
  while (existing.has(id)) id = `${type}-${++suffix}`;
  const section = { id, type, title: definition.title, body: definition.body };
  const sections = [...document.sections];
  sections.splice(Math.max(0, Math.min(targetIndex, sections.length)), 0, section);
  return { ...document, sections };
}

export function moveArtifactSection(document, sectionId, targetIndex) {
  const sourceIndex = document.sections.findIndex((section) => section.id === sectionId);
  if (sourceIndex < 0) return document;
  const sections = [...document.sections];
  const [section] = sections.splice(sourceIndex, 1);
  const adjusted = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  sections.splice(Math.max(0, Math.min(adjusted, sections.length)), 0, section);
  return { ...document, sections };
}

export function updateArtifactSection(document, sectionId, patch) {
  return {
    ...document,
    sections: document.sections.map((section) => section.id === sectionId ? { ...section, ...patch } : section)
  };
}

export function removeArtifactSection(document, sectionId) {
  return { ...document, sections: document.sections.filter((section) => section.id !== sectionId) };
}
