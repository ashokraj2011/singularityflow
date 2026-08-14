import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
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

/**
 * The Configuration Center is now the only route to configuration, so the tests that matter most are
 * the ones that catch a surface being *shown* without being *reachable* — the defect that had already
 * shipped here: the Model routing tab rendered a strip button whose name the panel's hand-written
 * allowlist rejected, so clicking it did nothing.
 */
const { CONFIGURATION_TABS } = await import(source('configuration-center-model.ts'));
const centerPanelSource = await readFile(source('configuration-center.ts'), 'utf8');
const extensionSource = await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8');

test('every rendered tab is one the panel will accept', () => {
  const html = configurationCenterHtml(configurationCenterView(snapshot), 'overview', null, null, null, []);
  const rendered = [...html.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(rendered.length >= CONFIGURATION_TABS.length, 'the strip should render every tab');
  for (const tab of rendered) {
    assert.ok(CONFIGURATION_TABS.includes(tab), `the strip renders '${tab}' but it is not a known tab`);
  }
  // And the allowlist is the shared list rather than a second copy that can drift behind it.
  assert.match(centerPanelSource, /CONFIGURATION_TABS as readonly string\[\]\)\.includes/);
  assert.doesNotMatch(centerPanelSource, /\['overview', 'world-model'[^\]]*\]\.includes\(String\(message\.tab\)\)/);
});



/**
 * What the Configuration sidebar used to guarantee.
 *
 * The sidebar's file tree, world-model status, publish path, ledger line and model-independence
 * summary were deleted when Configuration collapsed to a single entry. These are the behaviours
 * those tests protected, asserted against the surface that owns them now. They are ported rather
 * than dropped because the risk of a migration like this is not that a panel looks wrong — it is
 * that something silently stops being shown anywhere.
 */
const centerHtml = (snapshotValue, tab = 'overview') =>
  configurationCenterHtml(configurationCenterView(snapshotValue), tab, null, null, null, []);

test('the editable file sets are listed as openable files', () => {
  const view = configurationCenterView({
    ...snapshot,
    templates: [{ path: 'singularity/templates/intake.md', name: 'intake.md' }],
    agentPrompts: [{ path: '.github/agents/architect.agent.md', name: 'architect.agent.md' }],
    repositorySkills: [{ path: '.github/skills/review/SKILL.md', name: 'review' }],
    flowSkills: [{ id: 'sflow-doctor', path: 'plugin/skills/sflow-doctor/SKILL.md', description: 'Diagnose a repository.' }],
    agents: [{ id: 'architect', scope: 'repository', path: '.github/agents/architect.agent.md', editable: true }],
    agentMappings: { path: 'singularity/agent-mappings.yml', exists: true }
  });
  assert.deepEqual(view.fileSets.map((set) => set.id), ['templates', 'prompts', 'skills', 'agents']);
  assert.deepEqual(view.fileSets.map((set) => set.files.length), [1, 1, 2, 2]);

  const html = configurationCenterHtml(view, 'templates', null, null, null, []);
  for (const path of ['singularity/templates/intake.md', '.github/agents/architect.agent.md',
    '.github/skills/review/SKILL.md', 'plugin/skills/sflow-doctor/SKILL.md',
    'singularity/agent-mappings.yml']) {
    assert.ok(html.includes(`data-open-path="${path}"`), `${path} should be openable`);
  }
});

test('packaged skills are listed beside the repository’s own, and marked as packaged', () => {
  // A repository that had written none of its own was once told it had no agents while every
  // shipped pack sat unlisted beside it.
  const view = configurationCenterView({
    ...snapshot,
    repositorySkills: [{ path: '.github/skills/ours/SKILL.md', name: 'ours' }],
    flowSkills: [
      { id: 'sflow-approve', path: 'plugin/skills/sflow-approve/SKILL.md' },
      { id: 'sflow-doctor', path: 'plugin/skills/sflow-doctor/SKILL.md' }
    ]
  });
  const skills = view.fileSets.find((set) => set.id === 'skills');
  // The repository's own first: those are the files a team wrote and can change.
  assert.deepEqual(skills.files.map((file) => file.label), ['ours', 'sflow-approve', 'sflow-doctor']);
  assert.deepEqual(skills.files.map((file) => file.packaged), [false, true, true]);
  assert.match(configurationCenterHtml(view, 'templates', null, null, null, []), /packaged/);
});

test('the file sets stay visible when the workflow definition is refused', () => {
  // Configuration is how a repository is repaired. Hiding it when the definition is invalid hides
  // the files whose editing is the fix.
  const view = configurationCenterView({
    ...snapshot,
    configurationValid: false,
    templates: [{ path: 'singularity/templates/intake.md', name: 'intake.md' }],
    repositorySkills: [{ path: '.github/skills/review/SKILL.md', name: 'review' }]
  });
  assert.equal(view.fileSets.find((set) => set.id === 'templates').files.length, 1);
  assert.equal(view.fileSets.find((set) => set.id === 'skills').files.length, 1);
});

test('validated configuration changes have a visible review and publish path', () => {
  const changed = {
    ...snapshot,
    repository: {
      branch: 'sflow/config-change/editor/review',
      configurationChanges: ['singularity/workflow.yml', 'singularity/templates/feature/design.md'],
      unrelatedChanges: [], publishReady: true
    }
  };
  const html = centerHtml(changed);
  assert.match(html, /2 files changed on sflow\/config-change\/editor\/review/);
  assert.match(html, /data-action="publish-configuration"/);
  // Offered only where there is something to publish — never as a permanent card.
  assert.doesNotMatch(centerHtml(snapshot), /data-action="publish-configuration"/);

  // Publishing commits one scoped transaction, so unrelated working-tree changes block it — and the
  // publish button must not be offered while they do.
  const blocked = centerHtml({
    ...changed,
    repository: { ...changed.repository, unrelatedChanges: ['src/index.ts'], publishReady: false }
  });
  assert.match(blocked, /Separate these unrelated changes before publishing: src\/index\.ts/);
  assert.doesNotMatch(blocked, /data-action="publish-configuration"/);
});

