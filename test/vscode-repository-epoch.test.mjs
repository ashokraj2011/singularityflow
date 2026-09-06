import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { codeOnly } from './source-text.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (...parts) => path.join(root, 'apps', 'vscode', 'src', ...parts);
const { RepositoryEpochGuard } = await import(source('repository-epoch.ts'));

test('repository epochs reject A-to-B-to-A late answers even when identity text is the same', () => {
  const guard = new RepositoryEpochGuard('/repo/A');
  const firstA = guard.capture();
  assert.equal(guard.isCurrent(firstA), true);

  guard.moved('/repo/B');
  const b = guard.capture();
  assert.equal(guard.isCurrent(firstA), false);
  assert.equal(guard.isCurrent(b), true);

  guard.moved('/repo/A');
  const secondA = guard.capture();
  assert.equal(guard.isCurrent(firstA), false,
    'a late answer from the first A binding cannot match the same path after returning from B');
  assert.equal(guard.isCurrent(b), false);
  assert.equal(guard.isCurrent(secondA), true);

  guard.moved('/repo/A');
  assert.equal(guard.isCurrent(secondA), false,
    'a same-path workspace rebind also invalidates work launched under the previous context');
});

test('every repository-bound auxiliary and status publication carries an epoch guard', async () => {
  const extension = codeOnly(await readFile(source('extension.ts'), 'utf8'));

  const logs = extension.slice(
    extension.indexOf('const refreshWorkspaceLogsTree'),
    extension.indexOf('const REPOSITORY_REFRESH_DEBOUNCE_MS')
  );
  assert.match(logs, /const scope = repositoryEpoch\.capture\(\)/);
  assert.match(logs, /await client\.run[\s\S]*?if \(!repositoryEpoch\.isCurrent\(scope\)\) return;[\s\S]*?logsTree\.replace/);
  assert.match(logs, /catch \(error\) \{\s*if \(!repositoryEpoch\.isCurrent\(scope\)\) return;/,
    'a late error from the prior repository can still replace the current logs tree');

  const readiness = extension.slice(
    extension.indexOf('const refreshReadiness'),
    extension.indexOf('context.subscriptions.push(new ConfigurationValidator')
  );
  assert.match(readiness, /const scope = repositoryEpoch\.capture\(\)/);
  assert.ok((readiness.match(/repositoryEpoch\.isCurrent\(scope\)/g) ?? []).length >= 3,
    'both readiness reads and their error publication need repository guards');

  assert.match(extension, /repositoryEpoch\.moved\(canonicalTarget\);\s*repository = canonicalTarget/);
  assert.match(extension, /const renderedScope = repositoryEpoch\.capture\(\)/);
  assert.match(extension, /statusChromeFor\(renderedFor, renderedScope\)/);
  assert.match(extension, /statusChromeFor\(null, renderedScope\)/);
  assert.match(extension, /!repositoryEpoch\.isCurrent\(renderedScope\) \|\| statusWorkId !== renderedFor/,
    'equal Work IDs in two repositories can still accept the first repository status result');
  assert.match(extension, /statusWorkId !== null\) return/);
  assert.match(extension, /!home \|\| !repositoryEpoch\.isCurrent\(renderedScope\) \|\| statusWorkId !== null/,
    'the no-active-Story status path can still accept a prior repository home result');
});
