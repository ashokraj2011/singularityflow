/**
 * The routing panel shows the resolution; it does not compute one. `[ADP:REQ-020]` `[ADP:CON-002]`
 *
 * Two failures are worth guarding here, and both have already happened once in this codebase.
 *
 * A projection added to `configurationSlice` alone renders nothing: the extension calls
 * `snapshot --json` with no `--include`, which lands in `fullRepositorySnapshot`. The fast-path rail
 * shipped that way and was silently invisible — a projection reaching the wrong function looks
 * exactly like one that was never written.
 *
 * And a view that resolves the alias ladder itself is a second opinion about which model the kernel
 * will use. When the two disagree, the reader has no way to tell which is real.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function withoutComments(text) {
  return String(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the projection is carried by both snapshot shapes, not just the slice', async () => {
  const editor = withoutComments(await readFile(new URL('../src/editor.mjs', import.meta.url), 'utf8'));
  const calls = [...editor.matchAll(/modelRouting: await modelRoutingProjection\(root, definition\)/g)];
  assert.equal(calls.length, 2,
    `modelRouting is projected ${calls.length} time(s); it must be in both configurationSlice and fullRepositorySnapshot`);

  // The one the extension actually reaches.
  const full = editor.slice(editor.indexOf('async function fullRepositorySnapshot'), editor.indexOf('async function configurationSlice'));
  assert.match(full, /modelRouting: await modelRoutingProjection/,
    'the snapshot the extension calls with no --include does not carry the routing projection');
});

test('the panel renders the engine answer and resolves nothing itself', async () => {
  const page = withoutComments(await readFile(new URL('../apps/vscode/src/views/configuration-center-page.ts', import.meta.url), 'utf8'));
  assert.match(page, /function modelRouting\(view: ConfigurationCenterView\)/, 'the routing tab has no renderer');
  assert.match(page, /tab === 'models' \? modelRouting\(view\)/, 'the renderer exists but is never reached');

  // No second resolution: the panel must not walk aliases, pick a preferred model, or know a ladder.
  const panel = page.slice(page.indexOf('function modelRouting('), page.indexOf('function worldModel('));
  for (const forbidden of ['tierLadder', 'MODEL_TASKS', 'loadModelTiers', 'aliasOf ?? ', '.models[0]']) {
    assert.ok(!panel.includes(forbidden), `the panel recomputes ${forbidden} instead of rendering the projection`);
  }

  // Not-configured and unreadable are told apart: routing is opt-in, and "no mapping" is not a fault.
  assert.match(panel, /!routing\?\.configured/, 'the panel treats an unconfigured repository as an error');
  assert.match(panel, /routing\.error/, 'the panel cannot report a mapping it failed to read');
});

test('model routing is reachable from the shared navigation and its only action opens the governed file', async () => {
  const page = withoutComments(await readFile(new URL('../apps/vscode/src/views/configuration-center-page.ts', import.meta.url), 'utf8'));
  // The grouped navigation uses the same ConfigurationTab type as the panel router. Keeping the
  // runtime allowlist assertion here guards a navigation item that renders but cannot be opened.
  const model = withoutComments(await readFile(new URL('../apps/vscode/src/views/configuration-center-model.ts', import.meta.url), 'utf8'));
  assert.match(model, /CONFIGURATION_TABS = \[[^\]]*'models'/, 'model routing is not a known tab');
  assert.match(page, /CONFIGURATION_NAVIGATION/, 'the Configuration Center has no shared navigation model');
  assert.match(page, /label: 'Model routing',[^\n]*tab: 'models'/,
    'the grouped navigation does not offer the routing area');
  assert.match(page, /data-tab="\$\{item\.tab\}"/, 'navigation tabs are not wired to the panel router');

  /**
   * The panel is read-only, so the button out of it is the only way to change a tier — and a button
   * with no handler is a control that silently does nothing, which is worse than no button.
   */
  const extension = withoutComments(await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8'));
  assert.match(extension, /message\.action === 'open-model-tiers'/, "the mapping button has no handler");
  assert.match(extension, /modelRouting\?\.path \?\? 'singularity\/modelTiers\.yml'/,
    'the handler hard-codes the mapping path rather than using the one the engine reported');
});

test('the type matches what the engine emits', async () => {
  // The extension has no runtime schema, so the interface is the only thing standing between a
  // renamed field and a panel quietly rendering `undefined`.
  const types = await readFile(new URL('../apps/vscode/src/cli/snapshot.ts', import.meta.url), 'utf8');
  for (const field of ['task', 'model', 'fallback', 'aliasOf', 'params', 'phases']) {
    assert.match(types, new RegExp(`\\b${field}[?]?:`), `ModelRoutingTask omits ${field}`);
  }
  for (const field of ['configured', 'revision', 'tasks']) {
    assert.match(types, new RegExp(`\\b${field}[?]?:`), `ModelRoutingProjection omits ${field}`);
  }
  assert.match(types, /modelRouting\?: ModelRoutingProjection \| null;/, 'the snapshot type does not carry the projection');
});
