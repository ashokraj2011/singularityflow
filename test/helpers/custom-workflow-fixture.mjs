import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { renderPreservingFormatting } from '../../src/yaml-formatting.mjs';

/**
 * A team's own workflow, written the way teams write them (steps fmly-*), with what makes it heavy:
 * - fmly-testing-again does what fmly-testing does (same agent, output, template and sign-off);
 * - fmly-notes is a document no later step reads and nobody signs off;
 * - the decision after fmly-testing only sends work back (to fmly-build, or to itself), so a passing
 *   run never reaches the end: `workflow validate` reports it as a problem;
 * - the agent fmly-legacy drafts a step no workflow has (CHECK_AGENT_UNUSED).
 * Call after `singularity-flow init`, repositoryOwnedWorkflows and requirementsTemplatePlansCode.
 * `loop: false` leaves the decision out; `requirementsTemplate` gives fmly-requirements a template of
 * the team's own (singularity/templates/fmly/requirements.md) with that text.
 */
export async function addFamilyWorkflow(root, { loop = true, requirementsTemplate = null } = {}) {
  const file = path.join(root, 'singularity', 'workflow.yml');
  const original = await readFile(file, 'utf8');
  const document = YAML.parseDocument(original);
  const testing = (id) => ({
    label: 'Family testing',
    defaultTemplate: 'common/verification.md',
    artifact: { path: `artifacts/${id}/test-evidence.md`, kind: 'test-evidence', minimumBytes: 300 },
    writeScope: 'source-and-artifact',
    approval: { authorities: ['quality-reviewers'], minimum: 1, rejectTo: ['fmly-build', id] },
    qualityCommands: []
  });
  const phases = {
    'fmly-requirements': {
      label: 'Family requirements', defaultTemplate: requirementsTemplate == null ? 'feature/requirements.md' : 'fmly/requirements.md',
      artifact: { path: 'artifacts/fmly-requirements/requirements.md', kind: 'requirements', minimumBytes: 300 },
      writeScope: 'artifact-only', approval: { authorities: ['product-approvers'], minimum: 1, rejectTo: ['intake', 'fmly-requirements'] }
    },
    'fmly-build': {
      label: 'Family build', defaultTemplate: 'common/implementation.md',
      artifact: { path: 'artifacts/fmly-build/implementation-summary.md', kind: 'implementation-summary', minimumBytes: 250 },
      generation: { task: 'code' }, writeScope: 'source-and-artifact',
      approval: { authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['fmly-requirements', 'fmly-build'] }, qualityCommands: []
    },
    'fmly-notes': {
      label: 'Team notes', defaultTemplate: 'fmly/notes.md',
      artifact: { path: 'artifacts/fmly-notes/notes.md', kind: 'team-notes', minimumBytes: 50 },
      writeScope: 'artifact-only', approval: 'none'
    },
    'fmly-testing': testing('fmly-testing'),
    'fmly-testing-again': testing('fmly-testing-again'),
    'fmly-release': {
      label: 'Family release check', defaultTemplate: 'common/conformance.md',
      artifact: { path: 'artifacts/fmly-release/spec-code-comparison.md', kind: 'conformance-report', minimumBytes: 400 },
      writeScope: 'artifact-only',
      comparison: { identifiers: ['acceptance-criteria', 'specification'], verdicts: ['matched', 'partial', 'missing', 'deviated', 'unplanned'] },
      approval: { authorities: ['quality-reviewers'], minimum: 1, rejectTo: ['fmly-build', 'fmly-release'] }
    },
    'fmly-legacy-review': {
      label: 'Legacy review', defaultTemplate: 'fmly/notes.md',
      artifact: { path: 'artifacts/fmly-legacy-review/notes.md', kind: 'team-notes', minimumBytes: 50 },
      writeScope: 'artifact-only', approval: 'none'
    }
  };
  for (const [id, value] of Object.entries(phases)) document.setIn(['phases', id], document.createNode(value));
  document.setIn(['workTypes', 'fmly'], document.createNode({
    label: 'Family delivery',
    description: 'How the family team ships a change.',
    phases: ['intake', 'fmly-requirements', 'fmly-build', 'fmly-notes', 'fmly-testing', 'fmly-testing-again', 'fmly-release'],
    plannedClaims: { mode: 'required', clausePhases: ['fmly-requirements'], owners: { 'fmly-build': 'fmly-requirements' } },
    phaseOverrides: {
      'fmly-requirements': { inputs: ['intake'] },
      'fmly-build': { inputs: ['fmly-requirements'] },
      'fmly-notes': { inputs: ['fmly-build'] },
      'fmly-testing': { inputs: ['fmly-requirements', 'fmly-build'] },
      'fmly-testing-again': { inputs: ['fmly-requirements', 'fmly-build'] },
      'fmly-release': { inputs: ['fmly-requirements', 'fmly-build', 'fmly-testing', 'fmly-testing-again'] }
    },
    decisions: !loop ? [] : [{
      id: 'fmly-test-result', after: 'fmly-testing', kind: 'branch', label: 'Did the tests pass?',
      inputs: [{ name: 'verdict', label: 'Test verdict', values: ['fail', 'recheck'] }],
      routes: [
        { id: 'fix', label: 'Fix the code', when: { verdict: 'fail' }, to: 'fmly-build' },
        { id: 'recheck', label: 'Test again', to: 'fmly-testing' }
      ],
      maxRounds: 2, by: ['quality-reviewers']
    }]
  }));
  await writeFile(file, renderPreservingFormatting(original, document));
  const templates = path.join(root, 'singularity', 'templates', 'fmly');
  await mkdir(templates, { recursive: true });
  await writeFile(path.join(templates, 'notes.md'), '# Team notes\n\n## What we noticed\n\nTODO\n');
  if (requirementsTemplate != null) await writeFile(path.join(templates, 'requirements.md'), requirementsTemplate);
  const agent = (name, label, steps, description) => ['---', `name: ${name}`, `description: ${description}`, 'model: [auto]',
    'tools: [read, search, edit, execute]', 'metadata:', `  sflow-label: "${label}"`, `  sflow-phases: "${steps}"`, `  sflow-default-for: "${steps}"`, '---', '',
    `# ${label}`, '', `${description}`, ''].join('\n');
  await writeFile(path.join(root, '.github', 'agents', 'fmly-engineer.agent.md'),
    agent('fmly-engineer', 'Family engineer', 'fmly-requirements,fmly-build,fmly-notes,fmly-testing,fmly-testing-again,fmly-release', 'Drafts every step of the family team\'s delivery.'));
  await writeFile(path.join(root, '.github', 'agents', 'fmly-legacy.agent.md'),
    agent('fmly-legacy', 'Family legacy reviewer', 'fmly-legacy-review', 'Reviewed changes before the team had a workflow.'));
}
