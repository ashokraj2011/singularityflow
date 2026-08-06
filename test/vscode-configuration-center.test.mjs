import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(root, 'apps', 'vscode', 'src', 'views', name);
const {
  configurationCenterView,
  updateAuthorityYaml,
  updateMcpYaml,
  validateAuthorityDraft,
  validateMcpDraft
} = await import(source('configuration-center-model.ts'));
const { configurationCenterHtml } = await import(source('configuration-center-page.ts'));

const snapshot = {
  definition: {
    phases: { intake: { label: 'Intake' }, verification: { label: 'Verification' } },
    approvalAuthorities: {
      'quality-reviewers': {
        label: 'Quality reviewers',
        members: [{ name: 'Quinn', email: 'quinn@example.com', githubLogin: 'quinn' }]
      }
    }
  },
  portfolio: {
    approvalAuthorities: {
      'initiative-owners': { members: [{ name: 'Pat', email: 'pat@example.com' }] }
    }
  },
  agents: [{ id: 'qa' }, { id: 'developer' }],
  mcp: {
    servers: [{
      id: 'playwright', label: 'Playwright', hostReference: 'playwright', agents: ['qa'],
      phases: ['verification'], tools: ['browser_snapshot'], required: false, approval: 'confirm',
      configured: true, sources: ['vscode-workspace'], evidence: { captureToolCalls: true, captureResults: true }
    }],
    errors: [], warnings: []
  }
};

test('configuration center keeps human authorities distinct from governed agents', () => {
  const view = configurationCenterView(snapshot, { name: 'Ashok', role: 'architect' });
  assert.deepEqual(view.agents.map((entry) => entry.id), ['developer', 'qa']);
  assert.deepEqual(view.authorities.map((entry) => `${entry.scope}:${entry.id}`), [
    'initiative:initiative-owners', 'story:quality-reviewers'
  ]);
  const html = configurationCenterHtml(view, 'people', null, null, null, []);
  assert.match(html, /People are not agents/);
  assert.match(html, /real Git email or authenticated GitHub login/);
});

test('MCP editor changes only the governed server registry and preserves YAML comments', () => {
  const input = `version: 2\n# keep this policy note\ngit:\n  publish: required\nmcpServers:\n  old:\n    label: Old\n    hostReference: old\n`;
  const output = updateMcpYaml(input, {
    previousId: 'old', id: 'playwright', label: 'Playwright', hostReference: 'playwright',
    agents: ['qa'], phases: ['verification'], tools: ['browser_snapshot'], required: true,
    approval: 'confirm', captureToolCalls: true, captureResults: true
  });
  assert.match(output, /# keep this policy note/);
  const parsed = YAML.parse(output);
  assert.equal(parsed.git.publish, 'required');
  assert.equal(parsed.mcpServers.old, undefined);
  assert.deepEqual(parsed.mcpServers.playwright.agents, ['qa']);
  assert.equal(parsed.mcpServers.playwright.evidence.captureResults, true);
});

test('approval editor preserves unrelated workflow content and normalizes identities', () => {
  const input = `version: 2\nphases:\n  intake:\n    label: Intake\napprovalAuthorities: {}\n`;
  const output = updateAuthorityYaml(input, {
    id: 'product-approvers', previousId: '', label: 'Product approvers', scope: 'story',
    allowAnyGitIdentity: false,
    members: [{ name: 'Pat Owner', email: 'PAT@EXAMPLE.COM', githubLogin: 'pat-owner' }]
  });
  const parsed = YAML.parse(output);
  assert.equal(parsed.phases.intake.label, 'Intake');
  assert.deepEqual(parsed.approvalAuthorities['product-approvers'].members, [{
    name: 'Pat Owner', email: 'pat@example.com', githubLogin: 'pat-owner'
  }]);
});

test('Initiative approval editor keeps advanced fields and writes only supported identity data', () => {
  const input = `version: 1\napprovalAuthorities:\n  owners:\n    githubTeams: [\"@example/owners\"]\n    members: []\n`;
  const output = updateAuthorityYaml(input, {
    id: 'owners', previousId: 'owners', label: 'Initiative owners', scope: 'initiative',
    allowAnyGitIdentity: false,
    members: [{ name: 'Pat Owner', email: 'PAT@EXAMPLE.COM', githubLogin: 'not-an-initiative-identity' }]
  });
  const parsed = YAML.parse(output);
  assert.equal(parsed.approvalAuthorities.owners.label, 'Initiative owners');
  assert.deepEqual(parsed.approvalAuthorities.owners.githubTeams, ['@example/owners']);
  assert.deepEqual(parsed.approvalAuthorities.owners.members, [{ name: 'Pat Owner', email: 'pat@example.com' }]);
});

test('configuration drafts reject ambiguous approval identities and unsafe MCP identifiers', () => {
  assert.deepEqual(validateAuthorityDraft({
    id: 'owners', label: 'Owners', scope: 'initiative', allowAnyGitIdentity: false, members: []
  }), ['Initiative authorities require at least one named Git identity.']);
  assert.deepEqual(validateAuthorityDraft({
    id: 'owners', label: 'Owners', scope: 'initiative', allowAnyGitIdentity: true, members: []
  }), ['Initiative authorities require at least one named Git identity.']);
  assert.deepEqual(validateAuthorityDraft({
    id: 'owners', label: 'Owners', scope: 'story', allowAnyGitIdentity: false, members: []
  }), ['Add a member or allow any configured Git identity.']);
  assert.deepEqual(validateAuthorityDraft({
    id: 'owners', label: 'Owners', scope: 'story', allowAnyGitIdentity: false,
    members: [{ name: 'GitHub reviewer', email: '', githubLogin: 'reviewer' }]
  }), []);
  assert.match(validateMcpDraft({
    id: 'Bad ID', label: '', hostReference: '../host', agents: [], phases: [], tools: ['a', 'a'],
    required: false, approval: 'confirm', captureToolCalls: true, captureResults: false
  }).join(' '), /lower-case kebab-case.*display label.*Host reference.*duplicates/);
});
