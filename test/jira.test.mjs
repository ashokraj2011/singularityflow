import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adfToText, assignIssue, getIssue, issueToMarkdown, listBoardStories, listBoards, listFields,
  listIssueTransitions, listMyIssues, moveIssueToSprint, normalizeIssue, setIssuePriority, transitionIssue
} from '../src/jira.mjs';

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
    return response({ id: url.includes('/issue/10042') ? '10042' : '10001', key: 'ENG-7', fields: { summary: 'Build feature', status: { name: 'To Do' } } });
  };
  const issue = await getIssue('ENG-7', { env, fetchImpl });
  const issueById = await getIssue('10042', { env, fetchImpl });
  const list = await listMyIssues({ env, fetchImpl, project: 'ENG' });
  assert.equal(issue.key, 'ENG-7');
  assert.equal(issueById.key, 'ENG-7');
  assert.equal(list.issues.length, 1);
  assert.match(calls[0].url, /\/rest\/api\/3\/issue\/ENG-7/);
  assert.match(calls[0].url, /expand=names/);
  assert.match(calls[1].url, /\/rest\/api\/3\/issue\/10042/);
  assert.match(calls[2].url, /\/rest\/api\/3\/search\/jql/);
  assert.equal(calls[2].options.method, 'POST');
  assert.match(calls[2].options.body, /currentUser/);
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

test('board Story listing reads active and future sprints without querying backlog', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/rest/agile/1.0/board?')) {
      return response({
        values: [{ id: 42, name: 'Delivery board', type: 'scrum', location: { projectKey: 'ENG', projectName: 'Engineering' } }],
        isLast: true
      });
    }
    if (url.includes('/rest/agile/1.0/board/42/sprint?')) {
      return response({
        values: [
          { id: 7, name: 'Sprint 7', state: 'active' },
          { id: 8, name: 'Sprint 8', state: 'future' }
        ],
        isLast: true
      });
    }
    if (url.includes('/sprint/7/issue?')) {
      return response({
        issues: [{ key: 'ENG-7', fields: { summary: 'Active Story', status: { name: 'In Progress' }, issuetype: { name: 'Story' } } }],
        isLast: true
      });
    }
    if (url.includes('/sprint/8/issue?')) {
      return response({
        issues: [{ key: 'ENG-8', fields: { summary: 'Future Story', status: { name: 'To Do' }, issuetype: { name: 'Story' } } }],
        isLast: true
      });
    }
    throw new Error(`Unexpected Jira URL: ${url}`);
  };

  const boards = await listBoards({ env, fetchImpl, project: 'ENG' });
  const result = await listBoardStories('42', { env, fetchImpl });

  assert.equal(boards[0].location.projectKey, 'ENG');
  assert.deepEqual(result.sprintStates, ['active', 'future']);
  assert.equal(result.backlogIncluded, false);
  assert.equal(result.totalIssues, 2);
  assert.equal(result.sprints[0].issues[0].sprints[0].name, 'Sprint 7');
  assert.equal(result.sprints[1].issues[0].sprints[0].name, 'Sprint 8');
  assert.ok(calls.every((call) => !call.url.includes('/backlog')));
  assert.match(calls.find((call) => call.url.includes('/sprint/7/issue?')).url, /jql=issuetype\+%3D\+%22Story%22/);
});

test('transitionIssue requires an exact available transition without required screen fields', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/transitions?')) {
      return response({
        transitions: [
          { id: '21', name: 'Start Progress', to: { name: 'In Progress', statusCategory: { name: 'In Progress' } }, fields: {} },
          { id: '31', name: 'Resolve', to: { name: 'Done' }, fields: { resolution: { name: 'Resolution', required: true } } }
        ]
      });
    }
    if (url.endsWith('/transitions') && options.method === 'POST') return response(null, 204);
    if (url.includes('/rest/api/3/issue/ENG-7?')) {
      return response({ id: '10007', key: 'ENG-7', fields: { summary: 'Story', status: { name: 'In Progress' } } });
    }
    throw new Error(`Unexpected Jira URL: ${url}`);
  };

  const transitions = await listIssueTransitions('ENG-7', { env, fetchImpl });
  assert.equal(transitions.length, 2);
  const result = await transitionIssue('ENG-7', 'In Progress', { env, fetchImpl });
  assert.equal(result.transition.id, '21');
  assert.equal(result.issue.status, 'In Progress');
  assert.deepEqual(JSON.parse(calls.find((call) => call.options.method === 'POST').options.body), { transition: { id: '21' } });
  await assert.rejects(
    transitionIssue('ENG-7', 'Done', { env, fetchImpl }),
    /requires fields that this command cannot safely infer: Resolution/
  );
});

test('assignment, priority, and sprint updates use their dedicated Jira endpoints', async () => {
  const calls = [];
  const issuePayload = {
    id: '10007',
    key: 'ENG-7',
    fields: {
      summary: 'Story',
      status: { name: 'In Progress' },
      priority: { name: 'High' },
      assignee: { accountId: 'a-1', displayName: 'Developer One' }
    }
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/rest/api/3/myself')) return response({ accountId: 'a-1', displayName: 'Developer One' });
    if (url.includes('/rest/api/3/issue/ENG-7?')) return response(issuePayload);
    if (options.method === 'PUT' || options.method === 'POST') return response(null, 204);
    throw new Error(`Unexpected Jira URL: ${url}`);
  };

  await assignIssue('ENG-7', 'me', { env, fetchImpl });
  await setIssuePriority('ENG-7', 'High', { env, fetchImpl });
  await moveIssueToSprint('ENG-7', '8', { env, fetchImpl });

  const assignment = calls.find((call) => call.url.endsWith('/issue/ENG-7/assignee'));
  const priority = calls.find((call) => call.url.endsWith('/issue/ENG-7'));
  const sprint = calls.find((call) => call.url.endsWith('/rest/agile/1.0/sprint/8/issue'));
  assert.deepEqual(JSON.parse(assignment.options.body), { accountId: 'a-1' });
  assert.deepEqual(JSON.parse(priority.options.body), { fields: { priority: { name: 'High' } } });
  assert.deepEqual(JSON.parse(sprint.options.body), { issues: ['ENG-7'] });
});
