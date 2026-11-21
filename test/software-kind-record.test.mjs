/**
 * The kind of each app or service, recorded once on a person's word (step intents spec §12.1): SFlow shows what it
 * sees in one line with a short confirmation code; the confirmed kinds are kept for the capability on this clone and
 * nothing asks again; a person may name another kind first; what changed since the line was shown is never recorded.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { confirmSoftwareKinds, effectiveSoftwareKinds, kindQuestion, kindsTouched, parseKindOverrides, readSoftwareKindRecord, softwareKindsView } from '../src/software-kind-record.mjs';
import { ARA_SURFACES, normalizeApplicationReview, reviewApplicability } from '../src/application-review-contract.mjs';

async function checkout(t, files) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-kind-record-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git('init', '-q');
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(root, file), text);
  git('add', '.'); git('-c', 'user.name=Kind Tester', '-c', 'user.email=kind@example.invalid', 'commit', '-qm', 'fixture');
  return root;
}

test('the first time, one line says what SFlow sees; its confirmation records the kind and nothing asks again', async (t) => {
  const root = await checkout(t, { 'package.json': JSON.stringify({ name: 'grapher', private: true, dependencies: { react: '18.0.0' } }) });
  const first = await softwareKindsView(root);
  assert.equal(first.capability, 'repository-root');
  assert.deepEqual(first.projects.map((project) => [project.id, project.kind, project.confirmed]), [['repository-root', 'web', false]]);
  assert.equal(first.question, 'SFlow sees this repository as a web app (react in package.json). Right?');
  assert.equal(first.confirm.command, `singularity-flow capability kind --confirm ${first.digest}`);
  // No: one ready command per other kind, nothing to fill in.
  assert.deepEqual(first.correct.choices.map((choice) => choice.kind), ['mobile', 'backend', 'job', 'cli', 'artifact', 'library']);
  assert.equal(first.correct.choices[1].command, 'singularity-flow capability kind --kind repository-root=backend --json');
  assert.equal(await readSoftwareKindRecord(root, 'repository-root'), null);
  await assert.rejects(confirmSoftwareKinds(root, { digest: `sha256:${'0'.repeat(64)}` }), { code: 'SOFTWARE_KIND_CHANGED' });
  const recorded = await confirmSoftwareKinds(root, { digest: first.digest });
  assert.equal(recorded.recorded, true);
  const again = await softwareKindsView(root);
  assert.deepEqual([again.confirmed, again.question, again.confirm], [true, null, undefined]);
  assert.equal((await readSoftwareKindRecord(root, 'repository-root')).projects[0].kind, 'web');
});

test('a person may name another kind before confirming; the recorded kind wins over what the files say later', async (t) => {
  const root = await checkout(t, { 'package.json': JSON.stringify({ name: 'grapher', private: true, dependencies: { react: '18.0.0' } }) });
  const corrected = await softwareKindsView(root, { overrides: ['repository-root=backend'] });
  assert.equal(corrected.projects[0].kind, 'backend');
  assert.equal(corrected.confirm.command, `singularity-flow capability kind --kind repository-root=backend --confirm ${corrected.digest}`);
  await confirmSoftwareKinds(root, { digest: corrected.digest, overrides: ['repository-root=backend'] });
  const view = await softwareKindsView(root);
  assert.deepEqual([view.projects[0].kind, view.projects[0].confirmed, view.projects[0].detectedNow], ['backend', true, 'web']);
  assert.throws(() => parseKindOverrides(['repository-root=server'], view.projects), { code: 'SOFTWARE_KIND_USAGE' });
  assert.throws(() => parseKindOverrides(['orders=web'], view.projects), { code: 'SOFTWARE_KIND_PROJECT_UNKNOWN' });
});

test('a Story touches the kinds of the projects its changed paths are in; job and mobile are review surfaces', () => {
  const kinds = effectiveSoftwareKinds('shop', { projects: [
    { id: 'web', root: 'apps/web', kind: 'web', confidence: 'certain', signals: ['react in apps/web/package.json'], also: [] },
    { id: 'api', root: 'services/api', kind: 'backend', confidence: 'certain', signals: ['spring-boot-starter-web in services/api/pom.xml'], also: [] }] });
  assert.deepEqual(kindsTouched(kinds, ['services/api/src/Orders.java', 'README.md']).map((project) => project.id), ['api']);
  assert.match(kindQuestion(kinds), /^SFlow sees apps\/web as a web app \(react in apps\/web\/package\.json\)\. SFlow sees services\/api as a backend \(API or service\)/u);
  assert.ok(ARA_SURFACES.includes('job') && ARA_SURFACES.includes('mobile'));
  assert.equal(normalizeApplicationReview({ surface: 'job' }).surface, 'job');
  // A mobile app has screens: its visual check stays a person's; a job has none.
  assert.equal(reviewApplicability({ surface: 'mobile' }, []).dimensions.visual, 'pending');
  assert.equal(reviewApplicability({ surface: 'job' }, []).dimensions.visual, 'not-applicable');
});
