/**
 * Each pdlc-task of the marketplace's taxonomy and the step intent it is: the table marketplace conversion
 * (agent-workflow.mjs) and a task's skills (task-skills.mjs) both read. A leaf, so a task's plan reads it without the
 * conversion's parser.
 */
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const TESTS_ARE_CODE = 'it writes tests into the repository: tests are code, which a code step writes and a person approves; running them and recording the results is a test step';

/**
 * Each pdlc-task of the marketplace's taxonomy (registry/pdlc-taxonomy.yml) and the step intent it is, with why where
 * it is not plain from the task's own name. A skill's tasks, or a stage named like one of the agent's tasks, give the
 * stage this intent. docs/marketplace-agents.md prints this table.
 */
export const AGENT_TASK_INTENTS = deepFreeze({
  'problem-framing': { intent: 'intake', because: 'it states the problem, who has it and how success is measured: the request in the requester\'s own words' },
  'requirements-analysis': { intent: 'requirements' },
  'user-story-writing': { intent: 'requirements', because: 'stories split the requirements into testable pieces that later steps cite by ID' },
  'acceptance-criteria-writing': { intent: 'requirements' },
  'test-case-creation': { intent: 'requirements', because: 'a test design document: numbered test cases traced to the acceptance criteria, which later steps cite; nothing is run yet' },
  'architecture-discovery': { intent: 'design', because: 'it maps the system as it is before anything changes, and investigation is part of design' },
  'architecture-design': { intent: 'design' },
  'decision-records': { intent: 'document', because: 'an ADR is a decision record, the kind of document the document intent names' },
  'api-implementation': { intent: 'code' },
  'ui-implementation': { intent: 'code' },
  'unit-testing': { intent: 'code', because: TESTS_ARE_CODE },
  'contract-testing': { intent: 'code', because: TESTS_ARE_CODE },
  'e2e-testing': { intent: 'code', because: TESTS_ARE_CODE },
  'ui-test-automation': { intent: 'code', because: 'test automation is code: the step changes the repository\'s test sources' },
  'feature-toggle-management': { intent: 'code', because: 'adding, changing or removing a toggle changes the code' },
  documentation: { intent: 'document' },
  'static-analysis': { intent: 'test', because: 'it runs the repository\'s analyzers and records what they found, as a test step records results' },
  'accessibility-review': { intent: 'review', because: 'it judges the delivered UI change against WCAG 2.2 AA, after the code step' },
  'coding-standards-review': { intent: 'review' },
  'security-review': { intent: 'review' },
  'pr-review': { intent: 'review' },
  'release-notes': { intent: 'release' },
  changelog: { intent: 'release' },
  'pr-description': { intent: 'release' },
  'release-readiness': { intent: 'release' }
});
