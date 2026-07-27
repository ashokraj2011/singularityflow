import test from 'node:test';
import assert from 'node:assert/strict';
import { jiraDoctorText } from '../src/jira-doctor.mjs';

test('Jira doctor text separates workspace, policy, credentials, connection, project checks, and remediation', () => {
  const text = jiraDoctorText({
    ok: false,
    workspace: { active: true, name: 'Payments', selectedRepository: 'api' },
    policy: { configured: true, enabled: true, writeMode: 'preview' },
    credentials: { missing: ['JIRA_API_TOKEN'], deployment: 'cloud' },
    connection: { connected: true, baseUrl: 'https://example.atlassian.net', account: { displayName: 'Ada' } },
    projects: [{
      key: 'PAY',
      visible: true,
      permissions: { granted: ['BROWSE_PROJECTS'], total: 2 },
      boards: [{ id: 1 }],
      epics: { visible: 3 },
      errors: ['Permissions: CREATE_ISSUES denied']
    }],
    remediation: ['Request Create Issues access.']
  });
  assert.match(text, /Jira doctor: ATTENTION REQUIRED/);
  assert.match(text, /Workspace: Payments \(api\)/);
  assert.match(text, /Policy: enabled · preview/);
  assert.match(text, /missing JIRA_API_TOKEN/);
  assert.match(text, /Connection: Ada · https:\/\/example.atlassian.net/);
  assert.match(text, /Project PAY: visible · permissions 1\/2 · boards 1 · epics 3/);
  assert.match(text, /Request Create Issues access/);
});

test('Jira doctor text reports a ready configuration', () => {
  const text = jiraDoctorText({
    ok: true,
    workspace: { active: true, name: 'Payments', selectedRepository: 'api' },
    policy: { configured: true, enabled: true, writeMode: 'approved' },
    credentials: { missing: [], deployment: 'data-center' },
    connection: { connected: true, baseUrl: 'https://jira.example.com', account: { id: 'ada' } },
    projects: [],
    remediation: []
  });
  assert.match(text, /Jira doctor: READY/);
  assert.match(text, /available \(data-center\)/);
  assert.doesNotMatch(text, /Next actions/);
});
