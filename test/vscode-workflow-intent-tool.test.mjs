import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

async function adapter({ supported = true } = {}) {
  const source = await readFile(new URL('../apps/vscode/src/workflow-intent-runtime.ts', import.meta.url), 'utf8');
  const body = stripTypeScriptTypes(source.replace(/^import .+;\n/gmu, '').replace(/^export \{.+\} from .+;\n/gmu, '').replace(/^export /gmu, ''));
  let counter = 0, tool, disabled = false, disposed = 0; const contexts = [];
  const vscode = { lm: supported ? { registerTool(_name, value) { tool = value; return { dispose() { disposed++; } }; } } : {},
    LanguageModelTextPart: class { constructor(text) { this.text = text; } }, LanguageModelToolResult: class { constructor(content) { this.content = content; } },
    workspace: { getConfiguration: scope => ({ get: () => scope === 'singularityFlow' ? disabled ? 'disabled' : 'auto' : false }) },
    commands: { executeCommand: async (...args) => { contexts.push(args); } } };
  const module = new Function('vscode', 'randomUUID', body + '\nreturn { attachWorkflowIntentTool };')(vscode, () => `session-${++counter}`);
  return { attach: module.attachWorkflowIntentTool, invoke: input => tool.invoke({ input }), disabled: () => { disabled = true; }, contexts, disposed: () => disposed };
}

test('native tool registration is optional and never forces a newer host or model connection', async () => {
  const host = await adapter({ supported: false });
  const slot = host.attach(() => { throw new Error('Must not run'); });
  assert.equal(slot.available, false); slot.dispose(); assert.deepEqual(host.contexts, []);
});

test('native tool routes only to exact open sessions and disposes registration after the last designer closes', async () => {
  const host = await adapter(); const received = [];
  const first = host.attach(async input => { received.push(input); return { status: 'checked', approvalRecorded: false }; });
  const second = host.attach(async () => ({ status: 'second' }));
  assert.equal(first.available, true);
  const result = await host.invoke({ action: 'draft', session: first.session, revision: 0, source: '<workflow/>' });
  assert.equal(JSON.parse(result.content[0].text).approvalRecorded, false); assert.equal(received.length, 1);
  first.dispose(); await assert.rejects(host.invoke({ action: 'catalog', session: first.session, revision: 0 }), /unavailable/u);
  assert.equal(host.disposed(), 0);
  assert.equal(JSON.parse((await host.invoke({ action: 'catalog', session: second.session, revision: 0 })).content[0].text).status, 'second');
  second.dispose(); assert.equal(host.disposed(), 1);
  assert.deepEqual(host.contexts.at(-1), ['setContext', 'singularityFlow.workflowIntentOpen', false]);
});

test('tool input cannot request arbitrary paths, lifecycle actions, oversized drafts or malformed selectors', async () => {
  const host = await adapter(); let calls = 0;
  const slot = host.attach(async () => { calls++; return {}; });
  for (const input of [
    { action: 'approve' }, { action: 'catalog', path: '/arbitrary/file' }, { action: 'draft', source: 'x'.repeat(262145) },
    { action: 'asset', kind: [] }, { action: 'catalog', cursor: -1 }, { action: 'catalog', query: 'x'.repeat(513) },
    { action: 'catalog', revision: '0' }
  ]) await assert.rejects(host.invoke({ session: slot.session, revision: 0, ...input }));
  assert.equal(calls, 0); slot.dispose();
});

test('turning model features off prevents native invocation before catalog access', async () => {
  const host = await adapter(); let calls = 0;
  const slot = host.attach(async () => { calls++; return {}; }); host.disabled();
  await assert.rejects(host.invoke({ action: 'catalog', session: slot.session, revision: 0 }), /disabled/u);
  assert.equal(calls, 0); slot.dispose();
});
