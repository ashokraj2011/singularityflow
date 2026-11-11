/**
 * A team's own workflow, as a repository would hold it: three custom steps (family requirements, code
 * and testing) with their own templates and their own agent, built on the shipped approval groups.
 * test/workflow-walk.test.mjs walks it clean, then walks variants a team could write by mistake.
 */
export const FAMILY_FILES = Object.freeze({
  'singularity/templates/fmly/requirements.md': ['# {{work.id}} — Family requirements', '', '## Problem', '', 'TODO: State the problem in one or two sentences.', '',
    '## Requirements', '', '| Clause | Requirement |', '|---|---|', '| [{{work.id}}:REQ-001] | TODO: State one testable requirement. |', '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    '| `{{work.id}}:REQ-001` | TODO: replace with exact backticked repository-relative source paths | TODO: replace with exact backticked repository-relative test paths | new |', '',
    '## Out of scope', '', 'TODO: State what stays unchanged.', ''].join('\n'),
  'singularity/templates/fmly/code.md': ['# {{work.id}} — Family code', '', '## Agent brief', '', 'TODO: Summarize what changed and why.', '',
    '## Changed components', '', 'TODO: List each changed file and what it now does.', '', '## Tests', '', 'TODO: Name the tests that prove each requirement.', ''].join('\n'),
  'singularity/templates/fmly/testing.md': ['# {{work.id}} — Family testing', '', '## Agent brief', '', 'TODO: Summarize the test verdict.', '',
    '## Test results', '', "TODO: Cite the code step's committed test receipts and what each proves.", '', '## Residual risk', '', 'TODO: State remaining gaps.', ''].join('\n'),
  '.github/agents/fmly-delivery.agent.md': ['---', 'name: fmly-delivery', "description: Drafts the family team's requirements, code and testing steps.", 'model: [auto]',
    'tools: [read, search, edit, execute, bash, ask_user]', 'metadata:', '  sflow-label: "Family delivery"', '  sflow-phases: "fmly-requirements,fmly-code,fmly-testing"',
    '  sflow-default-for: "fmly-requirements,fmly-code,fmly-testing"', '  sflow-model-task: "code"', '---', '', '# Family delivery agent', '',
    'Draft the step you are given from its template and the approved inputs; never guess an answer a person owns.', ''].join('\n')
});

/** Adds the `family-delivery` workflow to a parsed workflow.yml; `requirements`, `code`, `testing` override a step. */
export function familyWorkflow(configuration, { requirements = {}, code = {}, testing = {} } = {}) {
  configuration.phases['fmly-requirements'] = { label: 'Family requirements', defaultTemplate: 'fmly/requirements.md',
    artifact: { path: 'artifacts/fmly-requirements/requirements.md', kind: 'requirements', minimumBytes: 200 },
    clarification: { mode: 'when-needed', maxQuestions: 3, topics: ['scope', 'acceptance criteria'] }, writeScope: 'artifact-only',
    approval: { authorities: ['product-approvers'], minimum: 1, rejectTo: ['fmly-requirements'] }, ...requirements };
  configuration.phases['fmly-code'] = { label: 'Family code', defaultTemplate: 'fmly/code.md',
    artifact: { path: 'artifacts/fmly-code/implementation-summary.md', kind: 'implementation-summary', minimumBytes: 200 },
    clarification: { mode: 'when-needed', maxQuestions: 3, topics: ['implementation blockers'] }, generation: { task: 'code' }, writeScope: 'source-and-artifact',
    approval: { authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['fmly-requirements', 'fmly-code'] }, qualityCommands: [], ...code };
  configuration.phases['fmly-testing'] = { label: 'Family testing', defaultTemplate: 'fmly/testing.md',
    artifact: { path: 'artifacts/fmly-testing/test-evidence.md', kind: 'test-evidence', minimumBytes: 200 },
    clarification: { mode: 'off' }, writeScope: 'artifact-only', testEvidenceFrom: 'fmly-code',
    approval: { authorities: ['quality-reviewers'], minimum: 1, rejectTo: ['fmly-code', 'fmly-testing'] }, ...testing };
  configuration.workTypes['family-delivery'] = { label: 'Family delivery', description: "A team's own requirements, code and testing steps.",
    phases: ['fmly-requirements', 'fmly-code', 'fmly-testing'],
    plannedClaims: { mode: 'required', clausePhases: ['fmly-requirements'], owners: { 'fmly-code': 'fmly-requirements' } },
    phaseOverrides: { 'fmly-code': { inputs: ['fmly-requirements'] }, 'fmly-testing': { inputs: ['fmly-requirements', 'fmly-code'] } } };
  return configuration;
}

/** The code step's only test command, one this machine cannot start. */
export const MISSING_TEST_COMMAND = Object.freeze([{ id: 'unit', kind: 'test', modelPolicy: 'never', argv: ['walk-missing-test-runner', '--reporter=tap'],
  workingDirectory: '.', affectedRoots: ['.'], result: { adapter: 'node-tap', path: '.sflow/results/unit.tap' } }]);
