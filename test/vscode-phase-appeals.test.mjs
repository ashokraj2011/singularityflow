import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { phaseIssuesBody, pendingEvidenceSuggestions } from '../apps/vscode/src/views/phase-issues-page.ts';

test('phase issue screen escapes repository text and provides only fixed host actions', () => {
  const attack = '<img src=x onerror="execute()"><script>execute()</script>';
  const html = phaseIssuesBody({ data: { workId: attack, phaseId: 'custom-code',
    resolution: { issues: [{ code: attack, path: attack, status: 'needs-human', choices: [{ owner: attack, detail: attack, command: attack }] }] },
    appeals: { items: [{ id: attack, phaseId: attack, status: attack }] } } });
  assert.doesNotMatch(html, /<img|<script|data-action="execute|onclick=/);
  assert.match(html, /&lt;img/);
  assert.deepEqual([...html.matchAll(/data-action="([^"]+)"/gu)].map(value => value[1]), ['appeal', 'review', 'evidence', 'tests', 'repair', 'resume', 'checkpoint', 'refresh']);
  assert.match(html, /No automatic risk acceptance or phase advance/);
  for (const input of [null, [], { data: [] }, { data: { resolution: { issues: 'invalid' } } }]) assert.doesNotThrow(() => phaseIssuesBody(input));
});

test('evidence review uses pinned selectors and an independently presented UI, never a webview answer', async () => {
  const review = await readFile(new URL('../apps/vscode/src/views/evidence-contract-review.ts', import.meta.url), 'utf8');
  assert.match(review, /'evidence-prepare'/);
  assert.match(review, /packet\?\.workId !== workId \|\| packet\.phaseId !== phaseId/);
  assert.match(review, /'evidence-accept', .*'--confirm', packet\.packetSha256!, '--review-ui'/);
  assert.match(review, /stillCurrent\(\)/); assert.match(review, /cancellation\.onCancellationRequested/);
  assert.doesNotMatch(review, /issueActionAuthorization|sendText|createTerminal|fetch\(|runWithInput/);
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(extension, /reviewEvidenceContract\(client, workId, phaseId, stillCurrent, result\)/);
});

test('evidence picker uses recovery suggestions and exact pending paths, not executable repository text', () => {
  const path = 'team/stories/UI-1/evidence/screen.png';
  assert.deepEqual(pendingEvidenceSuggestions({ data: { recovery: { actions: [{ evidence: { path, eligibleClauseIds: ['UI-1:AC-001', 'execute()'] } }] },
    inspection: { findings: [{ code: 'phase.evidence-contract.not-ready', path }, { code: 'unrelated', path: '/tmp/secret' }] } } }),
    [{ path, clauses: ['UI-1:AC-001'] }]);
  assert.deepEqual(pendingEvidenceSuggestions({ data: { inspection: { findings: [{ code: 'phase.evidence-contract.not-ready', path }] } } }), [{ path, clauses: [] }]);
  for (const result of [null, [], { data: [] }]) assert.deepEqual(pendingEvidenceSuggestions(result), []);
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

test('pilot quality risks are displayed safely and acceptance is prepared in a human terminal', async () => {
  const html = phaseIssuesBody({ data: { quality: { risks: { gateMode: 'hard', eligible: true,
    remaining: ['US:AC-001'], items: [{ id: 'PQR-reviewed', status: 'needs-reattestation',
      reason: '<script>not executable</script>', expiresAt: '2026-10-20' }] } } } });
  assert.match(html, /data-action="risk"/); assert.match(html, /US:AC-001/);
  assert.match(html, /needs-reattestation/); assert.doesNotMatch(html, /<script>/);
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  const block = extension.slice(extension.indexOf("if (action === 'risk')"), extension.indexOf("if (action === 'repair' || action === 'resume')"));
  assert.match(block, /'risk-prepare'/); assert.match(block, /'risk-accept'/);
  assert.match(block, /packet\?\.binding\?\.workId !== workId/);
  assert.match(block, /client\.location\), false/);
  assert.doesNotMatch(block, /client\.run[^\n]*risk-accept/);
});
