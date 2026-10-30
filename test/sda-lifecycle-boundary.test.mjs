/**
 * SDA M4 boundary: lifecycle persistence goes through the lifecycle authority adapter only.
 *
 * Every lifecycle transition runs the publication unit of work through the adapter, and every
 * observation of a lifecycle branch on the remote reads through it, so another authority (ADR 0018
 * options B or C) replaces one module rather than its callers. The remaining direct observations are
 * not lifecycle subjects; each is listed with its reason, and a new one fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const ADAPTER = 'sda/story-branch-authority.mjs';

/** Direct remote-branch observations that are not lifecycle authority, with their reasons. */
const OTHER_OBSERVATIONS = Object.freeze({
  'wca-git-drafts.mjs': { count: 1, reason: 'shared configuration drafts on sflow/drafts/<workspace>, not a lifecycle subject' },
  'sgos/candidate-lifecycle.mjs': { count: 2, reason: 'SGOS Candidate publication onto an operator-chosen branch, under its own confirmed plan' },
  'sgos/authority-git-transport.mjs': { count: 1, reason: 'the SGOS authority store branch, an operational authority' }
});

/** The workflow families whose transitions publish lifecycle state (SDA-AC-010). */
const PUBLISHING_FAMILIES = Object.freeze({
  story: 'story-publication-service.mjs',
  initiative: 'initiative-state.mjs',
  'initiative seed': 'initiative-repositories.mjs',
  goal: 'governed-goals.mjs',
  'ad hoc': 'adhoc/landing.mjs',
  'local identity': 'local-identity.mjs'
});

async function sources(directory = SRC) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(full));
    else if (entry.name.endsWith('.mjs')) files.push(full);
  }
  return files;
}

async function occurrences(pattern) {
  const found = {};
  for (const file of await sources()) {
    const count = ((await readFile(file, 'utf8')).match(pattern) ?? []).length;
    if (count) found[path.relative(SRC, file).split(path.sep).join('/')] = count;
  }
  return found;
}

test('only the lifecycle authority adapter runs the publication unit of work (SDA M4)', async () => {
  assert.deepEqual(await occurrences(/new GitPublicationUnitOfWork\(/gu), { [ADAPTER]: 1 });
  assert.deepEqual(await occurrences(/\bpublishLifecycleChange\b/gu), {});
});

test('a lifecycle branch is observed on the remote only through the adapter; the other observations are listed', async () => {
  const found = await occurrences(/(?<!function )\bexactRemoteBranchObservationAsync\(/gu);
  assert.equal(found[ADAPTER], 1);
  delete found[ADAPTER];
  assert.deepEqual(found, Object.fromEntries(Object.entries(OTHER_OBSERVATIONS).map(([file, { count }]) => [file, count])),
    'a new direct observation is lifecycle authority (read it through lifecycleAuthority(root).observe) or needs a listed reason');
});

test('every publishing workflow family reaches lifecycle authority through the adapter', async () => {
  for (const [family, module] of Object.entries(PUBLISHING_FAMILIES)) {
    const source = await readFile(path.join(SRC, module), 'utf8');
    assert.match(source, /import \{ lifecycleAuthority \} from ['"](?:\.\.?\/)+sda\/story-branch-authority\.mjs['"]/u, family);
    assert.match(source, /lifecycleAuthority\([^)]*\)\.publish\(\{/u, `${family} publishes through the adapter`);
  }
});
