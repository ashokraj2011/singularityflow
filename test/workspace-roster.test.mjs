import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkspaceRoster } from '../src/workspace-roster.mjs';

const workspace = (id, path, extra = {}) => ({ id, name: `Workspace ${id}`, path,
  active: '', archivedAt: null, ...extra });

test('workspace roster preserves every registered row and registry order with exact identity and paths', () => {
  const rows = Array.from({ length: 75 }, (_, index) => workspace(`team-${74 - index}`,
    `/saved/workspace-${74 - index}`, { active: index === 42 ? 'yes' : '' }));
  const output = renderWorkspaceRoster(rows);
  assert.equal(output.split('\n').filter((line) => /^\| \d+ \|/u.test(line)).length, rows.length);
  for (const [index, row] of rows.entries()) {
    assert.ok(output.includes(`| ${index + 1} | ${row.id} | ${row.name} | ${index === 42 ? 'yes' : 'no'} | ${row.path} |`));
  }
  assert.match(output, /^\| # \| Workspace ID \| Name \| Active \| Path \|\n/u);
  assert.doesNotMatch(output, /Jira|Capabilities/u);
  assert.match(output, /Copilot: `\/sf-workspace`/u);
  assert.match(output, /Shell: `singularity-flow workspace use <EXACT-WORKSPACE-ID-OR-PATH>`/u);
  assert.doesNotMatch(output, /\/sf-home|My Work|What is on your mind/u);
});

test('duplicate workspace IDs retain all distinct paths and require explicit exact-path selection', () => {
  const rows = [workspace('same-id', '/saved/first', { active: 'yes' }),
    workspace('same-id', '/saved/second'), workspace('other', '/saved/other')];
  const output = renderWorkspaceRoster(rows);
  assert.match(output, /\| 1 \| same-id \| Workspace same-id \| yes \| \/saved\/first \|/u);
  assert.match(output, /\| 2 \| same-id \| Workspace same-id \| no \| \/saved\/second \|/u);
  assert.match(output, /Ambiguous workspace ID: same-id/u);
  assert.match(output, /select the exact path shown above, not the ID/u);
  assert.match(output, /Row numbers are display-only/u);
  assert.equal(output.match(/singularity-flow workspace use/gu).length, 1, 'only a fixed placeholder handoff is emitted');
  assert.doesNotMatch(output, /workspace use same-id|workspace use \/saved\//u);
  assert.doesNotMatch(renderWorkspaceRoster([rows[0], { ...rows[0] }]), /Ambiguous workspace ID/u,
    'the same exact registered path does not create a distinct-path ambiguity');
});

test('archived workspaces do not enter the roster, optional columns or ambiguity warnings', () => {
  const output = renderWorkspaceRoster([workspace('kept', '/saved/kept'),
    workspace('kept', '/saved/archived', { archivedAt: '2026-09-27T00:00:00Z',
      anchorKey: 'ARCH-1', siteId: 'jira-site', capabilities: ['archived-capability'] })]);
  assert.equal(output.split('\n').filter((line) => /^\| \d+ \|/u.test(line)).length, 1);
  assert.doesNotMatch(output, /archived|ARCH-1|Capabilities|Jira|Ambiguous/u);
  for (const rows of [[], [workspace('old', '/saved/old', { archivedAt: '2026-09-27T00:00:00Z' })]]) {
    const empty = renderWorkspaceRoster(rows);
    assert.match(empty, /^No non-archived registered workspaces\.\n/u);
    assert.match(empty, /Copilot: `\/sf-workspace`/u);
    assert.match(empty, /workspace use <EXACT-WORKSPACE-ID-OR-PATH>/u);
    assert.doesNotMatch(empty, /^\|/mu);
  }
});

test('Jira and capabilities appear only from supplied observed row data, never from local anchors or invented manifests', () => {
  const rows = [workspace('local', '/does-not-exist/local', { anchorKey: 'LOCAL-1',
    anchorType: 'Workspace', siteId: 'local', capabilities: [] }),
  workspace('jira-team', '/does-not-exist/jira', { anchorKey: 'JIRA-24', anchorType: 'Epic',
    siteId: 'observed-jira-site', capabilities: ['payments', 'reports'] }),
  workspace('unknown', '/does-not-exist/unknown')];
  const output = renderWorkspaceRoster(rows);
  assert.match(output, /\| Jira \| Capabilities \|/u);
  assert.match(output, /\/does-not-exist\/local \| — \| none \|/u);
  assert.match(output, /\/does-not-exist\/jira \| JIRA-24 \| payments, reports \|/u);
  assert.match(output, /\/does-not-exist\/unknown \| — \| — \|/u);
  assert.doesNotMatch(output, /LOCAL-1/u);
  assert.doesNotMatch(renderWorkspaceRoster([workspace('local', '/absent', {
    anchorKey: 'LOCAL-1', siteId: 'local', anchorType: 'Workspace'
  })]), /\| Jira \|/u);
  assert.doesNotMatch(renderWorkspaceRoster([workspace('unknown', '/absent', {
    capabilities: { inventedManifest: ['must-not-display'] }
  })]), /Capabilities|must-not-display/u);
});

test('Markdown, row-breaking newlines and terminal/bidi controls cannot escape workspace cells or warnings', () => {
  const id = 'ID|[unsafe]';
  const output = renderWorkspaceRoster([workspace(id, 'C:\\work\\one|two', {
    name: '[click](javascript:alert(1)) <script> & `tick`\r\nnext\tcell\u001b\u0007\u202e'
  }), workspace(id, '/saved/second\nrow')]);
  assert.equal(output.split('\n').filter((line) => /^\| \d+ \|/u.test(line)).length, 2);
  assert.ok(output.includes('ID\\|\\[unsafe\\]'));
  assert.ok(output.includes('C:\\\\work\\\\one\\|two'));
  assert.ok(output.includes('\\[click\\]\\(javascript:alert\\(1\\)\\) &lt;script&gt; &amp; \\`tick\\` ↵ next cell'));
  assert.ok(output.includes('/saved/second ↵ row'));
  assert.match(output, /Ambiguous workspace ID: ID\\\|\\\[unsafe\\\]/u);
  assert.doesNotMatch(output, /<script>|\u001b|\u0007|\u202e|\r|\t/u);
});

test('workspace roster is deterministic and leaves the supplied observations unchanged without selection or probing', () => {
  const rows = [Object.freeze(workspace('cold', '/unreadable/nonexistent/workspace', {
    capabilities: Object.freeze(['known-only']), repositoryState: Object.freeze({ status: 'missing' })
  })), Object.freeze(workspace('active', '/also/nonexistent', { active: true }))];
  Object.freeze(rows);
  const before = JSON.stringify(rows);
  const first = renderWorkspaceRoster(rows);
  assert.equal(first, renderWorkspaceRoster(rows));
  assert.equal(JSON.stringify(rows), before);
  assert.doesNotMatch(first, /ready|initialized|repaired|repositoryState|missing/u);
  assert.match(first, /\| cold \| Workspace cold \| no \|/u);
  assert.match(first, /\| active \| Workspace active \| yes \|/u);
  assert.throws(() => renderWorkspaceRoster({ workspaces: rows }), TypeError);
  assert.throws(() => renderWorkspaceRoster([null]), TypeError);
});
