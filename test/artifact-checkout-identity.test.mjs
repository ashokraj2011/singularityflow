import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { artifactSnapshotCheckoutMatches, artifactTextCheckoutMatches, authoredArtifactText, inspectManagedArtifactMetadata } from '../src/artifact-review-read.mjs';

test('artifact identity accepts only exact bytes or uniform LF/CRLF checkout text', () => {
  const lf = '# Evidence\n\nObservable result.\n';
  const crlf = lf.replaceAll('\n', '\r\n');
  assert.equal(artifactTextCheckoutMatches(lf, lf), true);
  assert.equal(artifactTextCheckoutMatches(lf, crlf), true);
  assert.equal(artifactTextCheckoutMatches(crlf, lf), true);
  for (const changed of [
    lf.replace('result', 'changed'), '\uFEFF' + lf, lf.trimEnd(), lf + '\n',
    lf.replace('result.', 'result. '), lf.replace('\n', '\r\n'), lf.replace('\n', '\r')
  ]) assert.equal(artifactTextCheckoutMatches(lf, changed), false, JSON.stringify(changed));
});

test('approved source/test snapshots retain raw hashes while accepting only uniform UTF-8 checkout endings', () => {
  const snapshot = bytes => ({ exists: true, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  const lf = Buffer.from('// approved function\nexport const value = 1;\n');
  const crlf = Buffer.from(lf.toString().replaceAll('\n', '\r\n'));
  const approved = snapshot(lf);
  const retained = structuredClone(approved);
  assert.equal(artifactSnapshotCheckoutMatches(approved, crlf), true);
  assert.equal(artifactSnapshotCheckoutMatches(snapshot(crlf), lf), true);
  assert.deepEqual(approved, retained, 'neither raw hash nor approved size may be rewritten');
  for (const bytes of [
    Buffer.from(lf.toString().replace('1', '2')), Buffer.from(lf.toString().trimEnd()),
    Buffer.from(lf.toString().replace('1;', '1; ')), Buffer.from(lf.toString().replace('\n', '\r\n')),
    Buffer.from(lf.toString().replace('\n', '\r')), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), crlf]),
    Buffer.concat([lf, Buffer.from([0, 0xff])])
  ]) assert.equal(artifactSnapshotCheckoutMatches(approved, bytes), false, bytes.toString('hex'));
  assert.equal(artifactSnapshotCheckoutMatches({ ...approved, size: 1 }, crlf), false);
  assert.equal(artifactSnapshotCheckoutMatches({ ...approved, exists: false }, crlf), false);
  for (const binary of [Buffer.from([0, 10, 255]), Buffer.from([0xef, 0xbb, 0xbf, 10])]) {
    assert.equal(artifactSnapshotCheckoutMatches(snapshot(binary), binary), true, 'exact binary bytes remain exact');
    assert.equal(artifactSnapshotCheckoutMatches(snapshot(binary), Buffer.from(binary.toString().replaceAll('\n', '\r\n'))), false);
  }
});

test('managed envelope recognition is portable without rewriting author-owned text', () => {
  const body = '# Evidence\r\n\r\nThe author owns these exact bytes.\r\n';
  const text = '<!-- singularity-flow:metadata\r\n{}\r\n-->\r\n\r\n' + body;
  assert.equal(inspectManagedArtifactMetadata(text).status, 'valid');
  assert.equal(authoredArtifactText(text), body);
  assert.equal(inspectManagedArtifactMetadata(text + '\r\n<!-- singularity-flow:metadata\r\n{}\r\n-->').status,
    'duplicate-or-misplaced');
});
