import test from 'node:test';
import assert from 'node:assert/strict';
import { adfToText, getIssue, issueToMarkdown, listFields, listMyIssues, normalizeIssue } from '../src/jira.mjs';

const env = {
  JIRA_BASE_URL: 'https://example.atlassian.net',
  JIRA_EMAIL: 'dev@example.com',
  JIRA_API_TOKEN: 'test-token',
  SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD: 'customfield_10000',
  SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD: 'customfield_10016',
  SINGULARITY_FLOW_JIRA_SPRINT_FIELD: 'customfield_10020'
};

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); }
  };
}

test('adfToText extracts paragraphs and hard breaks', () => {
  const adf = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'First' }, { type: 'hardBreak' }, { type: 'text', text: 'Second' }] }
  ] };
  assert.equal(adfToText(adf), 'First\nSecond');
});

test('normalizeIssue creates repository-safe source context', () => {
  const issue = normalizeIssue({
    key: 'ENG-7',
    fields: {
      summary: 'Build feature',
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Description' }] }] },
      status: { name: 'To Do', statusCategory: { name: 'To Do' } },
      priority: { name: 'High' },
      assignee: { accountId: 'a-1', displayName: 'Developer One' },
      reporter: { accountId: 'r-1', displayName: 'Product Owner' },
      issuetype: { name: 'Story' },
      project: { id: '10000', key: 'ENG', name: 'Engineering' },
      labels: ['backend'],
      components: [{ name: 'Payments' }],
      customfield_10000: 'Criterion one',
      customfield_10016: 5,
      customfield_10020: [{ id: 7, name: 'Sprint 12', state: 'active' }],
      subtasks: [{ key: 'ENG-8', fields: { summary: 'Add tests', status: { name: 'To Do' }, issuetype: { name: 'Sub-task' } } }],
      issuelinks: [{ type: { outward: 'blocks' }, outwardIssue: { key: 'ENG-9', fields: { summary: 'Dependency', status: { name: 'In Progress' } } } }]
    }
  }, {
    baseUrl: env.JIRA_BASE_URL,
    acceptanceField: 'customfield_10000',
    storyPointsField: 'customfield_10016',
    sprintField: 'customfield_10020'
  });
  assert.equal(issue.key, 'ENG-7');
  assert.equal(issue.description, 'Description');
  assert.equal(issue.acceptanceCriteria, 'Criterion one');
  assert.equal(issue.storyPoints, 5);
  assert.equal(issue.sprints[0].name, 'Sprint 12');
  assert.equal(issue.subtasks[0].key, 'ENG-8');
  assert.equal(issue.issueLinks[0].issue.key, 'ENG-9');
  assert.equal(issue.url, 'https://example.atlassian.net/browse/ENG-7');

  const markdown = issueToMarkdown(issue);
  assert.match(markdown, /# ENG-7 — Build feature/);
  assert.match(markdown, /## Acceptance criteria/);
  assert.match(markdown, /Criterion one/);
  assert.match(markdown, /Story points: 5/);
  assert.match(markdown, /ENG-8/);
});

test('getIssue and listMyIssues use direct Jira REST endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/search/jql')) {
      return response({ issues: [{ key: 'ENG-7', fields: { summary: 'Build feature', status: { name: 'To Do' } } }], isLast: true });
    }
    return response({ key: 'ENG-7', fields: { summary: 'Build feature', status: { name: 'To Do' } } });
  };
  const issue = await getIssue('ENG-7', { env, fetchImpl });
  const list = await listMyIssues({ env, fetchImpl, project: 'ENG' });
  assert.equal(issue.key, 'ENG-7');
  assert.equal(list.issues.length, 1);
  assert.match(calls[0].url, /\/rest\/api\/3\/issue\/ENG-7/);
  assert.match(calls[0].url, /expand=names/);
  assert.match(calls[1].url, /\/rest\/api\/3\/search\/jql/);
  assert.equal(calls[1].options.method, 'POST');
  assert.match(calls[1].options.body, /currentUser/);
  assert.ok(calls.every((call) => call.options.headers.Authorization.startsWith('Basic ')));
});

test('listFields discovers custom Jira field IDs', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response([
      { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
      { id: 'customfield_10000', name: 'Acceptance Criteria', custom: true, schema: { type: 'string' } }
    ]);
  };
  const fields = await listFields({ env, fetchImpl, query: 'acceptance' });
  assert.equal(fields.length, 1);
  assert.equal(fields[0].id, 'customfield_10000');
  assert.match(calls[0].url, /\/rest\/api\/3\/field$/);
});
