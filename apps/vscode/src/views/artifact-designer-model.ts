/** The small vocabulary used by the visual artifact-template builder. */
export type ArtifactSectionKind =
  | 'narrative' | 'requirements' | 'acceptance-criteria' | 'decision-log'
  | 'risk-register' | 'checklist' | 'open-questions' | 'evidence';

export interface ArtifactSection {
  id: string;
  kind: ArtifactSectionKind;
  title: string;
  guidance: string;
}

export interface ArtifactDraft {
  /**
   * Which lifecycle the template is written for. Kept, and it is not a phase link: it decides the
   * document heading — `{{work.id}}` for a Story, the initiative metadata block for an Initiative —
   * so the same template cannot be used for both.
   */
  governs: 'story' | 'initiative';
  outputId: string;
  outputLabel: string;
  outputPath: string;
  fileName: string;
  title: string;
  purpose: string;
  sections: ArtifactSection[];
}

export const SECTION_CATALOG: Array<{
  kind: ArtifactSectionKind;
  label: string;
  description: string;
  defaultTitle: string;
  guidance: string;
}> = [
  { kind: 'narrative', label: 'Narrative', description: 'A guided prose section.',
    defaultTitle: 'Context', guidance: 'State the facts, constraints, and boundaries relevant to this decision.' },
  { kind: 'requirements', label: 'Requirements', description: 'Stable, traceable requirement identifiers.',
    defaultTitle: 'Requirements', guidance: 'Use stable REQ-nnn identifiers and cite the governed source for every requirement.' },
  { kind: 'acceptance-criteria', label: 'Acceptance criteria', description: 'Testable Given / When / Then outcomes.',
    defaultTitle: 'Acceptance criteria', guidance: 'Map each AC-nnn to one or more requirements and make the outcome observable.' },
  { kind: 'decision-log', label: 'Decision log', description: 'Decisions, rationale, owner, and status.',
    defaultTitle: 'Decisions', guidance: 'Record decisions that constrain implementation and why the alternatives were rejected.' },
  { kind: 'risk-register', label: 'Risk register', description: 'Impact, likelihood, mitigation, and owner.',
    defaultTitle: 'Risks and mitigations', guidance: 'Capture material delivery, operational, security, and compliance risks.' },
  { kind: 'checklist', label: 'Checklist', description: 'A reviewable completion checklist.',
    defaultTitle: 'Completion checklist', guidance: 'Keep every check independently verifiable and name the expected evidence.' },
  { kind: 'open-questions', label: 'Open questions', description: 'Unresolved questions with owners and blocking impact.',
    defaultTitle: 'Open questions', guidance: 'Do not hide assumptions here: name an owner and whether each question blocks progress.' },
  { kind: 'evidence', label: 'Evidence', description: 'Approved inputs and exact supporting references.',
    defaultTitle: 'Evidence', guidance: 'The managed inputs block is injected here when the phase is prepared.' }
];

let sequence = 0;

export function sectionFor(kind: ArtifactSectionKind): ArtifactSection {
  const preset = SECTION_CATALOG.find((entry) => entry.kind === kind) ?? SECTION_CATALOG[0]!;
  sequence += 1;
  return { id: `section-${sequence}`, kind: preset.kind, title: preset.defaultTitle, guidance: preset.guidance };
}

export function newArtifactDraft(): ArtifactDraft {
  return {
    governs: 'initiative',
    outputId: '',
    outputLabel: '',
    outputPath: '',
    fileName: '',
    title: '',
    purpose: '',
    sections: [sectionFor('narrative'), sectionFor('decision-log'), sectionFor('open-questions'), sectionFor('evidence')]
  };
}

function sectionMarkdown(section: ArtifactSection): string {
  const guidance = section.guidance.trim() ? `> ${section.guidance.trim()}\n\n` : '';
  switch (section.kind) {
    case 'requirements':
      return `${guidance}### REQ-001\n\n- Statement:\n- Rationale:\n- Priority: Must / Should / Could\n- Source citations:\n- Verification method:\n`;
    case 'acceptance-criteria':
      return `${guidance}### AC-001\n\n- Given:\n- When:\n- Then:\n- Requirements: REQ-001\n- Source citations:\n`;
    case 'decision-log':
      return `${guidance}| ID | Decision | Rationale | Owner | Status |\n| --- | --- | --- | --- | --- |\n| DEC-001 | | | | Proposed |\n`;
    case 'risk-register':
      return `${guidance}| ID | Risk | Impact | Likelihood | Mitigation | Owner |\n| --- | --- | --- | --- | --- | --- |\n| RISK-001 | | | | | |\n`;
    case 'checklist':
      return `${guidance}- [ ] Check — evidence:\n`;
    case 'open-questions':
      return `${guidance}| Question | Blocks | Owner | Resolution |\n| --- | --- | --- | --- |\n| | Yes / No | | |\n`;
    case 'evidence':
      return `${guidance}{{inputs}}\n`;
    default:
      return `${guidance}TODO: Author this section from approved evidence.\n`;
  }
}

/** Render exactly what is committed under `singularity/templates`. */
export function renderArtifactTemplate(draft: ArtifactDraft): string {
  const title = draft.title.trim() || draft.outputLabel.trim() || draft.outputId.trim() || 'Artifact';
  const heading = draft.governs === 'story'
    ? `# {{work.id}} — ${title}`
    : `<!-- singularity-flow:initiative-metadata\n{{metadata}}\n-->\n\n# {{initiative.id}} — ${title}`;
  const purpose = draft.purpose.trim()
    ? `${draft.purpose.trim()}\n`
    : 'State what decision this artifact supports and what would make it incomplete.\n';
  const sections = draft.sections.map((section) => `## ${section.title.trim() || 'Untitled section'}\n\n${sectionMarkdown(section)}`).join('\n');
  return `${heading}\n\n${purpose}\n${sections}`.trimEnd() + '\n';
}

/** A relative `.md` path that stays where it was put: no absolute root, no segment that climbs. */
export function safeRelativeMarkdownPath(value: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/.test(value)) return false;
  return !value.split('/').includes('..');
}

export function validateArtifactDraft(draft: ArtifactDraft): string[] {
  const errors: string[] = [];
  const id = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (!id.test(draft.outputId)) errors.push('Output ID must be lower-case kebab-case.');
  if (!draft.outputLabel.trim()) errors.push('Give the artifact a reader-facing label.');
  // The character class allows `.` and `/`, so `a/../../b.md` passed as a "safe .md path". The
  // engine refuses anything that resolves outside the repository, so this never escaped — but a
  // within-repo hop did, writing into a sibling root instead of the one the form names. A path
  // that climbs is not what this claims to be checking for.
  if (!safeRelativeMarkdownPath(draft.fileName)) errors.push('Template file must be a safe .md path without "..".');
  if (!safeRelativeMarkdownPath(draft.outputPath)) errors.push('Generated artifact path must be a safe .md path without "..".');
  if (!draft.sections.length) errors.push('Add at least one section.');
  if (new Set(draft.sections.map((section) => section.title.trim().toLowerCase())).size !== draft.sections.length) {
    errors.push('Section headings must be unique.');
  }
  return errors;
}
