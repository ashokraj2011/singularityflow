/**
 * Fixes from the 2026-10-17 VS Code UI/UX review. Each one was a sentence a person could read on
 * screen: a literal `${workflow.workItem.id}`, the wrong error after a retry, a checklist that
 * vanished when its tab was hidden, a disabled button that never said why.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './source-text.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (relative) => readFile(path.join(root, relative), 'utf8');

async function typescriptSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? typescriptSources(path.join(directory, entry.name))
    : entry.name.endsWith('.ts') ? [path.join(directory, entry.name)] : []));
  return nested.flat();
}

test('no refusal headline is a single-quoted string with a ${placeholder} in it', async () => {
  const offenders = [];
  for (const file of await typescriptSources(path.join(root, 'apps/vscode/src'))) {
    const text = codeOnly(await readFile(file, 'utf8'));
    for (const match of text.matchAll(/headline:\s*'[^'\n]*\$\{[^'\n]*'/g)) {
      offenders.push(`${path.relative(root, file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], 'these headlines print the placeholder literally');
});

test('the self-approval retry reports the retry\'s own failure', async () => {
  const actions = codeOnly(await source('apps/vscode/src/actions.ts'));
  assert.doesNotMatch(actions, /catch \(retryError\) \{\s*showRefusal\(error\)/,
    'the retry failed for its own reason; showing the first refusal again sends people in a loop');
});

test('archiving a Story is not offered as a second "Cancel" button', async () => {
  const extension = codeOnly(await source('apps/vscode/src/extension.ts'));
  const cancel = extension.slice(extension.indexOf("'singularityFlow.cancelWork': async () =>"),
    extension.indexOf("'singularityFlow.cancelWork': async () =>") + 2500);
  assert.match(cancel, /'Archive Story'\s*\);\s*if \(decision !== 'Archive Story'\) return;/);
  assert.doesNotMatch(cancel, /'Cancel and archive'\s*\)/, 'VS Code adds its own Cancel button beside it');
});

test('the approval form keeps decisions across a hidden tab but never the confirmation', async () => {
  const review = await source('apps/vscode/src/views/approval-review.ts');
  const script = review.slice(review.indexOf('const REVIEW_SCRIPT = `'), review.indexOf('`;', review.indexOf('const REVIEW_SCRIPT = `')));
  const remember = script.slice(script.indexOf('function remember()'), script.indexOf('const restored'));
  assert.match(remember, /api\.setState\(\{ decisions: saved \}\)/);
  assert.doesNotMatch(remember, /data-confirmation|data-self-approval/,
    'the typed confirmation and self-approval acknowledgement are made fresh every time');
  assert.match(script, /api\.getState\(\)/, 'a re-rendered or re-shown form restores the reviewer\'s decisions');
  assert.doesNotMatch(review, /data-confirmation[^>]*placeholder=/,
    'a placeholder holding the expected value makes the field look already filled in');
});

test('a disabled Record approval button says what is still needed', async () => {
  const review = await source('apps/vscode/src/views/approval-review.ts');
  assert.match(review, /<p class="approval-progress muted" data-progress aria-live="polite"><\/p>\s*<button type="submit" disabled>Record approval<\/button>/);
  assert.match(review, /'Still needed: ' \+ missing\.join\(', '\) \+ '\.'/);
  assert.match(review, /missing\.push\('the typed confirmation'\)/);
});

test('a refusal plan is headed by what the person was doing, not a generic sentence', async () => {
  const { refusalEnvelope } = await import('../src/refusal-remediation.mjs');
  const { SingularityFlowError } = await import('../src/util.mjs');
  const { refusalFor } = await import('../apps/vscode/src/views/refusal.ts');
  const envelope = refusalEnvelope(new SingularityFlowError('Story SF-7 is not active.', { code: 'WORK_NOT_ACTIVE' }),
    ['cancel', 'SF-7', '--json']);
  assert.equal(envelope.resultType, 'sflow-refusal-plan');
  assert.equal(refusalFor({ result: envelope, message: envelope.error.message }, { headline: 'Could not cancel SF-7' }).view.headline,
    'Could not cancel SF-7');
  assert.equal(refusalFor({ result: envelope, message: envelope.error.message }).view.headline,
    'Couldn’t complete this — here’s what you can do');
});
