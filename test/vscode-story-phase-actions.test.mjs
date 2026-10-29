import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = pathToFileURL(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'apps', 'vscode', 'src', 'decisions.ts'));

// VS Code published with no --authored (recorded as model-assisted legacy provenance) and offered
// Prepare while the phase waited for approval, which withdrew the submission locally (2026-10-29).
test('VS Code publishes with the authorship the person chose and refuses Prepare while a phase waits', async () => {
  const { PUBLISH_AUTHORSHIP, prepareRefusal, publishArgv } = await import(source.href);
  assert.deepEqual(PUBLISH_AUTHORSHIP.map((entry) => [entry.authored, entry.channel]),
    [['human', 'manual-in-place'], ['governed-agent', 'copilot-host']]);
  assert.deepEqual(publishArgv('intake', PUBLISH_AUTHORSHIP[0]),
    ['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place']);
  assert.match(prepareRefusal('intake', 'awaiting_approval'), /waiting for approval; preparing it again would withdraw its submission/u);
  assert.match(prepareRefusal('intake', 'approved'), /already approved/u);
  assert.equal(prepareRefusal('intake', 'in_progress'), null);
  assert.equal(prepareRefusal('intake', 'not_started'), null);
});
