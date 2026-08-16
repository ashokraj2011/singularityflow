/**
 * One home, and one contract for reading it. `[UXH:D1]` `[DHR:REQ-082]`
 *
 * `sflow home` became a gateway operation and started answering with an `sflow-result` v2 envelope.
 * `developer-home.ts` was still reading `context.workspace.id`, `choices[]` and `subjectRevision` —
 * the old `developer-home` contract — so "Talk to SFlow" opened and rendered its error state. Every
 * test stayed green, because they exercise the planner against fixtures of the shape the planner
 * used to produce.
 *
 * That is the failure this file exists for: not "does the planner work", but "does what the command
 * emits match what the surface reads". A producer and its consumer can each be correct and still
 * disagree, and no test that mocks one of them can see it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeOnly } from './source-text.mjs';
import { EFFECT_KEYS } from '../src/gateway/result.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = codeOnly(await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8'));

/** The fields the retired `developer-home` contract had and `sflow-result` v2 does not. */
const RETIRED_FIELDS = Object.freeze(['subjectRevision', 'choices', 'briefing']);

test('the entry point opens the one home rather than a second one', () => {
  // `[UXH:C7]`: My Work everywhere; "Talk to SFlow" is an entry-point label.
  assert.match(extension,
    /'singularityFlow\.openDeveloperHome':[^;]*executeCommand\('singularityFlow\.myWork'\)/s);
  assert.ok(!/DeveloperHomePanel/.test(extension),
    'the extension still opens the panel that cannot read the current contract');

  // And the panel is gone rather than left unreachable: 245 lines that can only render an error
  // are not a fallback, they are the next reader's false lead.
  assert.equal(existsSync(path.join(root, 'apps', 'vscode', 'src', 'views', 'developer-home.ts')), false);
});

test('no surface reads a field the home command stopped emitting', async () => {
  /**
   * The guard for the class, not for the instance. A view reading `home.subjectRevision` compiles,
   * passes review and throws at runtime inside a `try`, which is the combination that let this one
   * ship.
   */
  const offenders = [];
  for (const file of ['extension.ts', 'views/result-card-model.ts', 'views/result-card-page.ts',
    'views/sidebar.ts', 'views/tree-model.ts']) {
    const source = codeOnly(await readFile(path.join(root, 'apps', 'vscode', 'src', file), 'utf8'));
    for (const field of RETIRED_FIELDS) {
      if (new RegExp(`\\bhome\\.${field}\\b|\\bhome\\?\\.${field}\\b`).test(source)) {
        offenders.push(`${file}: home.${field}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `these read the retired developer-home contract:\n  ${offenders.join('\n  ')}`);
});

test('the v2 envelope is what a home consumer must be written against', () => {
  /**
   * Stated here so the shape is in one place a reader can check against a surface. `next[]` is
   * where the choices went, and each entry is a signed handle the executor re-resolves before
   * dispatch — which is what `developer-home.ts` hand-wrote a `revalidate()` for.
   */
  assert.ok(EFFECT_KEYS.length >= 4, 'the envelope declares its effects');
  for (const field of RETIRED_FIELDS) {
    assert.ok(!EFFECT_KEYS.includes(field), `${field} is not part of v2`);
  }
});
