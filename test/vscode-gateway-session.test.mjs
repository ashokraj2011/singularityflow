/**
 * The gateway running inside the extension host.
 *
 * These exercise the bundled extension against the stubbed VS Code API — the same harness the rest
 * of `vscode-host` uses — so what is under test is the shipped bundle, activated, with the command
 * invoked. That matters here more than usual: the whole question is whether the core survives being
 * bundled into CommonJS, and only the bundle can answer it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeOnly } from './source-text.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the extension bundle contains the gateway, not a call out to it', async () => {
  /**
   * The bridge, asserted at its narrowest point. A handle is signed per session and revalidated at
   * the moment of use; it cannot survive a process that exits after every command. Either the
   * kernel is in this bundle or nothing in the editor re-resolves anything.
   */
  const bundle = await readFile(path.join(root, 'apps', 'vscode', 'dist', 'extension.cjs'), 'utf8');
  assert.ok(bundle.includes('sflow-result'), 'the result contract is bundled');
  assert.ok(bundle.includes('A handle requires the operation it resolved to'),
    'the handle authority is bundled');
  assert.ok(bundle.includes('gateway.planner-unavailable'), 'the kernel is bundled');
});

test('the editor bundles the shared docs planner with a verified package root', async () => {
  /**
   * `help-explain` now receives the same package-root contract as every other surface. It must be
   * present in the CommonJS bundle rather than falling back to a second host-specific resolver.
   */
  const source = await readFile(path.join(root, 'apps', 'vscode', 'src', 'gateway-session.ts'), 'utf8');
  const imported = [...source.matchAll(/planners\/([a-z-]+)\.mjs/g)].map(([, name]) => name).sort();
  assert.deepEqual(imported, ['ast-intelligence', 'context-brief', 'developer-next', 'governed-goal', 'help-explain', 'home-overview', 'impact-quick', 'impact-what-if', 'problem-investigate', 'repository-explore', 'review-packet', 'work-continue', 'work-list',
    'work-readiness', 'work-return', 'work-start-intake', 'workspace-list', 'workspace-reliability-surface', 'world-model']);
  assert.ok(codeOnly(source).includes('help-explain'), 'the docs planner is imported');

  /**
   * Checked by a marker from inside the module, not by its filename.
   *
   * A first pass grepped for `docs-manifest` and failed — on `docs-manifest.json`, which the Help
   * Center `require`s at runtime from a computed path and which is data, not a bundled module. A
   * substring of a filename cannot tell "this code is here" from "this name is mentioned".
   */
  const bundle = await readFile(path.join(root, 'apps', 'vscode', 'dist', 'extension.cjs'), 'utf8');
  const topics = await readFile(path.join(root, 'src', 'docs-topics.mjs'), 'utf8');
  const marker = topics.match(/export function (\w+)/)?.[1];
  assert.ok(marker, 'docs-topics.mjs exports something to look for');
  assert.ok(bundle.includes(`function ${marker}(`), 'the shared documentation subsystem is bundled');
});

test('the host gateway refuses to start without being told which planners exist', async () => {
  const { createHostGateway } = await import('../src/gateway/host.mjs');
  assert.throws(() => createHostGateway({ root: '/tmp', hostSessionId: 's' }),
    /requires the map of planners/);
  /**
   * It used to default to all seven, which made `host.mjs` statically import the docs subsystem and
   * silently decided the module could only run in one kind of host. Which planners a build has was
   * always the caller's fact; the default hid that.
   */
  const source = await readFile(path.join(root, 'src', 'gateway', 'host.mjs'), 'utf8');
  assert.ok(!source.includes("from './planners/index.mjs'"),
    'host.mjs must not pull the full planner set');
});