test('the Center says whether workflow progress is recorded, and where', () => {
  const view = configurationCenterView(snapshot);
  assert.equal(view.ledger.summary, 'no state branch');
  assert.match(centerHtml(snapshot), /No append-only workflow ledger/);

  const on = { ...snapshot, definition: { ...snapshot.definition, ledger: { enabled: true, branch: 'state' } } };
  assert.equal(configurationCenterView(on).ledger.summary, 'state on state');
  assert.match(centerHtml(on), /orphan branch &#39;state&#39;/);
});

test('the world model shows its current state, not only its policy', () => {
  const built = {
    ...snapshot,
    worldModel: {
      root: 'singularity/world-model', generatedAt: '2026-01-01T00:00:00Z', rebuildReason: null,
      views: [{ id: 'business', references: ['a', 'b'] }, { id: 'architecture', references: [] }]
    }
  };
  const html = centerHtml(built, 'world-model');
  assert.match(html, /data-open-path="singularity\/world-model\/views\/business\.md"/);
  assert.match(html, /no references/);
  assert.doesNotMatch(html, /data-action="build-world-model"/);
});

test('a stale world model offers the rebuild the engine asked for, in its own words', () => {
  const stale = {
    ...snapshot,
    worldModel: {
      root: 'singularity/world-model', generatedAt: '2026-01-01T00:00:00Z',
      rebuildReason: '12 files changed since the world model was built.', views: []
    }
  };
  const html = centerHtml(stale, 'world-model');
  assert.match(html, /12 files changed since the world model was built\./);
  assert.match(html, /data-action="build-world-model"/);
});

test('a repository with no world model is told so, not shown an empty list', () => {
  const none = { ...snapshot, worldModel: undefined };
  const view = configurationCenterView(none);
  assert.equal(view.worldModelStatus.built, false);
  const html = centerHtml(none, 'world-model');
  assert.match(html, /no world model yet/);
  assert.match(html, /data-action="build-world-model"/);
});

test('model independence is reported with whatever is blocking it', () => {
  const html = centerHtml({
    ...snapshot,
    modelFreedom: {
      schemaVersion: 1, mode: 'auto', modeSource: 'default', modelFreeLifecycleReady: false,
      blockers: ['verification requires a model'], warnings: ['intake prefers one'],
      summary: { status: 'partial', modelFreeLifecycleReady: false }
    }
  });
  assert.match(html, /Lifecycle status: <strong>partial<\/strong>/);
  assert.match(html, /verification requires a model/);
  assert.match(html, /intake prefers one/);
});

test('every tool the Configuration sidebar used to open is reachable from the Center', () => {
  const html = centerHtml(snapshot);
  for (const action of ['reset-jira', 'open-designer', 'open-instruction-designer',
    'open-specification-trace', 'open-flow-impact', 'open-copilot', 'open-prompt-audit',
    'inspect-composition-cache', 'check-ledger-deployment', 'open-impact-file']) {
    // Rendered *and* handled: a card whose action name the host does not answer is the defect this
    // whole migration exists to avoid.
    assert.ok(html.includes(`data-action="${action}"`), `${action} should be offered`);
    assert.ok(extensionSource.includes(`message.action === '${action}'`), `${action} should be handled`);
  }
});

test('the Center renders whether or not an Epic is checked out', () => {
  const bare = configurationCenterHtml(
    configurationCenterView({ initiative: null, initiatives: [], workItems: [] }), 'overview', null, null, null, []);
  assert.match(bare, /Configuration Center/);
  assert.match(bare, /data-action="open-designer"/);
});

/**
 * The sidebar header is the logo's most-seen placement, and it was the last one still showing the
 * placeholder: a generic workflow glyph reversed out of a green tile, which is what the screenshot
 * of the shipped extension shows.
 */
test('the sidebar header shows the brand mark, not the old tile', async () => {
  const sidebar = await readFile(source('sidebar.ts'), 'utf8');
  assert.match(sidebar, /\$\{brandSymbol\(30\)\}/, 'the header does not render the brand mark');
  assert.doesNotMatch(sidebar, /brand-mark[^\n]*linear-gradient\(145deg/, 'the placeholder tile is still styled');
  assert.doesNotMatch(sidebar, /class="brand-mark">\$\{icon\('workflow'/, 'the header still reverses a generic glyph out of a tile');

  const { brandSymbol } = await import(source('webview.ts'));
  const svg = brandSymbol(30);
  // The brand green, matching media/brand.svg rather than an approximation.
  for (const stop of ['#419458', '#5CAE5F', '#83CC6D']) assert.ok(svg.includes(stop), `${stop} is missing`);
  assert.match(svg, /aria-label="Singularity Flow"/);

  /**
   * Two marks in one document must not share a gradient id: SVG resolves `url(#id)` against the
   * first definition in the document, so the second would silently paint itself with the first's
   * gradient — or with nothing, if the first is ever removed.
   */
  assert.notEqual(brandSymbol(20, 'one').match(/id="([^"]+)"/)[1], brandSymbol(20, 'two').match(/id="([^"]+)"/)[1]);
  assert.equal((brandSymbol(20, 'one').match(/url\(#one\)/g) ?? []).length, 2);
});
