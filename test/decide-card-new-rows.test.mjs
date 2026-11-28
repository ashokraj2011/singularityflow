/**
 * Rows on the Decide card for steps a person once took only in their own terminal [owner, 2026-11-28]: handing a sign-off to a
 * later step that can do and repair it, accepting a screen comparison that differs, and leaving changes out of a step, shown
 * first and then done on one Yes, and naming the web address a browser check trusts, shown first too. Each row says why the
 * person is asked; Do this now runs it from the card.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { decisionPacket } from '../src/decision-list.mjs';
import { decideHtml, runnableStep, setAsideArgv, setAsidePreviewArgv, setAsidePreviewHtml, setAsidePreviewOf, targetOriginArgv, targetOriginPreviewArgv,
  targetOriginPreviewHtml, targetOriginPreviewOf, targetOriginWork } from '../apps/vscode/src/views/decide-card-page.ts';

const W = 'ROW-1';
const AT = '2026-11-28T09:00:00.000Z';
const AUTHORITIES = { engineers: { label: 'Engineers', allowAnyGitIdentity: true, members: [] } };
const ME = { name: 'Person', email: 'person@example.invalid' };
const step = (id, label, status, extra = {}) => ({ id, label, status, generation: 1, approvals: [], approvalPolicy: { authorities: ['engineers'], minimum: 1 }, ...extra });

function story() {
  return { workItem: { id: W }, status: 'in_progress', currentPhase: 'design', phaseOrder: ['design', 'implementation', 'visual'], history: [],
    resolution: { approvalAuthorities: AUTHORITIES, verification: { comparison: { mode: 'enforce' } } },
    phases: { design: step('design', 'Design', 'awaiting_approval'),
      implementation: step('implementation', 'Implementation', 'not_started', { generation: { requirement: 'required', producer: 'deterministic', task: 'code' }, writeScope: 'source-and-artifact' }),
      visual: step('visual', 'Visual check', 'not_started', { requiredArtifact: { kind: 'visual-test-evidence' } }) } };
}
const owed = { kind: 'witness', clauseId: `${W}:AC-001`, clauseText: 'The total shows on the page.', slot: 'total', method: 'inspection', files: ['docs/total.png'],
  owners: ['design'], groups: ['engineers'], contextBinding: `sha256:${'c'.repeat(64)}`, available: true,
  command: `singularity-flow decision witness --work-id ${W} --criterion ${W}:AC-001 --slot total --file docs/total.png` };
const list = (facts) => decisionPacket(story(), { phaseId: 'design', ...facts }, { authorities: AUTHORITIES, actor: ME, at: AT });

test('a sign-off can be handed to the later step that can do and repair it, as one row choice with its why', () => {
  const item = list({ pending: { owed: [owed] } }).items.find((entry) => entry.details?.clause === `${W}:AC-001`);
  assert.ok(item, 'the sign-off row');
  const defer = item.options.find((entry) => entry.id === 'defer-total');
  assert.ok(defer, item.options.map((entry) => entry.id).join(', '));
  assert.equal(defer.label, 'Hand this sign-off to Implementation');
  assert.match(defer.words, /^Implementation can do and repair what this sign-off checks, and gives it at its own approval; Design no longer waits for it\.$/u);
  assert.equal(defer.action.command, `singularity-flow decision witness-defer ${W} --criterion ${W}:AC-001 --slot total --to implementation --reason "<why>"`);
  assert.equal(runnableStep(defer.action.command), true, 'Do this now runs it, with the person\'s reason');
  assert.equal(defer.decidedBy.allowed, true);
});

test('a screen comparison that differs has its own row: accept it until a date, the comparison stays failed', () => {
  const command = `singularity-flow decision visual-risk ${W} --comparison visual-0123 --expires <YYYY-MM-DD> --reason <why>`;
  const item = list({ visualRisks: [{ id: 'visual-0123', profileId: 'mobile', path: 'evidence/visual/mobile.json', disposition: 'failed', command }] })
    .items.find((entry) => entry.kind === 'visual-risk');
  assert.ok(item);
  assert.equal(item.title, 'Accept the mobile screen that differs (visual-0123)');
  assert.match(item.why, /^visual-0123 differs from its reference more than the Story allows, so the Story cannot end on it\. Fix the screen, or accept the difference until a date\.$/u);
  assert.equal(item.holds, 'story-end');
  assert.equal(item.recommended?.option ?? null, null, 'accepting it goes against the comparison, so it is never recommended');
  assert.equal(item.options[0].decidedBy.allowed, true, 'the visual check\'s approvers accept it, as the command checks');
  assert.deepEqual(item.options.map((entry) => [entry.id, entry.action.command]), [['accept-visual-risk', command]]);
  assert.match(decideHtml({ ...list({ visualRisks: [{ id: 'visual-0123', profileId: 'mobile', command }] }), repositoryPath: '/repo' }),
    /Accept the difference until a date[\s\S]*data-own-expires="accept-visual-risk"[\s\S]*data-run="accept-visual-risk">Do this now/u);
});

test('leaving changes out shows what it sets aside first, then one Yes bound to the plan it showed', () => {
  const preview = `singularity-flow recover ${W} --phase design --json`;
  assert.equal(runnableStep(preview), false, 'a preview is never run as if it were the step');
  assert.deepEqual(setAsidePreviewArgv(preview), ['recover', W, '--phase', 'design', '--json']);
  assert.equal(setAsidePreviewArgv(`singularity-flow recover ${W} --json`), null);
  const result = { resultType: 'command-result', data: { plan: { planId: 'rcp-0123456789abcdef', actions: [{ id: 'reconcile' },
    { id: 'set-aside-worktree', paths: ['src/late.js', 'notes.md'] }] } } };
  const shown = setAsidePreviewOf(result, { option: 'set-aside', item: 'd1', workId: W, phase: 'design' });
  assert.deepEqual(shown, { option: 'set-aside', item: 'd1', workId: W, phase: 'design', planId: 'rcp-0123456789abcdef', paths: ['src/late.js', 'notes.md'] });
  assert.deepEqual(setAsideArgv(shown), ['recover', W, '--phase', 'design', '--set-aside', '--confirm', 'rcp-0123456789abcdef']);
  const html = setAsidePreviewHtml(shown);
  assert.match(html, /These 2 files go back to their committed bytes\.<\/strong>\s*SFlow first keeps a private copy of every changed file and the Git index, so it can be undone; nothing else changes\./u);
  assert.match(html, /<li>src\/late\.js<\/li><li>notes\.md<\/li>[\s\S]*data-preview-apply>Set them aside<\/button>[\s\S]*data-preview-cancel>Not now/u);
  assert.equal(setAsidePreviewOf({ data: { plan: { planId: 'rcp-0123456789abcdef', actions: [] } } }, { option: 'set-aside', item: 'd1', workId: W, phase: 'design' }), null,
    'nothing to set aside offers no button');
});

test('the web address a browser check trusts is named on its row, shown first, then pinned on one Yes with the person\'s reason', () => {
  const smoke = (extra = {}) => { const workflow = story(); workflow.phases.visual.mcp = { requireSmoke: true, requiredServers: ['playwright'] }; return Object.assign(workflow, extra); };
  const packet = decisionPacket(smoke(), { phaseId: 'design' }, { authorities: AUTHORITIES, actor: ME, at: AT });
  const item = packet.items.find((entry) => entry.kind === 'target-origin');
  assert.ok(item, packet.items.map((entry) => entry.kind).join(', '));
  assert.equal(item.title, 'Name the web address Visual check checks the app at');
  assert.match(item.why, /^Visual check checks the app in a browser at one web address, and this Story has none yet, so it cannot be submitted\. Name it: SFlow shows what it trusts first\.$/u);
  assert.equal(item.holds, 'later-step', 'it holds only the step that checks the app there');
  assert.equal(item.recommended.option ?? null, null, 'SFlow never picks the address');
  const [pin] = item.options;
  assert.equal(pin.action.command, `singularity-flow story target-origin ${W} --url <AUTHORIZED-URL> --json`);
  assert.equal(pin.decidedBy.allowed, true);
  assert.equal(runnableStep(pin.action.command), false);
  assert.equal(targetOriginWork(pin.action.command), W);
  assert.match(decideHtml(packet), /data-own-url="pin-target-origin"[\s\S]*data-preview="pin-target-origin">See what it trusts/u);
  // Only an address the person wrote, as a web address: never a blank or another scheme.
  assert.deepEqual(targetOriginPreviewArgv(pin.action.command, ' https://staging.example.test '), ['story', 'target-origin', W, '--url', 'https://staging.example.test', '--json']);
  for (const url of ['', 'javascript:alert(1)', 'https://a.test/"x', null]) assert.equal(targetOriginPreviewArgv(pin.action.command, url), null, String(url));
  const plan = `sha256:${'d'.repeat(64)}`;
  const result = { resultType: 'command-result', data: { workId: W, origin: 'https://staging.example.test', servers: ['playwright'], steps: ['visual'], planSha256: plan, evidenceConflicts: [] } };
  const shown = targetOriginPreviewOf(result, { option: 'pin-target-origin', item: 'd1', workId: W });
  assert.deepEqual(shown, { kind: 'target-origin', option: 'pin-target-origin', item: 'd1', workId: W, origin: 'https://staging.example.test', servers: ['playwright'], steps: ['visual'], planSha256: plan, conflicts: [] });
  assert.deepEqual(targetOriginArgv(shown, 'Approved staging target.'), ['story', 'target-origin', W, '--url', 'https://staging.example.test', '--reason', 'Approved staging target.', '--confirm', plan]);
  assert.match(targetOriginPreviewHtml(shown), /visual will check the app only at https:\/\/staging\.example\.test\.<\/strong>[\s\S]*data-preview-reason[\s\S]*data-preview-apply>Pin it/u);
  // Evidence that would stop counting: nothing to press.
  assert.doesNotMatch(targetOriginPreviewHtml({ ...shown, conflicts: ['visual: its smoke receipt names another address'] }), /data-preview-apply/u);
  assert.equal(targetOriginPreviewOf({ data: { ...result.data, workId: 'OTHER-1' } }, { option: 'pin-target-origin', item: 'd1', workId: W }), null, 'another Story\'s plan is never this row\'s');
  // Pinned already: no row.
  const pinned = smoke({ mcpAuthorizations: { playwright: { origins: ['https://staging.example.test'] } } });
  assert.equal(decisionPacket(pinned, { phaseId: 'design' }, { authorities: AUTHORITIES, actor: ME, at: AT }).items.some((entry) => entry.kind === 'target-origin'), false);
});