test('a card carries its handle in the model and never in the markup', async () => {
  const model = await import(path.join(root, 'apps', 'vscode', 'src', 'views', 'result-card-model.ts'));
  const { workReadinessResult } = await import('../src/gateway/planners/work-readiness.mjs');
  const result = workReadinessResult({
    id: 'PAY-1187', kind: 'story', phase: 'implement', generation: 1, group: 'active',
    blockers: ['required-artifact-missing'],
    nextAction: { operation: 'work.continue', reasonCode: 'work.resume-phase' }, lastMaterialEvent: null
  });
  const card = model.buildResultCard(result);
  const action = card.checklist.find((row) => row.action)?.action;
  assert.ok(action.handle, 'the model has the handle to dispatch with');

  const { resultCardHtml } = await import(path.join(root, 'apps', 'vscode', 'src', 'views', 'result-card-page.ts'));
  assert.ok(!resultCardHtml(card).includes(action.handle), 'the webview never sees it');
});

test('origin travels with the showing, not with the card', async () => {
  /**
   * A gateway result was resolved moments ago and its handles are live; a CLI result came from a
   * process that has exited and its handles are dead. The dispatcher must not guess which it holds,
   * and the card itself cannot know — the same view can arrive either way.
   */
  const panel = await readFile(path.join(root, 'apps', 'vscode', 'src', 'views', 'result-panel.ts'), 'utf8');
  assert.match(panel, /export type ResultOrigin = 'gateway' \| 'cli'/);
  assert.match(panel, /origin: currentOrigin/);

  const extension = await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8');
  assert.match(extension, /if \(route && origin === 'gateway'\)/,
    'the executor path is taken only for results whose handles are live');
  assert.match(extension, /showResultCard\(buildResultCard\(envelope\), \{ origin: 'gateway' \}\)/,
    'My Work marks its own result as one the executor can re-resolve');
});

test('every gateway surface uses the validated active repository context', async () => {
  const session = await readFile(path.join(root, 'apps', 'vscode', 'src', 'gateway-session.ts'), 'utf8');
  const extension = await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8');

  assert.doesNotMatch(codeOnly(session), /workspaceFolders/,
    'the gateway session never derives its repository from the editor folder');
  assert.match(session, /export function setActiveRepositoryContext/);
  assert.match(session, /sessionWorkspaceId === workspaceId/,
    'workspace identity participates in session reuse');
  assert.match(codeOnly(extension), /gatewaySession\(route\)/,
    'rootless Home supplies an explicit route rather than deriving one from an editor folder');
  assert.match(codeOnly(extension), /gatewaySession\(active\)/,
    'repository-backed surfaces supply the validated active context');
  assert.match(extension,
    /No governed workspace or repository is selected\. Choose a workspace or open a governed repository\./,
    'the empty-state message describes both supported resolution paths');
});

test('changing workspace identity retires the previous gateway session', async () => {
  const gateway = await import(path.join(root, 'apps', 'vscode', 'src', 'gateway-session.ts'));
  const first = {
    root: '/tmp/sflow-context-root', workspaceId: 'workspace-a', workspaceName: 'A',
    repositoryId: 'lead', origin: 'test'
  };
  gateway.setActiveRepositoryContext(first);
  const original = gateway.gatewaySession(first);
  assert.equal(gateway.gatewaySession(first), original,
    'an unchanged context reuses its handle authority');

  const second = { ...first, workspaceId: 'workspace-b', workspaceName: 'B' };
  gateway.setActiveRepositoryContext(second);
  const replaced = gateway.gatewaySession(second);
  assert.notEqual(replaced, original,
    'the same checkout under another workspace receives a new handle authority');
  assert.deepEqual(gateway.activeRepositoryContext(), second);
});

test('changing the Goal-owning lead repository retires handles even when the selected member stays put', async () => {
  const gateway = await import(path.join(root, 'apps', 'vscode', 'src', 'gateway-session.ts'));
  const first = {
    root: '/tmp/sflow-member-repository', leadRepositoryPath: '/tmp/sflow-lead-a',
    workspaceId: 'workspace-a', workspaceName: 'A', repositoryId: 'member', origin: 'test'
  };
  gateway.setActiveRepositoryContext(first);
  const original = gateway.gatewaySession(first);
  const second = { ...first, leadRepositoryPath: '/tmp/sflow-lead-b' };
  gateway.setActiveRepositoryContext(second);
  assert.notEqual(gateway.gatewaySession(second), original,
    'a Goal branch must never be read through handles bound to the previous lead repository');
});
