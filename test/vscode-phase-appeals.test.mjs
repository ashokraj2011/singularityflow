import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { phaseIssuesBody } from '../apps/vscode/src/views/phase-issues-page.ts';

test('phase issue screen escapes repository text and provides only fixed host actions', () => {
  const attack = '<img src=x onerror="execute()"><script>execute()</script>';
  const html = phaseIssuesBody({ data: { workId: attack, phaseId: 'custom-code',
    resolution: { issues: [{ code: attack, path: attack, status: 'needs-human', choices: [{ owner: attack, detail: attack, command: attack }] }] },
    appeals: { items: [{ id: attack, phaseId: attack, status: attack }] } } });
  assert.doesNotMatch(html, /<img|<script|data-action="execute|onclick=/);
  assert.match(html, /&lt;img/);
  assert.deepEqual([...html.matchAll(/data-action="([^"]+)"/gu)].map(value => value[1]), ['appeal', 'review', 'tests', 'repair', 'resume', 'refresh']);
  assert.match(html, /No automatic risk acceptance or phase advance/);
  for (const input of [null, [], { data: [] }, { data: { resolution: { issues: 'invalid' } } }]) assert.doesNotThrow(() => phaseIssuesBody(input));
});
test('appeal entry points reach shared preflight and prefill, never execute, human review', async () => {
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  const block = extension.slice(extension.indexOf("'singularityFlow.resolvePhaseIssues': async"), extension.indexOf("'singularityFlow.reviewStoryTestRecovery': async"));
  assert.match(block, /'appeal', 'preflight'/);
  assert.match(block, /repositoryEpoch\.isCurrent/); assert.match(block, /stillCurrent\(\)/);
  assert.match(block, /'appeal', 'attest'/); assert.match(block, /'appeal', 'decide'/);
  assert.match(block, /'appeal', 'repair-plan'/); assert.match(block, /'repair-resume' : 'repair-run'/);
  assert.match(block, /planned\.data\?\.binding\?\.workId !== workId/);
  assert.match(block, /selected\.item\.packetSha256\], process\.platform, client\.location\), false/);
  assert.doesNotMatch(block, /client\.run[^\n]+\['appeal', '(?:decide|attest)'/);
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contributes.commands.some(value => value.command === 'singularityFlow.resolvePhaseIssues'));
  for (const file of ['tree-model.ts', 'inbox.ts']) {
    assert.match(await readFile(new URL(`../apps/vscode/src/views/${file}`, import.meta.url), 'utf8'), /singularityFlow\.resolvePhaseIssues/);
  }
});
