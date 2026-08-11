import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(root, 'apps', 'vscode', 'src', 'views', name);
const {
  configurationCenterView,
  configurationRefreshDecision,
  updateAuthorityYaml,
  updateMcpYaml,
  updateWorldModelYaml,
  validateAuthorityDraft,
  validateMcpDraft,
  validateWorldModelDraft
} = await import(source('configuration-center-model.ts'));
const { configurationCenterHtml, CONFIGURATION_CENTER_SCRIPT } = await import(source('configuration-center-page.ts'));

const snapshot = {
  definition: {
    phases: { intake: { label: 'Intake' }, verification: { label: 'Verification' } },
    worldModel: {
      views: ['business', 'architecture'], grounding: 'warn', staleness: 'fail',
      materialization: { mode: 'on-demand', publish: 'governed', lookahead: 'next-phase', depth: 'light', confirmation: 'automatic' },
      injection: { placeholder: '{{WORLD_MODEL}}', mode: 'append', maxBytes: 16384, rules: [{ when: { phase: 'intake' }, include: ['briefs/business.md'] }] }
    },
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

test('configuration center exposes guided world-model policy, generation, and injection settings', () => {
  const view = configurationCenterView(snapshot, { name: 'Ashok', role: 'architect' });
  assert.deepEqual(view.worldModel.views, ['business', 'architecture']);
  assert.equal(view.worldModel.materialization.confirmation, 'automatic');
  assert.equal(view.worldModel.materialization.depth, 'light');
  assert.equal(view.worldModel.injection.rulesCount, 1);
  const html = configurationCenterHtml(view, 'world-model', null, null, null, []);
  assert.match(html, /World-model behavior/);
  assert.match(html, /Grounding policy/);
  assert.match(html, /On demand — prepare when required/);
  assert.match(html, /Light — deterministic, zero model tokens/);
  assert.match(html, /Prompt injection/);
  assert.match(html, /Save world-model settings/);
});

test('configuration refresh preserves dirty forms and detects repository conflicts', () => {
  const rendered = { definitionText: 'workflow-a', portfolioText: 'portfolio-a' };
  assert.equal(configurationRefreshDecision(false, rendered, rendered), 'render');
  assert.equal(configurationRefreshDecision(true, rendered, rendered), 'hold');
  assert.equal(configurationRefreshDecision(true, rendered, { ...rendered, definitionText: 'workflow-b' }), 'conflict');
  assert.equal(configurationRefreshDecision(true, rendered, { ...rendered, portfolioText: 'portfolio-b' }), 'conflict');
});

test('configuration center reports dirty edits and offers an explicit conflict decision', () => {
  const view = configurationCenterView(snapshot, { name: 'Ashok', role: 'architect' });
  const html = configurationCenterHtml(view, 'world-model', null, null, null, []);
  assert.match(html, /configuration-runtime-message/);
  assert.match(html, /Reload newer configuration/);
  assert.match(html, /Keep editing/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /type: 'form-dirty'/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /configuration-repository-changed/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /configuration-save-error/);
});

test('world-model editor preserves comments, advanced context, and injection rules', () => {
  const input = `version: 2\n# keep this policy note\nworldModel:\n  context:\n    memoize: true\n  injection:\n    rules:\n      - when: { phase: intake }\n        include: [briefs/business.md]\n`;
  const output = updateWorldModelYaml(input, {
    views: ['business', 'architecture'], outputDir: 'singularity/world-model',
    promptSource: 'singularity/prompts/worldmodel-builder.md', stateFetchTimeoutMs: 10000,
    generation: { parallel: true, maxWorkers: 3, strategy: 'view' },
    materialization: { mode: 'on-demand', publish: 'governed', lookahead: 'none', depth: 'light', confirmation: 'automatic' },
    grounding: 'warn', staleness: 'warn',
    injection: { placeholder: '{{WORLD_MODEL}}', mode: 'append', maxBytes: 32768 }
  });
  assert.match(output, /# keep this policy note/);
  const parsed = YAML.parse(output);
  assert.equal(parsed.worldModel.context.memoize, true);
  assert.equal(parsed.worldModel.injection.rules[0].when.phase, 'intake');
  assert.equal(parsed.worldModel.materialization.mode, 'on-demand');
  assert.equal(parsed.worldModel.materialization.depth, 'light');
  assert.equal(parsed.worldModel.generation.maxWorkers, 3);
});

test('world-model editor rejects unsafe paths and unconfirmed model-driven automation', () => {
  const base = {
    views: ['business'], outputDir: 'singularity/world-model', promptSource: 'builtin',
    stateFetchTimeoutMs: 10000, generation: { parallel: true, maxWorkers: 4, strategy: 'view' },
    materialization: { mode: 'on-demand', publish: 'governed', lookahead: 'none', depth: 'phase', confirmation: 'automatic' },
    grounding: 'warn', staleness: 'warn',
    injection: { placeholder: '{{WORLD_MODEL}}', mode: 'append', maxBytes: 32768 }
  };
  assert.match(validateWorldModelDraft(base).join(' '), /Automatic materialization requires deterministic light depth/);
  assert.match(validateWorldModelDraft({ ...base, materialization: { ...base.materialization, confirmation: 'prompt' }, outputDir: '../outside' }).join(' '), /repository-relative path/);
  assert.match(validateWorldModelDraft({ ...base, materialization: { ...base.materialization, confirmation: 'prompt' }, views: ['Business View'] }).join(' '), /lower-case kebab-case/);
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
